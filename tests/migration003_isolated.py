#!/usr/bin/env python3
"""Opt-in real PostgreSQL tests. Only a NEW network-disabled local container.

No database URL, backup, production credential, existing container or host port
is accepted. Run: python3 tests/migration003_isolated.py --run-isolated
Requires Docker's local socket, a pre-pulled postgres:17 image, and Node 20+.
"""
import argparse
import json
import os
from pathlib import Path
import select
import subprocess
import time
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[1]
DB = 'grocery_m003_add_items'
USER = '11111111-1111-4111-8111-111111111111'
OTHER = '22222222-2222-4222-8222-222222222222'
LIST = '33333333-3333-4333-8333-333333333333'
SECOND_LIST = '44444444-4444-4444-8444-444444444444'


def literal(value):
    return "'" + str(value).replace("'", "''") + "'"


def item(item_id=-1, **overrides):
    return dict(id=item_id, item_name='Milk', quantity=1, purchased=False) | overrides


def member(user=USER):
    return f"SET ROLE authenticated; SET request.jwt.claim.sub = {literal(user)};"


def call(request, payload, operation='add_items', list_id=LIST):
    encoded = 'NULL' if payload is None else literal(json.dumps(payload)) + '::jsonb'
    return (f"SELECT public.mutate_grocery_once({literal(request)}, {literal(list_id)}, "
            f"{literal(operation)}, {encoded});")


class IsolatedDatabase:
    def __init__(self):
        self.name = 'grocery-m003-' + uuid.uuid4().hex
        # Retain registry/proxy configuration, but never inherited DB/endpoints.
        self.env = {k: v for k, v in os.environ.items()
                    if not k.startswith('PG') and k not in {
                        'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS',
                        'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH'}}
        self.docker = ['docker', '--host=unix:///var/run/docker.sock']
        self.started = False

    def command(self, args, **kwargs):
        return subprocess.run(args, env=self.env, text=True, capture_output=True,
                              timeout=60, **kwargs)

    def checked(self, args, **kwargs):
        result = self.command(args, **kwargs)
        if result.returncode:
            raise RuntimeError(result.stderr or result.stdout)
        return result.stdout.strip()

    def psql(self):
        return self.docker + ['exec', '-i', self.name, 'psql', '-XqAt',
                             '-v', 'ON_ERROR_STOP=1', '-h', '/var/run/postgresql',
                             '-U', 'postgres', '-d', DB]

    def sql(self, source):
        return self.checked(self.psql(), input=source)

    def start(self):
        self.checked(self.docker + ['info', '--format', '{{.ServerVersion}}'])
        self.checked(self.docker + ['run', '-d', '--pull=never', '--name', self.name,
                     '--network=none', '--tmpfs', '/var/lib/postgresql/data',
                     '--tmpfs', '/var/run/postgresql',
                     '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '-e', 'POSTGRES_DB=' + DB,
                     '-e', 'POSTGRES_INITDB_ARGS=--encoding=UTF8 --locale=C',
                     'postgres:17', '-c', 'listen_addresses='])
        self.started = True
        details = json.loads(self.checked(self.docker + ['inspect', self.name]))[0]
        if (details['HostConfig']['NetworkMode'] != 'none'
                or details['HostConfig'].get('PortBindings')
                or details['HostConfig'].get('Binds')
                or any(m['Type'] == 'bind' for m in details['Mounts'])):
            raise RuntimeError('Isolation preflight failed')
        deadline = time.monotonic() + 30
        while self.command(self.psql(), input='SELECT 1;').returncode:
            if time.monotonic() > deadline:
                raise RuntimeError('Isolated PostgreSQL did not become ready')
            time.sleep(0.1)
        if self.sql('SHOW listen_addresses;') or self.sql('SHOW server_encoding;') != 'UTF8':
            raise RuntimeError('Database isolation/encoding preflight failed')
        print('Isolated PostgreSQL:', self.sql('SHOW server_version;'), flush=True)
        self.sql((ROOT / 'tests/fixtures/migration003_baseline.sql').read_text())
        self.legacy_access = self.sql("SELECT relname, relacl::text FROM pg_class "
                                      "WHERE relname IN ('grocery_items','grocery_list_members') ORDER BY 1;")
        self.sql((ROOT / 'database/proposals/003_replay_safe_mutations.name_validation_v2.sql').read_text())

    def stop(self):
        if self.started:
            # This random name is owned by this invocation only; test data is synthetic.
            self.checked(self.docker + ['rm', '-f', '-v', self.name])
            self.started = False

    def session(self, source):
        process = subprocess.Popen(self.psql(), env=self.env, text=True,
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, bufsize=1)
        process.stdin.write(source + '\n')
        process.stdin.flush()
        return process


class AddItemsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.db = IsolatedDatabase()
        cls.addClassCleanup(cls.db.stop)
        cls.db.start()

    def setUp(self):
        self.db.sql(f"""TRUNCATE public.grocery_items, public.grocery_mutation_requests,
          public.grocery_list_members, public.grocery_list_invites, auth.users CASCADE;
          INSERT INTO auth.users VALUES ('{USER}'), ('{OTHER}');
          INSERT INTO public.grocery_list_members VALUES ('{LIST}', '{USER}'),
            ('{SECOND_LIST}', '{USER}');""")
        self.req = str(uuid.uuid4())

    def rpc(self, payload, request=None, **kwargs):
        return json.loads(self.db.sql(member() + call(request or self.req, payload, **kwargs)))

    def denied(self, source, message):
        result = self.db.command(self.db.psql(), input=source)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(message, result.stderr)

    def counts(self, items, requests):
        self.assertEqual(self.db.sql('SELECT count(*) FROM public.grocery_items; '
                                    'SELECT count(*) FROM public.grocery_mutation_requests;'),
                         f'{items}\n{requests}')

    def test_single_batch_snapshots_replay_and_no_sequence_use(self):
        sequence = self.db.sql('SELECT last_value, is_called FROM public.grocery_items_id_seq;')
        for entries in [[item()], [item(-2, item_name=' 牛乳 ', quantity=999, purchased=True),
                                   item(-3, item_name="O'Brien's milk")]]:
            request = str(uuid.uuid4())
            payload = {'items': entries}
            answer = self.rpc(payload, request)
            self.assertEqual(answer['status'], 'ok')
            self.assertEqual(len(answer['items']), len(entries))
            for row, entry in zip(answer['items'], entries):
                self.assertEqual(row, entry | {'id': str(entry['id']), 'list_id': LIST,
                                 'owner_id': USER, 'revision': row['revision'],
                                 'created_at': row['created_at']})
                uuid.UUID(row['revision'])
                self.assertTrue(row['created_at'])
                actual = json.loads(self.db.sql("SELECT to_jsonb(i) || jsonb_build_object('id', id::text) "
                                    f"FROM public.grocery_items i WHERE id={entry['id']};"))
                self.assertEqual(row, actual)
            self.assertEqual(self.rpc(payload, request), answer)
            stored = json.loads(self.db.sql('SELECT result FROM public.grocery_mutation_requests '
                                           f'WHERE request_id={literal(request)};'))
            self.assertEqual(stored, answer)
        self.counts(3, 2)
        self.assertEqual(sequence, self.db.sql('SELECT last_value, is_called FROM public.grocery_items_id_seq;'))

    def test_changed_payload_list_operation_and_order_rejected(self):
        payload = {'items': [item(), item(-2)]}
        original = self.rpc(payload)
        variants = [{'items': [item(item_name='Bread'), item(-2)]},
                    {'items': [item(quantity=2), item(-2)]},
                    {'items': [item(purchased=True), item(-2)]},
                    {'items': [item(-3), item(-2)]},
                    {'items': list(reversed(payload['items']))},
                    {'items': payload['items'], 'ignored': True}]
        for changed in variants:
            self.denied(member() + call(self.req, changed), 'Request ID already used')
        for kwargs in [dict(operation='invite'), dict(list_id=SECOND_LIST)]:
            self.denied(member() + call(self.req, payload, **kwargs), 'Request ID already used')
        self.assertEqual(self.rpc(payload), original)
        self.counts(2, 1)

    def test_jsonb_key_order_and_integral_numbers_replay(self):
        original = self.rpc({'items': [item()]})
        self.assertEqual(self.rpc({'items': [dict(purchased=False, quantity=1.0,
                                                 item_name='Milk', id=-1.0)]}), original)
        answer = self.rpc({'items': [item(-2.0, quantity=999.0)]}, str(uuid.uuid4()))
        self.assertEqual(answer['items'][0]['id'], '-2')

    def test_lost_response_retry_after_edit_delete_and_id_reuse(self):
        payload = {'items': [item(), item(-2)]}
        # Commit in a separate connection and deliberately discard its response.
        self.db.sql(member() + call(self.req, payload))
        stored = json.loads(self.db.sql('SELECT result FROM public.grocery_mutation_requests;'))
        self.db.sql(member() + "UPDATE public.grocery_items SET item_name='Edited' WHERE id=-1; "
                    "DELETE FROM public.grocery_items WHERE id=-2;")
        self.assertEqual(self.rpc(payload), stored)
        self.db.sql(member() + f"DELETE FROM public.grocery_items; INSERT INTO public.grocery_items"
                    f"(id,item_name,list_id,owner_id) VALUES(-1,'Replacement','{LIST}','{USER}');")
        self.assertEqual(self.rpc(payload), stored)
        self.assertEqual(self.db.sql('SELECT item_name FROM public.grocery_items;'), 'Replacement')
        self.counts(1, 1)

    def test_atomic_malformed_batches_and_complete_shape_validation(self):
        bad_rows = [None, 1, 'Milk', [], True]
        for key in item():
            row = item(-2)
            del row[key]
            bad_rows.append(row)
        for key in ['owner_id', 'list_id', 'revision', 'created_at', 'extra']:
            bad_rows.append(item(-2, **{key: OTHER}))
        for key, values in {
            'id': [None, '-2', 0, 1, -1.5, -9007199254740992, True, {}, []],
            'quantity': [None, '1', 0, -1, 1000, 1.5, True, {}, []],
            'purchased': [None, 'false', 0, 1, {}, []],
        }.items():
            bad_rows.extend(item(-2, **{key: value}) for value in values)
        for row in bad_rows:
            with self.subTest(row=row):
                self.denied(member() + call(self.req, {'items': [item(), row]}), 'ERROR:')
                self.counts(0, 0)
        for payload in [None, [], 'items', {}, {'items': None}, {'items': {}},
                        {'items': [item()], 'owner_id': USER}]:
            with self.subTest(payload=payload):
                self.denied(member() + call(self.req, payload), 'ERROR:')
                self.counts(0, 0)
        # A rejected reservation is rolled back, so the same request can be corrected.
        self.assertEqual(self.rpc({'items': [item()]})['status'], 'ok')

    def test_duplicate_and_global_item_id_collision_are_atomic(self):
        self.denied(member() + call(self.req, {'items': [item(), item()]}), 'Duplicate add item ID')
        self.counts(0, 0)
        # Collision with legacy data owned by someone else on an inaccessible list.
        self.db.sql(f"INSERT INTO public.grocery_items(id,item_name,list_id,owner_id) "
                    f"VALUES(-1,'Legacy','{uuid.uuid4()}','{OTHER}');")
        self.denied(member() + call(self.req, {'items': [item(-2), item()]}), 'duplicate key')
        self.counts(1, 0)
        self.assertEqual(self.db.sql('SELECT item_name FROM public.grocery_items;'), 'Legacy')

    def test_ledger_result_failure_rolls_back_insert_and_reservation(self):
        # Force failure AFTER insertion at the final ledger write, not validation.
        self.db.sql("""CREATE FUNCTION public.test_reject_result() RETURNS trigger
          LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic ledger failure'; END $$;
          CREATE TRIGGER test_reject_result BEFORE UPDATE ON public.grocery_mutation_requests
          FOR EACH ROW EXECUTE FUNCTION public.test_reject_result();""")
        try:
            self.denied(member() + call(self.req, {'items': [item(), item(-2)]}),
                        'Synthetic ledger failure')
            self.counts(0, 0)
        finally:
            self.db.sql('DROP TRIGGER test_reject_result ON public.grocery_mutation_requests; '
                        'DROP FUNCTION public.test_reject_result();')
        self.assertEqual(self.rpc({'items': [item()]})['status'], 'ok')

    def test_batch_limits_and_negative_safe_id_boundary(self):
        for count in [0, 201]:
            self.denied(member() + call(self.req, {'items': [item(-i-1) for i in range(count)]}),
                        'Add batch must contain 1 to 200 items')
            self.counts(0, 0)
        payload = {'items': [item(-9007199254740991)] + [item(-i) for i in range(1, 200)]}
        original = self.rpc(payload)
        self.assertEqual(len(original['items']), 200)
        self.assertEqual(self.rpc(payload), original)
        self.counts(200, 1)

    def test_all_83_canonical_name_cases_on_add(self):
        cases = json.loads(subprocess.check_output(
            ['node', str(ROOT / 'tests/migration003_name_validation.test.cjs'), '--emit-cases'], text=True))
        accepted = 0
        for index, case in enumerate(cases):
            with self.subTest(name=case['label']):
                request = str(uuid.uuid4())
                row = item(-index-1, item_name=case.get('name'))
                if case['missing']:
                    del row['item_name']
                payload = {'items': [row]}
                if case['accepted']:
                    answer = self.rpc(payload, request)
                    self.assertEqual(answer['items'][0]['item_name'], case['name'])
                    self.assertEqual(self.rpc(payload, request), answer)
                    accepted += 1
                else:
                    self.denied(member() + call(request, payload), 'Invalid item values')
                self.counts(accepted, accepted)
        self.assertEqual((len(cases), accepted), (83, 41))

    def test_postgres_unrepresentable_names_rejected(self):
        for name in ['\0', '\ud800', '\udc00']:
            self.denied(member() + call(self.req, {'items': [item(item_name=name)]}), 'ERROR:')
            self.counts(0, 0)

    def test_auth_membership_revocation_and_private_ledger(self):
        payload = {'items': [item()]}
        self.denied('SET ROLE anon;' + call(self.req, payload), 'permission denied for function')
        self.denied(member('') + call(self.req, payload), 'Authentication required')
        self.denied(member(OTHER) + call(self.req, payload), 'You are not a member')
        self.counts(0, 0)
        self.rpc(payload)
        for statement in ['SELECT * FROM public.grocery_mutation_requests;',
                          'DELETE FROM public.grocery_mutation_requests;',
                          "UPDATE public.grocery_mutation_requests SET result='{}';",
                          'INSERT INTO public.grocery_mutation_requests DEFAULT VALUES;']:
            self.denied(member() + statement, 'permission denied')
        self.db.sql(f"DELETE FROM public.grocery_list_members WHERE list_id='{LIST}' AND user_id='{USER}';")
        for request in [self.req, str(uuid.uuid4())]:
            self.denied(member() + call(request, payload), 'You are not a member')
        self.counts(1, 1)

    def test_request_ids_scoped_to_authenticated_caller(self):
        payload = {'items': [item()]}
        self.rpc(payload)
        self.db.sql(f"INSERT INTO public.grocery_list_members VALUES ('{LIST}','{OTHER}');")
        result = json.loads(self.db.sql(member(OTHER) + call(self.req, {'items': [item(-2)]})))
        self.assertEqual(result['items'][0]['owner_id'], OTHER)
        self.counts(2, 2)

    def test_legacy_direct_writes_still_work(self):
        self.assertEqual(self.db.legacy_access, self.db.sql(
            "SELECT relname, relacl::text FROM pg_class WHERE relname IN "
            "('grocery_items','grocery_list_members') ORDER BY 1;"))
        self.db.sql(member() + f"INSERT INTO public.grocery_items(id,item_name,list_id,owner_id) "
                    f"VALUES(-1,'Direct','{LIST}','{USER}'); UPDATE public.grocery_items "
                    "SET quantity=2 WHERE id=-1;")
        self.counts(1, 0)
        self.db.sql(member() + 'DELETE FROM public.grocery_items;')
        self.counts(0, 0)

    def test_existing_edit_name_sql_suite(self):
        sql = subprocess.check_output(['node', str(ROOT / 'tests/migration003_name_validation.test.cjs'),
                                       '--emit-sql'], text=True)
        output = self.db.checked(self.db.psql() + ['-v', 'isolated_migration003_test=true'], input=sql)
        self.assertIsInstance(output, str)
        self.counts(0, 0)

    def test_existing_edit_delete_clear_and_replay(self):
        added = self.rpc({'items': [item(), item(-2, purchased=True), item(-3, purchased=True)]})
        first, second, third = added['items']
        edited = self.rpc(dict(id=first['id'], revision=first['revision'], item_name='Bread',
                               quantity=2, purchased=False), str(uuid.uuid4()), operation='edit')
        self.assertEqual(edited['status'], 'ok')
        stale = self.rpc(dict(id=first['id'], revision=first['revision']),
                         str(uuid.uuid4()), operation='delete')
        self.assertEqual(stale['status'], 'conflict')
        deleted = self.rpc(dict(id=first['id'], revision=edited['revision']),
                           str(uuid.uuid4()), operation='delete')
        self.assertEqual(deleted['status'], 'ok')
        target = dict(id=second['id'], revision=second['revision'])
        request = str(uuid.uuid4())
        cleared = self.rpc({'targets': [target, target]}, request, operation='clear_purchased')
        self.assertEqual(cleared['deleted_ids'], [second['id']])
        self.assertEqual(self.rpc({'targets': [target, target]}, request, operation='clear_purchased'), cleared)
        self.assertEqual(self.db.sql('SELECT id FROM public.grocery_items;'), third['id'])

    def start_session(self, source):
        process = self.db.session(source)
        def cleanup():
            if process.poll() is None:
                process.kill()
            process.communicate(timeout=10)
        self.addCleanup(cleanup)
        return process

    def line(self, process):
        ready, _, _ = select.select([process.stdout], [], [], 10)
        self.assertTrue(ready, 'Session did not reach its synchronization marker')
        line = process.stdout.readline().strip()
        self.assertTrue(line, 'Session exited before synchronization marker')
        return line

    def finish(self, process, command):
        output, error = process.communicate(command + '\n', timeout=10)
        self.assertEqual(process.returncode, 0, error)
        return output.strip()

    def wait_for_lock(self, name):
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if self.db.sql("SELECT count(*) FROM pg_stat_activity WHERE application_name=" +
                           literal(name) + " AND wait_event_type='Lock';") == '1':
                return
            time.sleep(0.05)
        self.fail('Expected database lock wait was not observed')

    def concurrent_retry(self, changed=False, rollback=False):
        payload = {'items': [item()]}
        first = self.start_session('BEGIN;' + member() + call(self.req, payload))
        original = json.loads(self.line(first))
        retry_payload = {'items': [item(item_name='Bread')]} if changed else payload
        second = self.start_session("SET application_name='m003_retry';" + member() +
                                    call(self.req, retry_payload))
        self.wait_for_lock('m003_retry')
        self.finish(first, 'ROLLBACK;' if rollback else 'COMMIT;')
        output, error = second.communicate(timeout=10)
        if changed:
            self.assertNotEqual(second.returncode, 0)
            self.assertIn('Request ID already used', error)
        else:
            self.assertEqual(second.returncode, 0, error)
            answer = json.loads(output)
            if rollback:
                self.assertNotEqual(answer['items'][0]['revision'], original['items'][0]['revision'])
            else:
                self.assertEqual(answer, original)
            self.assertEqual(self.rpc(payload), answer)
        self.counts(1, 1)

    def test_concurrent_identical_retry(self):
        self.concurrent_retry()

    def test_concurrent_changed_payload(self):
        self.concurrent_retry(changed=True)

    def test_concurrent_retry_after_first_transaction_aborts(self):
        self.concurrent_retry(rollback=True)

    def test_concurrent_different_requests_colliding_on_item_id(self):
        first = self.start_session('BEGIN;' + member() + call(self.req, {'items': [item()]}))
        self.line(first)
        second = self.start_session("SET application_name='m003_collision';" + member() +
                    call(str(uuid.uuid4()), {'items': [item(-2), item()]}))
        self.wait_for_lock('m003_collision')
        self.finish(first, 'COMMIT;')
        _, error = second.communicate(timeout=10)
        self.assertNotEqual(second.returncode, 0)
        self.assertIn('duplicate key', error)
        self.counts(1, 1)

    def test_concurrent_membership_revocation_waits_for_add(self):
        payload = {'items': [item()]}
        first = self.start_session('BEGIN;' + member() + call(self.req, payload))
        self.line(first)
        revoke = self.start_session("SET application_name='m003_revoke';"
                    f"DELETE FROM public.grocery_list_members WHERE list_id='{LIST}' AND user_id='{USER}';")
        self.wait_for_lock('m003_revoke')
        self.finish(first, 'COMMIT;')
        self.finish(revoke, '')
        self.denied(member() + call(self.req, payload), 'You are not a member')
        self.counts(1, 1)

    def test_concurrent_add_waits_for_revocation_then_denied(self):
        revoke = self.start_session(f"BEGIN; DELETE FROM public.grocery_list_members "
                    f"WHERE list_id='{LIST}' AND user_id='{USER}'; SELECT 'revoked';")
        self.assertEqual(self.line(revoke), 'revoked')
        add = self.start_session("SET application_name='m003_add';" + member() +
                                 call(self.req, {'items': [item()]}))
        self.wait_for_lock('m003_add')
        self.finish(revoke, 'COMMIT;')
        _, error = add.communicate(timeout=10)
        self.assertNotEqual(add.returncode, 0)
        self.assertIn('You are not a member', error)
        self.counts(0, 0)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run-isolated', action='store_true', required=True,
                        help='Authorize a new local synthetic test container only')
    parser.parse_args()
    unittest.main(argv=[__file__], verbosity=2)
