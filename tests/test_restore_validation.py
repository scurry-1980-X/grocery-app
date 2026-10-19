"""Safety regression tests; no Docker, production connections, or private backups."""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    'restore_validation', Path(__file__).resolve().parents[1] / 'scripts/validate_grocery_restore.py')
validation = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(validation)


def fixture_toc():
    entries = []
    def add(kind, name, owner='postgres', schema='public'):
        entries.append(f'{len(entries)+1}; 0 0 {kind} {schema} {name} {owner}')
    for t in validation.TABLES:
        for kind in ('TABLE', 'TABLE DATA', 'ROW SECURITY'):
            add(kind, t)
        add('ACL', 'TABLE ' + t)
        add('CONSTRAINT', t + ' ' + t + '_pkey')
    for t, col in [('grocery_items', 'owner_id'), ('grocery_list_members', 'user_id'),
                   ('grocery_list_invites', 'created_by'), ('grocery_list_create_requests', 'user_id')]:
        add('FK CONSTRAINT', t + ' ' + t + '_' + col + '_fkey')
    for name, args in validation.FUNCTIONS.items():
        add('FUNCTION', name + '(' + args + ')')
    for sig in ['create_grocery_list()', 'create_grocery_list_invite(target_list_id uuid)',
                'create_grocery_list_once(request_id uuid)', 'redeem_grocery_list_invite(invite_token uuid)']:
        add('ACL', 'FUNCTION ' + sig)
    for t, policy in sorted(validation.POLICIES):
        add('POLICY', t + ' ' + policy)
    add('SEQUENCE', validation.SEQ)
    add('SEQUENCE SET', validation.SEQ)
    for kind in ('TABLES', 'FUNCTIONS', 'SEQUENCES'):
        add('DEFAULT ACL', 'DEFAULT PRIVILEGES FOR ' + kind)
        add('DEFAULT ACL', 'DEFAULT PRIVILEGES FOR ' + kind, 'supabase_admin')
    add('FUNCTION', 'rls_auto_enable()')
    add('PUBLICATION TABLE', 'supabase_realtime grocery_items')
    add('TABLE DATA', 'users', 'supabase_auth_admin', 'auth')
    add('ACL', 'SCHEMA public', 'pg_database_owner', '-')
    return '\n'.join(entries) + '\n'


class AllowlistTests(unittest.TestCase):
    def test_complete_allowlist_excludes_managed_objects(self):
        selected, exclusions = validation.select_toc(fixture_toc())
        self.assertEqual(len(selected.splitlines()), 42)
        for forbidden in ('rls_auto_enable', 'supabase', 'SCHEMA', 'auth users'):
            self.assertNotIn(forbidden, selected)
        self.assertEqual(exclusions['supabase_admin_default_privileges'], 3)
        self.assertEqual(selected.count('DEFAULT ACL'), 3)

    def test_missing_required_objects_fail_closed(self):
        toc = fixture_toc()
        for marker in ('TABLE DATA public grocery_items ', 'ROW SECURITY public grocery_items ',
                       'ACL public FUNCTION create_grocery_list_once(', 'FK CONSTRAINT public grocery_items ',
                       'POLICY public grocery_items Members can read', 'SEQUENCE SET public ',
                       'DEFAULT ACL public DEFAULT PRIVILEGES FOR TABLES postgres'):
            with self.subTest(marker=marker):
                reduced = '\n'.join(line for line in toc.splitlines() if marker not in line)
                with self.assertRaises(validation.ValidationError):
                    validation.select_toc(reduced)

    def test_duplicate_object_rejected(self):
        toc = fixture_toc()
        with self.assertRaises(validation.ValidationError):
            validation.select_toc(toc + toc.splitlines()[0] + '\n')

    def test_unknown_public_objects_and_owners_rejected(self):
        for entry in ('TABLE public grocery_items_new postgres',
                      'FUNCTION public unrelated_function() postgres',
                      'EXTENSION public unexpected postgres',
                      'TRIGGER public grocery_items surprise postgres',
                      'DEFAULT ACL public DEFAULT PRIVILEGES FOR TABLES other_owner'):
            with self.subTest(entry=entry), self.assertRaises(validation.ValidationError):
                validation.select_toc(fixture_toc() + '999; 0 0 ' + entry + '\n')
        with self.assertRaises(validation.ValidationError):
            validation.select_toc(fixture_toc().replace('TABLE public grocery_items postgres',
                                                       'TABLE public grocery_items other_owner'))

    def test_malformed_toc_rejected(self):
        with self.assertRaises(validation.ValidationError):
            validation.parse_toc('not a toc line')

    def test_function_body_parser_retains_semantics(self):
        source = '\n'.join('CREATE FUNCTION public.' + n + '(' + args +
                           ') RETURNS uuid\n    LANGUAGE plpgsql\n    AS $$\r\nBEGIN\r\nRETURN NULL;\r\nEND;\r\n$$;'
                           for n, args in validation.FUNCTIONS.items())
        bodies = validation.source_bodies(source)
        self.assertEqual(set(bodies), set(validation.FUNCTIONS))
        self.assertEqual(bodies['create_grocery_list'], '\nBEGIN\nRETURN NULL;\nEND;\n')
        with self.assertRaises(validation.ValidationError):
            validation.source_bodies('')


class RunnerSafetyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.runner = validation.Runner('colima', self.directory)

    def test_rejects_remote_docker_before_container_creation(self):
        backup = self.directory / 'fixture.dump'
        backup.write_bytes(b'PGDMP-not-real')
        with patch.object(self.runner, 'docker', return_value=json.dumps([
                {'Endpoints': {'docker': {'Host': 'tcp://remote.example:2375'}}}])) as docker:
            with self.assertRaises(validation.ValidationError):
                self.runner.run(backup)
            self.assertEqual(docker.call_count, 1)
            self.assertFalse(self.runner.started)

    def test_rejects_non_archive_without_docker(self):
        backup = self.directory / 'fixture.dump'
        backup.write_bytes(b'not a backup')
        with patch.object(self.runner, 'docker') as docker:
            with self.assertRaises(validation.ValidationError):
                self.runner.run(backup)
            docker.assert_not_called()

    def test_database_errors_do_not_leak_values(self):
        fake = subprocess.CompletedProcess(['fake'], 1, 'private-row-value', 'private-user-uuid')
        with patch.object(validation.subprocess, 'run', return_value=fake):
            with self.assertRaises(validation.ValidationError) as error:
                self.runner.command(['fake'])
        self.assertNotIn('private', str(error.exception))

    def test_inherited_connection_environment_removed(self):
        fake = subprocess.CompletedProcess(['fake'], 0, '', '')
        with patch.dict(validation.os.environ, {'PGHOST': 'production', 'PGSERVICE': 'live',
                                               'DOCKER_HOST': 'tcp://remote', 'DOCKER_CONTEXT': 'remote'}):
            with patch.object(validation.subprocess, 'run', return_value=fake) as run:
                self.runner.command(['fake'])
                env = run.call_args.kwargs['env']
                self.assertFalse(any(k.startswith(('PG', 'DOCKER_')) for k in env))

    def test_finish_stops_only_owned_container_without_removal(self):
        self.runner.started = True
        with patch.object(self.runner, 'docker') as docker, patch('builtins.print'):
            self.runner.finish()
        docker.assert_called_once_with('stop', '--time', '10', self.runner.container)
        self.assertEqual(json.loads((self.directory / 'report.json').read_text())['status'], 'FAIL')

    def test_stop_failure_cannot_report_pass(self):
        self.runner.started = True
        self.runner.report['status'] = 'PASS'
        with patch.object(self.runner, 'docker', side_effect=validation.ValidationError('stop failed')):
            with patch('builtins.print'):
                self.runner.finish()
        self.assertEqual(self.runner.report['status'], 'FAIL')

    def test_sql_explicitly_uses_container_unix_socket_and_fixed_db(self):
        with patch.object(self.runner, 'docker', return_value='') as docker:
            self.runner.sql('SELECT 1;')
        args = docker.call_args.args
        self.assertEqual(args[:3], ('exec', '-i', self.runner.container))
        self.assertIn('/var/run/postgresql', args)
        self.assertIn('grocery_restore', args)
        self.assertIn('ON_ERROR_STOP=1', args)


if __name__ == '__main__':
    unittest.main()
