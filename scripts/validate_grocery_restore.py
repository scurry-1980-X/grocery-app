#!/usr/bin/env python3
"""Offline, fail-closed verification of the known pre-Migration-003 archive.

Python stdlib only. Never connects to a host database or removes a container.
Raw database output is captured in memory and never included in reports.
"""
import argparse
import collections
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import uuid

SQL_DIR = Path(__file__).resolve().parent / 'restore_validation'
TABLES = {
    'grocery_items': 2,
    'grocery_list_members': 1,
    'grocery_list_invites': 0,
    'grocery_list_create_requests': 0,
}
FUNCTIONS = {
    'create_grocery_list': '',
    'create_grocery_list_invite': 'uuid',
    'create_grocery_list_once': 'uuid',
    'redeem_grocery_list_invite': 'uuid',
}
POLICIES = {
    ('grocery_items', 'Members can add grocery items'),
    ('grocery_items', 'Members can delete grocery items'),
    ('grocery_items', 'Members can read grocery items'),
    ('grocery_items', 'Members can update grocery items'),
    ('grocery_list_members', 'Users can view their own list memberships'),
}
SEQ = 'grocery_items_id_seq'
KINDS = ('DEFAULT ACL', 'FK CONSTRAINT', 'TABLE DATA', 'SEQUENCE SET',
         'ROW SECURITY', 'PUBLICATION TABLE', 'SEQUENCE OWNED BY',
         'FUNCTION', 'TABLE', 'SEQUENCE', 'CONSTRAINT', 'POLICY', 'ACL',
         'INDEX', 'TRIGGER', 'COMMENT')


class ValidationError(Exception):
    pass


def require(condition, message):
    if not condition:
        raise ValidationError(message)


def parse_toc(text):
    entries = []
    for line in text.splitlines():
        if not line or line.startswith(';'):
            continue
        match = re.fullmatch(r'(\d+); \d+ \d+ (.+)', line)
        require(match is not None, 'Unrecognized archive table of contents')
        rest = match[2]
        kind = next((k for k in KINDS if rest.startswith(k + ' ')), None)
        if kind is None:
            # Non-public managed entries (types, extensions, event triggers, etc.).
            require(' public ' not in rest, 'Unexpected public object type')
            continue
        schema, name_owner = rest[len(kind) + 1:].split(' ', 1)
        name, owner = name_owner.rsplit(' ', 1)
        entries.append((kind, schema, name, owner, line))
    return entries


def select_toc(text):
    selected, exclusions = [], collections.Counter()
    seen = collections.Counter()
    expected = set()
    for table in TABLES:
        expected.update({('TABLE', table), ('TABLE DATA', table),
                         ('ROW SECURITY', table), ('ACL', 'TABLE ' + table),
                         ('CONSTRAINT', table + ' ' + table + '_pkey')})
    expected.update({('FK CONSTRAINT', 'grocery_items grocery_items_owner_id_fkey'),
                     ('FK CONSTRAINT', 'grocery_list_members grocery_list_members_user_id_fkey'),
                     ('FK CONSTRAINT', 'grocery_list_invites grocery_list_invites_created_by_fkey'),
                     ('FK CONSTRAINT', 'grocery_list_create_requests grocery_list_create_requests_user_id_fkey'),
                     ('SEQUENCE', SEQ), ('SEQUENCE SET', SEQ)})
    expected.update(('POLICY', t + ' ' + p) for t, p in POLICIES)
    expected.update(('FUNCTION', f + '(' + args + ')') for f, args in FUNCTIONS.items())
    expected.update({('ACL', 'FUNCTION create_grocery_list()'),
                     ('ACL', 'FUNCTION create_grocery_list_invite(target_list_id uuid)'),
                     ('ACL', 'FUNCTION create_grocery_list_once(request_id uuid)'),
                     ('ACL', 'FUNCTION redeem_grocery_list_invite(invite_token uuid)')})
    expected.update(('DEFAULT ACL', 'DEFAULT PRIVILEGES FOR ' + k)
                    for k in ('TABLES', 'FUNCTIONS', 'SEQUENCES'))
    for kind, schema, name, owner, line in parse_toc(text):
        if schema != 'public':
            exclusions['managed_or_shared_schema_entries'] += 1
            continue
        if (kind, name) == ('FUNCTION', 'rls_auto_enable()'):
            exclusions['supabase_rls_event_helper'] += 1
        elif (kind, name) == ('PUBLICATION TABLE', 'supabase_realtime grocery_items'):
            exclusions['supabase_realtime_membership'] += 1
        elif kind == 'DEFAULT ACL' and owner == 'supabase_admin':
            exclusions['supabase_admin_default_privileges'] += 1
        else:
            require(owner == 'postgres' and (kind, name) in expected,
                    'Unexpected public object or owner; review scope before changing allowlist')
            seen[(kind, name)] += 1
            selected.append(line)
    require(set(seen) == expected and all(v == 1 for v in seen.values()),
            'Required Grocery object missing or duplicated in archive')
    return '\n'.join(selected) + '\n', dict(exclusions)


def source_bodies(schema_sql):
    bodies = {}
    for name in FUNCTIONS:
        match = re.search(r'CREATE FUNCTION public\.' + name +
                          r'\([^;]*?\n    AS (\$\w*\$)(.*?)\1;', schema_sql, re.S)
        require(match is not None, 'Cannot verify archived function body')
        bodies[name] = match[2].replace('\r\n', '\n')
    return bodies


def sha256(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


class Runner:
    def __init__(self, context, output):
        self.context = context
        self.output = output
        self.container = 'grocery-verify-' + uuid.uuid4().hex[:12]
        self.started = False
        self.stage = 'prerequisites'
        self.report = {'scope': 'isolated pre-Migration-003 Grocery restore',
                       'status': 'FAIL', 'migration_approved': False,
                       'container': self.container, 'checks': [],
                       'limitations': [
                           'Auth users are ID-only stubs; no identities or sessions restored.',
                           'auth.uid is a local stub; JWT/GoTrue/PostgREST are not validated.',
                           'Realtime, managed schemas, event triggers and supabase_admin defaults excluded.',
                           'Public schema USAGE is local scaffolding; shared schema ACL not restored.',
                           'service_role has no BYPASSRLS; production role attributes not reproduced.',
                           'RPC tests are sequential; concurrent replay/race behavior not established.',
                           'PASS is restore evidence only, never approval for Migration 003 or 004.',
                       ]}

    def command(self, args, data=None, timeout=120):
        env = {k: v for k, v in os.environ.items()
               if not k.startswith(('PG', 'DOCKER_', 'COMPOSE_'))}
        try:
            result = subprocess.run(args, input=data, text=True, capture_output=True,
                                    env=env, timeout=timeout, check=False)
        except (OSError, subprocess.TimeoutExpired):
            raise ValidationError('Command unavailable or timed out; raw output withheld') from None
        require(result.returncode == 0, 'Command failed; raw output withheld to protect backup data')
        return result.stdout

    def docker(self, *args, **kwargs):
        return self.command(['docker', '--context', self.context, *args], **kwargs)

    def sql(self, text):
        return self.docker('exec', '-i', self.container, 'psql', '-X', '-qAt',
                           '-v', 'ON_ERROR_STOP=1', '-h', '/var/run/postgresql',
                           '-U', 'postgres', '-d', 'grocery_restore', data=text)

    def sql_file(self, name):
        return self.sql((SQL_DIR / name).read_text())

    def passed(self, name):
        self.report['checks'].append({'check': name, 'status': 'PASS'})
        print('PASS: ' + name, flush=True)

    def restore(self, section):
        self.docker('exec', self.container, 'pg_restore', '--exit-on-error',
                    '--single-transaction', '--section=' + section,
                    '--use-list=/tmp/grocery-selected.list',
                    '-h', '/var/run/postgresql', '-U', 'postgres',
                    '-d', 'grocery_restore', '/tmp/grocery-backup.dump')

    def run(self, backup):
        self.stage = 'local Docker and backup preflight'
        require(backup.is_file(), 'Backup is not a readable regular file')
        with backup.open('rb') as stream:
            require(stream.read(5) == b'PGDMP', 'Expected a custom-format pg_dump archive')
        original_hash = sha256(backup)
        self.report['backup_sha256'] = original_hash
        endpoint = json.loads(self.docker('context', 'inspect', self.context))[0]['Endpoints']['docker']['Host']
        require(endpoint.startswith('unix:///'), 'Only a local Unix-socket Docker context is allowed')
        image = json.loads(self.docker('image', 'inspect', 'postgres:17'))[0]['Id']
        self.report['image_id'] = image
        self.docker('run', '-d', '--pull=never', '--name', self.container,
                    '--label', 'grocery.restore-validation=true', '--network', 'none',
                    '--security-opt', 'no-new-privileges:true', '--pids-limit', '256',
                    '--memory', '512m', '--cpus', '1',
                    '-e', 'POSTGRES_HOST_AUTH_METHOD=trust',
                    '-e', 'POSTGRES_DB=grocery_restore', image,
                    'postgres', '-c', 'listen_addresses=', '-c', 'log_statement=none',
                    '-c', 'log_min_error_statement=panic', '-c', 'log_min_messages=panic')
        self.started = True
        info = json.loads(self.docker('inspect', self.container))[0]
        require(info['HostConfig']['NetworkMode'] == 'none'
                and not info['HostConfig']['PortBindings']
                and not info['HostConfig']['Binds']
                and not info['HostConfig']['Privileged'], 'Container isolation check failed')
        for _ in range(60):
            try:
                self.sql('SELECT 1;')
                break
            except ValidationError:
                time.sleep(0.5)
        else:
            raise ValidationError('Isolated PostgreSQL did not become ready')
        require(self.sql('SHOW listen_addresses;').strip() == '', 'TCP listening must be disabled')
        self.report['postgres_version'] = self.sql('SHOW server_version;').strip()
        require(self.report['postgres_version'].startswith('17.'), 'PostgreSQL 17 is required')
        self.passed('local container: network none, no published ports, Unix-socket database only')

        self.stage = 'archive allowlist and compatibility'
        self.docker('cp', str(backup), self.container + ':/tmp/grocery-backup.dump')
        copied_hash = self.docker('exec', self.container, 'sha256sum', '/tmp/grocery-backup.dump').split()[0]
        require(copied_hash == original_hash, 'Backup copy checksum differs')
        toc = self.docker('exec', self.container, 'pg_restore', '--list', '/tmp/grocery-backup.dump')
        selected, exclusions = select_toc(toc)
        self.report['excluded_entries'] = exclusions
        for label, pattern in [('dump_source_version', r'Dumped from database version: ([^\n]+)'),
                               ('dump_tool_version', r'Dumped by pg_dump version: ([^\n]+)')]:
            match = re.search(pattern, toc)
            self.report[label] = match[1] if match else 'unknown'
        # Only fixed allowlisted object names are written locally, never table data.
        toc_path = self.output / 'selected.list'
        toc_path.write_text(selected)
        self.docker('cp', str(toc_path), self.container + ':/tmp/grocery-selected.list')
        schema_sql = self.docker('exec', self.container, 'pg_restore', '--schema-only',
                                 '--use-list=/tmp/grocery-selected.list', '--file=-',
                                 '/tmp/grocery-backup.dump')
        bodies = source_bodies(schema_sql)
        self.passed('complete exact Grocery allowlist, ACLs retained, managed objects excluded')

        self.stage = 'local scaffolding and pre-data restore'
        self.sql_file('bootstrap.sql')
        self.restore('pre-data')
        self.passed('pre-data schema and four functions restored without ignored errors')
        self.stage = 'data restore and auth reference scaffolding'
        self.restore('data')
        self.sql_file('seed_auth.sql')
        self.passed('Grocery data restored; referenced auth IDs seeded only inside isolated database')
        self.stage = 'post-data constraints, RLS and grants restore'
        self.restore('post-data')
        self.passed('post-data keys, validated foreign keys, RLS, policies and ACLs restored')

        self.stage = 'data counts'
        for table, expected in TABLES.items():
            actual = int(self.sql('SELECT count(*) FROM public.' + table + ';'))
            require(actual == expected, table + ': expected ' + str(expected) + ' rows, found ' + str(actual))
            self.passed(table + ': ' + str(actual) + ' rows (expected ' + str(expected) + ')')

        self.stage = 'function body fidelity'
        actual_bodies = json.loads(self.sql("""
          SELECT json_object_agg(p.proname, p.prosrc) FROM pg_proc p
          JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public';
        """))
        require({k: v.replace('\r\n', '\n') for k, v in actual_bodies.items()} == bodies,
                'Restored function bodies differ from archive')
        self.passed('all four function bodies match the archive exactly')

        self.stage = 'catalog verification'
        checks = self.sql_file('catalog_checks.sql').splitlines()
        require(len(checks) >= 12, 'Catalog checks returned incomplete results')
        for row in checks:
            name, ok = row.split('|')
            require(ok == 't', 'Catalog check failed: ' + name)
            self.passed(name)

        self.stage = 'sequence fidelity'
        data_sql = self.docker('exec', self.container, 'pg_restore', '--data-only',
                              '--use-list=/tmp/grocery-selected.list', '--file=-',
                              '/tmp/grocery-backup.dump')
        match = re.search(r"SELECT pg_catalog.setval\('public.grocery_items_id_seq', (\d+), (true|false)\);", data_sql)
        require(match is not None, 'Missing archive sequence state')
        state = self.sql('SELECT last_value, is_called FROM public.grocery_items_id_seq;').strip()
        require(state == match[1] + '|' + ('t' if match[2] == 'true' else 'f'), 'Sequence state differs')
        del data_sql  # Raw archive data is never printed or saved on the host.
        self.passed('identity sequence state matches archive and is safe for next insert')

        self.stage = 'rollback-only RLS and RPC behavior'
        self.sql_file('behavior_checks.sql')
        self.passed('NULL identity denied; member CRUD allowed; unrelated identity denied; RPC smoke tests passed')
        require(self.sql('SELECT auth.uid() IS NULL;').strip() == 't', 'Auth stub was not rolled back')
        require(self.sql('SELECT last_value, is_called FROM public.grocery_items_id_seq;').strip() == state,
                'Behavior tests changed the identity sequence')
        for table, expected in TABLES.items():
            require(int(self.sql('SELECT count(*) FROM public.' + table + ';')) == expected,
                    'Behavior tests changed restored row counts')
        self.passed('behavior transaction rolled back; restored counts and sequence retained')
        self.stage = 'backup immutability'
        require(sha256(backup) == original_hash, 'Source backup checksum changed during validation')
        self.passed('source backup unchanged (SHA-256 verified)')
        self.report['status'] = 'PASS'

    def finish(self):
        if self.started:
            try:
                self.docker('stop', '--time', '10', self.container)
                self.report['container_state'] = 'stopped; retained with local data for explicit cleanup'
            except ValidationError:
                self.report['container_state'] = 'stop failed; inspect local Docker'
                self.report['status'] = 'FAIL'
                self.report['checks'].append({'check': 'stop isolated container', 'status': 'FAIL'})
        (self.output / 'report.json').write_text(json.dumps(self.report, indent=2) + '\n')
        lines = [self.report['status'] + ': isolated pre-Migration-003 restore verification',
                 'Migration approval: NO', 'Container: ' + self.container]
        lines += [c['status'] + ': ' + c['check'] for c in self.report['checks']]
        lines += ['LIMITATION: ' + x for x in self.report['limitations']]
        (self.output / 'report.txt').write_text('\n'.join(lines) + '\n')
        print('\n' + self.report['status'] + ': isolated restore verification; migration approval: NO')
        print('Private report: ' + str(self.output / 'report.txt'))
        if self.started:
            print('Retained test container: ' + self.container + ' (no removal performed)')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--backup', type=Path,
                        default=Path.home() / 'Supabase-Backups/grocery-pre-migration-003-full.dump')
    parser.add_argument('--context', default='colima', help='Local Unix-socket Docker context only')
    parser.add_argument('--report-root', type=Path,
                        default=Path(__file__).resolve().parents[1] / '.restore-validation')
    args = parser.parse_args()
    os.umask(0o077)
    output = args.report_root.resolve() / ('run-' + time.strftime('%Y%m%d-%H%M%S') + '-' + uuid.uuid4().hex[:8])
    output.mkdir(parents=True, exist_ok=False)
    runner = Runner(args.context, output)
    try:
        runner.run(args.backup.expanduser().resolve())
    except (ValidationError, OSError, ValueError, KeyError, TypeError, KeyboardInterrupt) as error:
        # Do not print exception values from database/OS/JSON data.
        reason = str(error) if isinstance(error, ValidationError) else 'Interrupted or prerequisite/internal error; details withheld'
        runner.report['checks'].append({'check': runner.stage + ': ' + reason, 'status': 'FAIL'})
        print('FAIL: ' + runner.stage + ': ' + reason, flush=True)
    finally:
        runner.finish()
    return 0 if runner.report['status'] == 'PASS' else 1


if __name__ == '__main__':
    sys.exit(main())
