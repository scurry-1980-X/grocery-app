"""Task #2 offline validation; never builds images or executes adapter scripts."""
import ast
from copy import deepcopy
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import socket
import subprocess
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SUPPORT = ROOT / 'tests/supabase_integration/support'

def load(name, path):
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module

safety = load('grocery_integration_safety', SUPPORT / 'safety.py')
stack = load('grocery_integration_stack', SUPPORT / 'stack.py')


class StackTests(unittest.TestCase):
    def setUp(self):
        self.plan = stack.create_plan({})

    def reject_change(self, path, value):
        changed = deepcopy(self.plan)
        target = changed
        for key in path[:-1]:
            target = target[key]
        target[path[-1]] = value
        with self.assertRaises(safety.SafetyError):
            stack.validate_plan(changed)

    def test_complete_plan_and_task1_contracts_accept(self):
        run = stack.validate_plan(self.plan)
        self.assertEqual(run.nonce, self.plan['run_id'])
        self.assertEqual(set(self.plan['compose']['services']), {'db', 'auth', 'rest', 'realtime', 'gateway', 'mail'})
        self.assertEqual(len(self.plan['policies']['volumes']), 5)
        for container in self.plan['policies']['containers']:
            safety.validate_container_policy(run, container, self.plan['policies']['network'],
                                             self.plan['policies']['volumes'])

    def test_nonce_isolation_and_no_resource_reuse(self):
        other = stack.create_plan({})
        def names(plan):
            policies = plan['policies']
            return {v['resource']['name'] for v in policies['volumes'] + policies['containers'] + [policies['network']]}
        self.assertFalse(names(self.plan) & names(other))
        for name in names(self.plan):
            self.assertIn(self.plan['run_id'], name)
        self.assertNotEqual(self.plan['compose']['services']['realtime']['environment']['SELF_HOST_TENANT_NAME'],
                            other['compose']['services']['realtime']['environment']['SELF_HOST_TENANT_NAME'])

    def test_document_does_not_alias_trusted_factory_constants(self):
        self.plan['compose']['services']['db']['x-harness-intended-entrypoint'].append('evil')
        self.plan['blockers'].clear()
        with self.assertRaises(safety.SafetyError):
            stack.validate_plan(self.plan)
        fresh = stack.create_plan({})
        self.assertTrue(fresh['blockers'])
        self.assertNotIn('evil', fresh['compose']['services']['db']['x-harness-intended-entrypoint'])

    def test_offline_generator_never_uses_network_process_or_writes(self):
        with patch.object(socket, 'getaddrinfo', side_effect=AssertionError('DNS')), \
             patch.object(socket, 'socket', side_effect=AssertionError('socket')), \
             patch.object(subprocess, 'Popen', side_effect=AssertionError('process')), \
             patch.object(Path, 'write_text', side_effect=AssertionError('write')), \
             patch.object(Path, 'write_bytes', side_effect=AssertionError('write')):
            plan = stack.create_plan({'PATH': '/ignored', 'HTTPS_PROXY': 'http://ignored.invalid'})
            stack.validate_plan(plan)
            with self.assertRaises(safety.SafetyError):
                stack.require_runtime_ready(plan)
        text = json.dumps(plan)
        self.assertNotIn('ignored', text)

    def test_unsafe_environment_rejected_before_reads_or_identity(self):
        for key, value in [('SUPABASE_URL', ''), ('DB_URL', 'postgres://localhost/db'),
                           ('DOCKER_HOST', 'ssh://remote'), ('ODD', 'sb_publishable_foreign'),
                           ('ODD', 'https://foreign.supabase.co'), ('JWT_SECRET', 'foreign')]:
            with self.subTest(key=key), patch.object(safety.RunIdentity, 'new', side_effect=AssertionError('nonce')), \
                 patch.object(Path, 'read_bytes', side_effect=AssertionError('read')):
                with self.assertRaises(safety.SafetyError):
                    stack.create_plan({key: value})

    def test_no_hidden_overrides_or_compose_extensions(self):
        for field, value in [('env_file', ['.env']), ('extends', {'file': 'evil.yaml'}),
                             ('profiles', ['unsafe']), ('secrets', ['secret']),
                             ('configs', ['config']), ('volumes_from', ['production']),
                             ('x-override', True), ('network_mode', 'host'),
                             ('tmpfs', ['/tmp']), ('entrypoint', ['/bin/sh']),
                             ('command', ['curl', 'https://foreign.invalid'])]:
            with self.subTest(field=field):
                self.reject_change(['compose', 'services', 'db', field], value)
        self.reject_change(['compose', 'include'], ['foreign.yaml'])
        self.reject_change(['compose', 'services', 'studio'], {})

    def test_compose_mutations_cannot_hide_behind_unchanged_safe_projection(self):
        for field, value in [('privileged', True), ('read_only', False), ('user', '0:0'),
                             ('cap_add', ['SYS_ADMIN']), ('cap_drop', []),
                             ('security_opt', ['seccomp=unconfined']), ('ports', ['5432:5432']),
                             ('devices', ['/dev/kvm']), ('dns', ['8.8.8.8']),
                             ('extra_hosts', ['host.docker.internal:host-gateway']),
                             ('ipc', 'host'), ('pid', 'host'), ('restart', 'always'),
                             ('healthcheck', {'test': ['CMD', 'curl', 'https://foreign.invalid']})]:
            with self.subTest(field=field):
                self.reject_change(['compose', 'services', 'db', field], value)
        self.reject_change(['policies', 'containers', 0, 'read_only'], 1)
        self.reject_change(['compose', 'services', 'db', 'read_only'], 1)

    def test_mount_network_and_identity_mutations_rejected(self):
        changes = [(['compose', 'services', 'db', 'volumes', 0, 'type'], 'bind'),
                   (['compose', 'services', 'db', 'volumes', 0, 'source'], '/var/run/docker.sock'),
                   (['compose', 'services', 'db', 'volumes', 0, 'target'], '/tmp'),
                   (['compose', 'services', 'db', 'volumes', 0, 'volume', 'nocopy'], True),
                   (['compose', 'services', 'db', 'networks'], {'foreign': {}}),
                   (['compose', 'networks', 'private', 'internal'], False),
                   (['compose', 'networks', 'private', 'external'], True),
                   (['compose', 'volumes', 'data', 'driver_opts'], {'type':'nfs','device':'remote:/'}),
                   (['compose', 'services', 'db', 'labels'], {}),
                   (['compose', 'services', 'db', 'container_name'], 'existing-postgres')]
        for path, value in changes:
            with self.subTest(path=path): self.reject_change(path, value)

    def test_credentials_hosts_images_and_build_inputs_not_accepted(self):
        changes = [(['compose', 'services', 'auth', 'environment', 'GOTRUE_DB_DATABASE_URL'], 'postgres://secret@prod/db'),
                   (['compose', 'services', 'auth', 'environment', 'GOTRUE_JWT_SECRET'], 'foreign'),
                   (['compose', 'services', 'gateway', 'environment', 'HARNESS_PUBLISHABLE_KEY'], 'sb_publishable_foreign'),
                   (['compose', 'services', 'realtime', 'environment', 'DB_HOST'], 'host.docker.internal'),
                   (['compose', 'services', 'mail', 'environment', 'MP_SMTP_RELAY_ALL'], 'true'),
                   (['compose', 'services', 'db', 'environment', 'HTTP_PROXY'], 'http://remote'),
                   (['compose', 'services', 'db', 'build', 'context'], '/workspace'),
                   (['compose', 'services', 'db', 'build', 'network'], 'host'),
                   (['compose', 'services', 'db', 'build', 'args', 'BASE_DIGEST'], 'sha256:'+'a'*64),
                   (['compose', 'services', 'db', 'image'], 'foreign:latest'),
                   (['compose', 'services', 'db', 'pull_policy'], 'always'),
                   (['images', 'db', 'digest'], 'sha256:'+'a'*64)]
        for path, value in changes:
            with self.subTest(path=path): self.reject_change(path, value)

    def test_no_interpolation_foreign_urls_or_real_secrets_in_plan(self):
        text = json.dumps(self.plan['compose'])
        for forbidden in ('${', 'supabase.co', 'supabase.com', 'host.docker.internal',
                          'https://', 'sb_publishable_', 'sb_secret_', 'eyJ'):
            self.assertNotIn(forbidden, text)
        for env in (s['environment'] for s in self.plan['compose']['services'].values()):
            for key, value in env.items():
                if 'postgres://' in value: self.assertRegex(value, r'^postgres://[a-z_]+:UNRESOLVED_LOCAL_DB_PASSWORD@db:5432/postgres$')
        self.assertNotIn('secrets', self.plan['compose'])

    def test_runtime_cannot_be_enabled_or_bypassed_by_document_flags(self):
        with self.assertRaisesRegex(safety.SafetyError, 'configuration-only'):
            stack.require_runtime_ready(self.plan)
        self.reject_change(['runtime_enabled'], True)
        self.reject_change(['compose', 'x-harness-runtime-enabled'], True)
        self.reject_change(['blockers'], [])
        for service in self.plan['compose']['services'].values():
            self.assertEqual(service['entrypoint'], ['/harness/TASK_2_RUNTIME_DISABLED'])
            self.assertEqual(service['healthcheck'], {'disable': True})
            self.assertEqual(service['pull_policy'], 'never')
            self.assertEqual(service['build']['args'], {'BASE_DIGEST': 'UNRESOLVED'})
        self.assertFalse((stack.STACK/'TASK_2_RUNTIME_DISABLED').exists())

    def test_only_literal_internal_network_with_no_host_ports(self):
        net = self.plan['compose']['networks']
        self.assertEqual(set(net), {'private'})
        for name, service in self.plan['compose']['services'].items():
            self.assertEqual(service['networks'], {'private': {'aliases': [name]}})
            self.assertEqual(service['ports'], [])
            self.assertNotIn('network_mode', service)
            self.assertEqual(service['read_only'], True)

    def test_factory_has_no_executor_imports(self):
        tree = ast.parse((SUPPORT/'stack.py').read_text())
        imports = {n.names[0].name.split('.')[0] for n in ast.walk(tree) if isinstance(n, ast.Import)}
        self.assertEqual(imports, {'hashlib', 'json'})
        self.assertNotIn('subprocess', (SUPPORT/'stack.py').read_text())


class DefinitionTests(unittest.TestCase):
    def test_exact_digest_required_base_images_and_numeric_final_users(self):
        for name, image in stack.IMAGES.items():
            text = (stack.STACK/f'Dockerfile.{name}').read_text()
            self.assertEqual(re.findall(r'^FROM (.+)$', text, re.M), [image+'@${BASE_DIGEST}'])
            self.assertIn('ARG BASE_DIGEST\n', text)
            self.assertEqual(re.findall(r'^USER (.+)$', text, re.M)[-1], stack.USERS[name])
            self.assertIn('HEALTHCHECK NONE', text)
            self.assertNotRegex(text, r'(?im)^(?:ADD|VOLUME|EXPOSE)\b')
            self.assertNotRegex(text, r'\b(?:curl|wget|apt-get|apk add|--mount)\b')
            self.assertNotIn('latest', text)
            # JSON entrypoint agrees with the generated intended startup.
            entry = re.search(r'^ENTRYPOINT (.+)$', text, re.M).group(1)
            self.assertEqual(json.loads(entry), stack.STARTUP[name])

    def test_build_context_cannot_copy_fixtures_secrets_or_host_repository(self):
        ignore = (stack.STACK/'.dockerignore').read_text().splitlines()
        self.assertEqual(ignore[0], '**')
        allowed = {line[1:] for line in ignore[1:]}
        self.assertEqual(allowed, {'Dockerfile.*','common.sh','postgres.sh','postgres-passwords.sh',
                                   'realtime.sh','gateway.sh','gateway.json','gateway.lua'})
        for dockerfile in stack.STACK.glob('Dockerfile.*'):
            for line in dockerfile.read_text().splitlines():
                if line.startswith('COPY '):
                    for source in line.split()[1:-1]:
                        self.assertIn(source, allowed)
                        self.assertTrue((stack.STACK/source).is_file())

    def test_all_shell_adapters_parse_without_execution(self):
        # sh -n parses only. It must not source, evaluate or execute the scripts.
        for path in stack.STACK.glob('*.sh'):
            result = subprocess.run(['/bin/sh', '-n', str(path)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, path.name+': '+result.stderr)

    def test_no_adapter_cloud_fetch_or_runtime_permission_changes(self):
        for path in stack.STACK.glob('*.sh'):
            text = path.read_text()
            self.assertNotRegex(text, r'\b(?:curl|wget|aws|docker|sudo|gosu|su-exec|chmod|chown)\s')
            self.assertNotIn('set -x', text)
            self.assertNotIn('169.254.', text)
            self.assertNotIn('supabase.co', text)
        sql = (stack.STACK/'postgres-passwords.sh').read_text()
        self.assertNotRegex(sql, r'(?im)^\s*(?:GRANT|REVOKE|CREATE ROLE|CREATE SCHEMA|CREATE TABLE|CREATE FUNCTION)\b')
        self.assertNotIn('grocery_', sql)

    def test_recovered_realtime_source_is_evidence_only_not_runtime_installation(self):
        for path in stack.STACK.glob('*.sh'):
            self.assertNotRegex(path.read_text(), r'(?i)CREATE\s+SCHEMA\b')
        self.assertFalse((stack.STACK/'realtime.sql').exists())
        provenance = json.loads((stack.STACK/'provenance.json').read_text())
        self.assertEqual(provenance['unresolved_sources'], [])
        recovered, = provenance['resolved_sources']
        self.assertTrue(recovered['url'].endswith('/docker/volumes/db/realtime.sql'))
        self.assertEqual(recovered['sha256'], '7e9e442e7fc4dae05544c07b67bede37a00d84644304dfce4d937134cb4c8f88')
        self.assertIs(recovered['contents_available'], True)
        self.assertIs(recovered['runtime_installed'], False)
        self.assertIs(recovered['requires_future_installation_review'], True)
        plan = stack.create_plan({})
        self.assertIn('native platform bootstrap parity and Realtime prerequisite review pending', plan['blockers'])
        with self.assertRaises(safety.SafetyError):
            stack.require_runtime_ready(plan)

    def test_postgres_paths_bootstrap_and_no_application_installation(self):
        text = (stack.STACK/'postgres.sh').read_text()
        for setting in ('-c data_directory="$PGDATA"', '-c hba_file="$PGDATA/pg_hba.conf"',
                        '-c ident_file="$PGDATA/pg_ident.conf"', '-c unix_socket_directories="$PGHOST"',
                        '-c dynamic_shared_memory_type=mmap', '-c shared_memory_type=mmap',
                        'bootstrap-complete'):
            self.assertIn(setting, text)
        dockerfile = (stack.STACK/'Dockerfile.db').read_text()
        self.assertIn('/var/lib/grocery-harness/keys/pgsodium_root.key', dockerfile)
        self.assertIn('/var/lib/grocery-harness/socket', dockerfile)
        for path in stack.STACK.glob('*'):
            if path.suffix in ('.sh', '.lua') or path.name.startswith('Dockerfile'):
                self.assertNotIn('001_grocery_prerequisites.sql', path.read_text())
                self.assertNotIn('mutate_grocery_once', path.read_text())

    def test_realtime_no_reseed_no_cloud_node_discovery_and_no_lazy_root_write(self):
        text = (stack.STACK/'realtime.sh').read_text()
        self.assertLess(text.index('set -C'), text.index('/app/bin/migrate'))
        self.assertLess(text.index('/app/bin/migrate'), text.index('Realtime.Release.seeds'))
        self.assertLess(text.index('Realtime.Release.seeds'), text.index('exec /app/bin/server'))
        self.assertIn('seed-attempted', text)
        dockerfile = (stack.STACK/'Dockerfile.realtime').read_text()
        self.assertIn('xz -dc /usr/local/share/pgdelta/pgdelta.xz', dockerfile)
        self.assertIn('export RELEASE_NODE=realtime@127.0.0.1', dockerfile)
        self.assertIn('url: [host: "realtime", port: 4000, scheme: "http"],', dockerfile)
        self.assertIn('test "$(grep -Fc', dockerfile)  # pinned text must exist before adaptation

    def test_gateway_routes_clusters_listener_and_writable_config_paths(self):
        config = json.loads((stack.STACK/'gateway.json').read_text())
        self.assertNotIn('admin', config)
        resources = config['static_resources']
        self.assertEqual({c['name'] for c in resources['clusters']}, {'auth','rest','realtime'})
        for cluster in resources['clusters']:
            address = cluster['load_assignment']['endpoints'][0]['lb_endpoints'][0]['endpoint']['address']['socket_address']
            self.assertEqual(address['address'], cluster['name'])
        listener = resources['listeners'][0]
        self.assertEqual(listener['address']['socket_address'], {'address':'0.0.0.0','port_value':54321})
        hcm = listener['filter_chains'][0]['filters'][0]['typed_config']
        routes = hcm['route_config']['virtual_hosts'][0]['routes']
        self.assertEqual({r['name'] for r in routes}, {'auth','auth-health','auth-verify','rest','realtime','unmatched'})
        realtime = next(r for r in routes if r['name']=='realtime')
        self.assertEqual(realtime['route']['host_rewrite_literal'], '@TENANT@.supabase-realtime')
        self.assertEqual(realtime['route']['timeout'], '0s')
        self.assertEqual(realtime['route']['upgrade_configs'], [{'upgrade_type':'websocket'}])
        self.assertEqual(routes[-1]['direct_response']['status'], 404)
        self.assertEqual(hcm['http_filters'][1]['typed_config']['default_source_code']['filename'],
                         '/var/lib/grocery-harness/gateway.lua')
        cors = hcm['route_config']['virtual_hosts'][0]['typed_per_filter_config']['envoy.filters.http.cors']
        self.assertEqual(cors['allow_origin_string_match'], [{'exact':safety.API_ORIGIN}])

    def test_provenance_and_baseline_task1_integrity(self):
        provenance = json.loads((stack.STACK/'provenance.json').read_text())
        self.assertEqual(provenance['checkpoint'], 'fdc03783253d0fe2d34255ae061568002fc2d694')
        for name, record in provenance['images'].items():
            self.assertEqual(record['reference'], stack.IMAGES[name])
            self.assertRegex(record['digest'], r'^sha256:[0-9a-f]{64}$')
            self.assertEqual(record['digest_kind'], 'oci_image_index')
            self.assertEqual(record['selected_platform_digest'], record['platform_manifests']['linux/amd64']['digest'])
            self.assertIs(record['source_commit_to_published_image_binding_verified'], False)
            self.assertRegex(record['source_commit'], r'^[0-9a-f]{40}$')
        self.assertEqual(len(provenance['sources']), 33)
        for record in provenance['sources']:
            self.assertRegex(record['sha256'], r'^[0-9a-f]{64}$')
            self.assertRegex(record['url'], r'^https://(?:raw.githubusercontent.com|github.com)/')
        for path, expected in provenance['unchanged_files'].items():
            self.assertEqual(hashlib.sha256((ROOT/path).read_bytes()).hexdigest(), expected, path)


if __name__ == '__main__':
    unittest.main()
