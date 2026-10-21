"""Offline guard tests; all policy/inspection records are in-memory synthetic data."""
import ast
import contextlib
from copy import deepcopy
import importlib.util
import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('integration_entrypoint', ROOT / 'scripts/run_supabase_integration.py')
entrypoint = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(entrypoint)
safety = entrypoint.safety


def network(run):
    return {'resource': safety.identity(run, 'network', 'private'), 'driver': 'bridge',
            'internal': True, 'attachable': False, 'external': False, 'options': {}}


def volume(run):
    return {'resource': safety.identity(run, 'volume', 'data'), 'driver': 'local',
            'external': False, 'options': {}}


def container(run):
    return {'resource': safety.identity(run, 'container', 'fixture'),
            'network_mode': network(run)['resource']['name'], 'privileged': False,
            'cap_add': [], 'cap_drop': ['ALL'], 'security_opt': ['no-new-privileges:true'],
            'read_only': True, 'user': '1000:1000',
            'mounts': [{'type': 'volume', 'source': volume(run)['resource']['name'],
                        'target': '/var/lib/postgresql/data', 'read_only': False}],
            'ports': [], 'devices': [], 'pid_mode': '', 'ipc_mode': 'private',
            'uts_mode': '', 'userns_mode': '', 'extra_hosts': [], 'dns': [],
            'sysctls': {}, 'restart_policy': 'no'}


def inventory(run):
    return [{'resource': safety.identity(run, kind, 'fixture'),
             'id': safety.identity(run, kind, 'fixture')['name'] if kind == 'volume' else digit * 64}
            for kind, digit in [('container', 'a'), ('network', 'b'), ('volume', 'c')]]


class EnvironmentTests(unittest.TestCase):
    def test_inert_environment_is_accepted_and_never_forwarded(self):
        environment = {'PATH': '/usr/bin', 'HOME': '/home/test', 'LANG': 'C.UTF-8',
                       'HTTP_PROXY': 'http://ambient.invalid:8080', 'NO_PROXY': 'localhost',
                       'UNUSED_VARIABLE': 'unused'}
        report = safety.offline_preflight(environment)
        self.assertFalse(report['runtime_enabled'])
        self.assertFalse(report['docker_context_verified'])
        self.assertFalse(report['resources_created'])
        for value in environment.values():
            self.assertNotIn(value, json.dumps(report))

    def test_connection_credential_and_context_environment_rejected_even_empty(self):
        keys = ['PGHOST', 'PGSERVICEFILE', 'PGPASSFILE', 'PGOPTIONS', 'DATABASE_URL',
                'DB_HOST', 'SUPABASE_URL', 'supabase_project_ref', 'SUPABASE_ACCESS_TOKEN',
                'GROCERY_SHARED_CONFIG', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG',
                'DOCKER_TLS_VERIFY', 'COMPOSE_FILE', 'COMPOSE_PROFILES', 'CONTAINER_HOST',
                'PODMAN_HOST', 'KUBECONFIG', 'AWS_PROFILE', 'AZURE_CLIENT_SECRET',
                'GOOGLE_APPLICATION_CREDENTIALS', 'GOTRUE_SITE_URL', 'PGRST_DB_URI',
                'POSTGRES_PASSWORD', 'JWT_SECRET', 'ANON_KEY', 'SERVICE_ROLE_KEY',
                'CUSTOM_API_KEY', 'CUSTOM_PROJECT_REF', 'CUSTOM_DSN']
        for key in keys:
            for value in ('', 'foreign-sensitive-value'):
                with self.subTest(key=key, empty=not value), self.assertRaises(safety.SafetyError):
                    safety.validate_environment({key: value})

    def test_renamed_hosted_urls_and_recognizable_credentials_rejected(self):
        values = ['https://project.supabase.co', 'https://project.supabase.in',
                  'https://api.supabase.com', 'project.supabase.co',
                  'postgresql://user:secret@db.project.supabase.co/db',
                  'postgres://localhost/db', 'http://127.0.0.1:54321',
                  'ssh://remote/docker', 'tcp://localhost:2375',
                  'sb_publishable_foreign', 'sb_secret_foreign', 'eyJabc.def.ghi']
        for value in values:
            with self.subTest(value=value), self.assertRaises(safety.SafetyError):
                safety.validate_environment({'INNOCENT_NAME': value})

    def test_invalid_environment_types_rejected(self):
        for environment in (None, [], {1: 'x'}, {'KEY': 1}):
            with self.subTest(environment=environment), self.assertRaises(safety.SafetyError):
                safety.validate_environment(environment)

    def test_rejection_precedes_nonce_generation(self):
        with patch.object(safety.RunIdentity, 'new', side_effect=AssertionError('too early')):
            with self.assertRaises(safety.SafetyError):
                safety.offline_preflight({'SUPABASE_URL': 'https://private.supabase.co'})


class OriginAndContextTests(unittest.TestCase):
    def test_only_fixed_namespace_origin_is_accepted(self):
        safety.validate_api_origin(safety.API_ORIGIN)
        invalid = [None, '', 'https://project.supabase.co', 'projectref',
                   'http://localhost:54321', 'http://127.0.0.1:54322',
                   'http://127.1:54321', 'http://2130706433:54321', 'http://[::1]:54321',
                   'http://127.0.0.1.nip.io:54321', 'http://127.0.0.1:54321@evil.invalid',
                   'http://user:pass@127.0.0.1:54321', 'HTTP://127.0.0.1:54321',
                   safety.API_ORIGIN + '/', safety.API_ORIGIN + '?url=https://remote.invalid',
                   safety.API_ORIGIN + '#fragment', safety.API_ORIGIN + '\n',
                   ' http://127.0.0.1:54321', 'http://%31%32%37.0.0.1:54321']
        for value in invalid:
            with self.subTest(value=value), self.assertRaises(safety.SafetyError):
                safety.validate_api_origin(value)

    def test_context_requires_fixed_local_socket_and_default_name(self):
        safe = {'name': 'default', 'host': safety.DOCKER_SOCKET, 'skip_tls_verify': False}
        safety.validate_docker_context(safe)
        for key, values in {
            'name': ['remote', 'production', '', None],
            'host': ['tcp://127.0.0.1:2375', 'tcp://remote:2376', 'ssh://host',
                     'unix:///tmp/docker.sock', 'unix:///var/run/../run/docker.sock',
                     safety.DOCKER_SOCKET + '?x=1', 'npipe:////./pipe/docker_engine'],
            'skip_tls_verify': [True, 0, 'false', None],
        }.items():
            for value in values:
                with self.subTest(key=key, value=value), self.assertRaises(safety.SafetyError):
                    safety.validate_docker_context({**safe, key: value})
        for malformed in ({}, {**safe, 'credentials': 'secret'}, None):
            with self.assertRaises(safety.SafetyError):
                safety.validate_docker_context(malformed)


class ResourceTests(unittest.TestCase):
    def setUp(self):
        self.run = safety.RunIdentity.new()
        self.other = safety.RunIdentity.new()

    def test_generated_nonces_and_names_are_distinct(self):
        runs = [safety.RunIdentity.new() for _ in range(100)]
        self.assertEqual(len({run.nonce for run in runs}), 100)
        for run in runs:
            self.assertRegex(run.nonce, r'^[a-f0-9]{32}$')
            names = {safety.identity(run, kind, 'fixture')['name'] for kind in safety.KINDS}
            self.assertEqual(len(names), 3)
            self.assertTrue(all(len(name) <= 63 for name in names))

    def test_invalid_nonce_component_and_kind_rejected(self):
        for nonce in ('', 'a' * 31, 'A' * 32, 'g' * 32, '../data', None, 1):
            with self.assertRaises(safety.SafetyError):
                safety.RunIdentity(nonce)
        for component in ('', '../data', '/var/run/docker.sock', 'a' * 13, 'one_two', 'é', 'x\n', None):
            with self.assertRaises(safety.SafetyError):
                safety.identity(self.run, 'volume', component)
        for kind in ('image', 'all', 'prune', None):
            with self.assertRaises(safety.SafetyError):
                safety.identity(self.run, kind, 'fixture')

    def test_labels_and_name_must_match_exact_run_kind_and_component(self):
        original = safety.identity(self.run, 'volume', 'fixture')
        safety.validate_identity(self.run, original, 'volume')
        wrongs = [safety.identity(self.other, 'volume', 'fixture'),
                  {**original, 'name': original['name'] + '-other'},
                  {**original, 'kind': 'network'}, {**original, 'labels': {}},
                  {**original, 'labels': {**original['labels'], 'foreign': 'value'}},
                  {**original, 'external': False}]
        for wrong in wrongs:
            with self.assertRaises(safety.SafetyError):
                safety.validate_identity(self.run, wrong, 'volume')

    def test_network_and_volume_reject_external_resources_and_unsafe_options(self):
        safety.validate_network_policy(self.run, network(self.run))
        safety.validate_volume_policy(self.run, volume(self.run))
        for factory, validator, changes in (
            (network, safety.validate_network_policy, [('driver', 'host'), ('internal', False),
             ('internal', 1), ('attachable', True), ('external', True),
             ('options', {'com.docker.network.bridge.name': 'docker0'})]),
            (volume, safety.validate_volume_policy, [('driver', 'nfs'), ('external', True),
             ('options', {'type': 'none', 'o': 'bind', 'device': '/'}), ('options', [])]),
        ):
            for key, value in changes:
                with self.subTest(key=key, value=value), self.assertRaises(safety.SafetyError):
                    validator(self.run, {**factory(self.run), key: value})
            with self.assertRaises(safety.SafetyError):
                validator(self.run, factory(self.other))

    def test_container_accepts_only_restricted_policy(self):
        safety.validate_container_policy(self.run, container(self.run), network(self.run), [volume(self.run)])

    def test_container_rejects_unsafe_settings(self):
        changes = {
            'network_mode': ['host', 'bridge', 'container:foreign', network(self.other)['resource']['name']],
            'privileged': [True, 'false', 0], 'read_only': [False, 1],
            'cap_add': [['SYS_ADMIN'], ['NET_ADMIN']], 'cap_drop': [[]],
            'security_opt': [[], ['seccomp=unconfined'], ['apparmor=unconfined']],
            'user': ['', 'root', '0:1000', '1000:0', '1000', '01:01', '1000:1000\n',
                     '2147483648:1000', '4294967296:1000', '1000:4294967296', '9' * 100 + ':1000'],
            'ports': [['54321:54321'], [{'HostIp': '127.0.0.1', 'HostPort': '54321'}]],
            'devices': [['/dev/sda']], 'pid_mode': ['host'], 'ipc_mode': ['host', 'container:foreign'],
            'uts_mode': ['host'], 'userns_mode': ['host'], 'extra_hosts': [['host.docker.internal:host-gateway']],
            'dns': [['8.8.8.8']], 'sysctls': [{'net.ipv4.ip_forward': '1'}], 'restart_policy': ['always'],
        }
        for key, values in changes.items():
            for value in values:
                with self.subTest(key=key, value=value), self.assertRaises(safety.SafetyError):
                    safety.validate_container_policy(self.run, {**container(self.run), key: value}, network(self.run), [volume(self.run)])

    def test_mounts_cannot_reach_host_sockets_paths_or_foreign_volumes(self):
        base = container(self.run)
        mount = base['mounts'][0]
        mutations = [{'type': 'bind'}, {'type': 'tmpfs'}, {'source': '/var/run/docker.sock'},
                     {'source': '/'}, {'source': volume(self.other)['resource']['name']},
                     {'target': '/var/run/docker.sock'}, {'target': '/etc'},
                     {'target': '/var/lib/postgresql/data/../../etc'}, {'read_only': 0},
                     {'propagation': 'rshared'}]
        for change in mutations:
            with self.subTest(change=change), self.assertRaises(safety.SafetyError):
                safety.validate_container_policy(self.run, {**base, 'mounts': [{**mount, **change}]}, network(self.run), [volume(self.run)])
        for mounts in ([mount, mount], None):
            with self.assertRaises(safety.SafetyError):
                safety.validate_container_policy(self.run, {**base, 'mounts': mounts}, network(self.run), [volume(self.run)])
        with self.assertRaises(safety.SafetyError):
            safety.validate_container_policy(self.run, base, network(self.run), [volume(self.run), volume(self.run)])

    def test_unknown_and_missing_fields_fail_closed(self):
        validators = [
            (network(self.run), lambda x: safety.validate_network_policy(self.run, x)),
            (volume(self.run), lambda x: safety.validate_volume_policy(self.run, x)),
            (container(self.run), lambda x: safety.validate_container_policy(self.run, x, network(self.run), [volume(self.run)])),
        ]
        for record, validate in validators:
            for field in record:
                wrong = deepcopy(record)
                del wrong[field]
                with self.subTest(missing=field), self.assertRaises(safety.SafetyError):
                    validate(wrong)
            for extra in ('environment', 'env_file', 'extends', 'include', 'build', 'secrets', 'volumes_from', 'links', 'credentials'):
                with self.subTest(extra=extra), self.assertRaises(safety.SafetyError):
                    validate({**record, extra: 'untrusted'})

    def test_cleanup_requires_exact_owned_recorded_and_observed_ids(self):
        records = inventory(self.run)
        result = safety.cleanup_candidates(self.run, records, deepcopy(records))
        self.assertEqual(len(result), 3)
        self.assertIn(('container', 'a' * 64), result)
        self.assertEqual(records, inventory(self.run))
        wrongs = [[], inventory(self.other), records[:-1], records + [records[0]],
                  [{**records[0], 'id': 'short-id'}, *records[1:]],
                  [{**records[0], 'id': 'd' * 64}, *records[1:]],
                  [{**records[0], 'resource': {**records[0]['resource'], 'labels': {}}}, *records[1:]],
                  [{**records[0], 'force': True}, *records[1:]],
                  [*records[:-1], {**records[-1], 'id': 'foreign-volume'}]]
        for observed in wrongs:
            with self.subTest(observed=observed), self.assertRaises(safety.SafetyError):
                safety.cleanup_candidates(self.run, records, observed)
        for recorded in ([], None, [records[0], records[0]]):
            with self.assertRaises(safety.SafetyError):
                safety.cleanup_candidates(self.run, recorded, records)


class EntrypointTests(unittest.TestCase):
    def invoke(self, args, environment):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = entrypoint.main(args, environment)
        return code, out.getvalue(), err.getvalue()

    def test_actual_entrypoint_is_offline_with_external_calls_forbidden(self):
        with patch('socket.getaddrinfo', side_effect=AssertionError('DNS forbidden')), \
             patch('socket.socket', side_effect=AssertionError('network forbidden')), \
             patch('subprocess.Popen', side_effect=AssertionError('process forbidden')), \
             patch('os.system', side_effect=AssertionError('shell forbidden')):
            code, out, err = self.invoke(['preflight'], {})
            self.assertEqual(code, 0)
            self.assertEqual(err, '')
            report = json.loads(out)
            self.assertEqual(report['status'], 'OFFLINE_ONLY_RUNTIME_DISABLED')
            self.assertFalse(report['runtime_enabled'])
            self.assertEqual(self.invoke(['preflight'], {'SUPABASE_URL': 'https://secret.supabase.co'})[0], 2)
            self.assertEqual(self.invoke(['preflight', '--db-url', 'postgres://secret@host/db'], {})[0], 2)

    def test_every_user_configuration_and_runtime_action_is_rejected_without_echo(self):
        for args in ([], ['up'], ['start'], ['run'], ['down'], ['cleanup'], ['prune'],
                     ['preflight', '--url', 'https://private.supabase.co'],
                     ['preflight', '--project-ref', 'private-project'],
                     ['preflight', '--key', 'private-credential'],
                     ['preflight', '--config', 'private.json'], ['preflight', '--run-id', 'a' * 32],
                     ['preflight', '--docker-context', 'remote'], ['preflight', '--', 'secret']):
            with self.subTest(args=args):
                with patch.object(safety, 'offline_preflight', side_effect=AssertionError('arguments must fail first')):
                    code, out, err = self.invoke(args, {})
                self.assertEqual(code, 2)
                self.assertEqual(out, '')
                self.assertEqual(err, 'Rejected arguments. Only offline preflight is supported; no connection or credential inputs.\n')

    def test_environment_error_is_redacted(self):
        code, out, err = self.invoke(['preflight'], {'SUPABASE_ACCESS_TOKEN': 'private-credential'})
        self.assertEqual(code, 2)
        self.assertEqual(out, '')
        self.assertNotIn('private-credential', err)
        self.assertNotIn('SUPABASE_ACCESS_TOKEN', err)

    def test_help_does_not_prepare_or_create_resources(self):
        with patch.object(safety, 'offline_preflight', side_effect=AssertionError('not needed')):
            code, out, err = self.invoke(['--help'], {})
        self.assertEqual(code, 0)
        self.assertIn('Offline only', out)
        self.assertEqual(err, '')

    def test_implementation_has_no_external_execution_or_connection_imports(self):
        allowed = {'dataclasses', 're', 'secrets', 'importlib.util', 'json', 'os', 'pathlib', 'sys'}
        for path in (ROOT / 'scripts/run_supabase_integration.py', entrypoint.SAFETY_PATH):
            tree = ast.parse(path.read_text())
            imports = {alias.name for node in ast.walk(tree) if isinstance(node, ast.Import) for alias in node.names}
            imports |= {node.module for node in ast.walk(tree) if isinstance(node, ast.ImportFrom)}
            self.assertTrue(imports <= allowed, imports - allowed)
            for node in ast.walk(tree):
                if isinstance(node, ast.Call):
                    name = ast.unparse(node.func)
                    self.assertNotIn(name, {'eval', 'exec', '__import__', 'os.system', 'os.popen', 'os.spawnv', 'os.execv'})


if __name__ == '__main__':
    unittest.main()
