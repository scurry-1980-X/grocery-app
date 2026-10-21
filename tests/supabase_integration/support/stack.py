"""Configuration-only factory. No executor, exporter or network/process APIs.

The only input is an ambient environment to REJECT, never to forward. Documents
are in-memory JSON-compatible Compose definitions, not runtime authorization.
"""
import hashlib
import json
from pathlib import Path

# The CLI and tests load safety under this existing, shared module name.
from grocery_integration_safety import (
    RunIdentity, SafetyError, API_ORIGIN, identity, require, exact_keys,
    validate_environment, validate_network_policy, validate_volume_policy,
    validate_container_policy, validate_api_origin,
)

STACK = Path(__file__).resolve().parents[1] / 'stack'
IMAGES = {
    'db': 'supabase/postgres:17.6.1.136',
    'auth': 'supabase/gotrue:v2.197.0',
    'rest': 'postgrest/postgrest:v14.18',
    'realtime': 'supabase/realtime:v2.143.3',
    'gateway': 'envoyproxy/envoy:v1.39.4',
    'mail': 'axllent/mailpit:v1.31.6',
}
# Reviewed Linux amd64 child manifest identities, not mutable tag resolution or
# multiarchitecture index/config digests. Updating these requires source review.
PLATFORM = 'linux/amd64'
PINNED_DIGESTS = {
    'db': 'sha256:5a4314708484bec672de2c09653a5c01fb1c84a998564ac231b0325e2238ed5b',
    'auth': 'sha256:839f529492d116b4e8b7777c953a27c381d34c15a744b1bcefde5eefaa1f9f9f',
    'rest': 'sha256:c847127074bd26e1b8d3f7c0e6e01e5346f4b85dd34f5d699fd230af960827c0',
    'realtime': 'sha256:1591e9049bf15fd392da9e8344db892f6acfe9da274517327dbd14733f32b9e1',
    'gateway': 'sha256:63dd445d23d7d419d1bba8b2b9b1b8fdb80f38ae1516fb5d2dcd8856713b7eac',
    'mail': 'sha256:059454962fbda891cfa621c86a251cfd9cfe645cb43e0dcd9351a35e7a8f3155',
}
REALTIME_SOURCE = 'evidence/realtime.sql'
REALTIME_SHA256 = '7e9e442e7fc4dae05544c07b67bede37a00d84644304dfce4d937134cb4c8f88'
REALTIME_DESTINATION = '/docker-entrypoint-initdb.d/migrations/99-realtime.sql'
REGISTRY_EVIDENCE = 'evidence/registry-manifests.json'
REGISTRY_SHA256 = '719c7e3fbd147cc44b3c668799b4c213db992f7c00cb6a1e2b676e3779977e05'
CONTEXT_RULES = ('**', '!Dockerfile.*', '!common.sh', '!postgres.sh',
                 '!postgres-passwords.sh', '!realtime.sh', '!gateway.sh',
                 '!gateway.json', '!gateway.lua', '!evidence/', 'evidence/**',
                 '!evidence/realtime.sql')


def verify_build_inputs():
    """Check fixed local evidence, selected architecture, FROM pins and SQL bytes.

    This neither fetches metadata nor accepts replacement pins/paths. These checks
    are not build authorization; a later executor must consume a verified snapshot.
    """
    try:
        for name, expected_hash in ((REALTIME_SOURCE, REALTIME_SHA256),
                                    (REGISTRY_EVIDENCE, REGISTRY_SHA256)):
            path = STACK / name
            require(not path.is_symlink() and not path.parent.is_symlink(), 'Unsafe evidence path')
            require(hashlib.sha256(path.read_bytes()).hexdigest() == expected_hash,
                    'Reviewed evidence changed')
        provenance = json.loads((STACK / 'provenance.json').read_bytes())
        evidence = json.loads((STACK / REGISTRY_EVIDENCE).read_bytes())
        require(provenance['task3a']['registry_evidence_sha256'] == REGISTRY_SHA256,
                'Registry provenance mismatch')
        source, = provenance['resolved_sources']
        require(source['local_path'] == REALTIME_SOURCE and source['sha256'] == REALTIME_SHA256
                and source['size'] == 117
                and source['source_commit'] == 'e854b84ed4517b0f21a1acd0a0abdd8a8d5cb9a7',
                'Realtime source provenance mismatch')
        require(set(provenance['images']) == set(IMAGES), 'Unexpected image inventory')
        require(len(evidence['records']) == len(IMAGES), 'Unexpected registry inventory')
        for component, reference in IMAGES.items():
            pin = PINNED_DIGESTS[component]
            meta = provenance['images'][component]
            require(meta['reference'] == reference and meta['platform'] == PLATFORM
                    and meta['selected_platform_digest'] == pin
                    and meta['platform_manifests'][PLATFORM]['digest'] == pin,
                    'Image provenance mismatch')
            records = [r for r in evidence['records'] if r['service'] == component]
            require(len(records) == 1 and records[0]['reference'] == reference,
                    'Registry reference mismatch')
            record = records[0]
            require(meta['digest'] == record['index']['digest'], 'Index identity mismatch')
            selected = [m for m in record['verified_platform_manifests']
                        if m['platform'] == {'os': 'linux', 'architecture': 'amd64'}]
            require(len(selected) == 1 and selected[0]['digest'] == pin
                    and 'sha256:' + hashlib.sha256(selected[0]['body'].encode()).hexdigest() == pin,
                    'Platform identity mismatch')
            dockerfile = (STACK / f'Dockerfile.{component}').read_text()
            require([line for line in dockerfile.splitlines() if line.startswith('FROM ')]
                    == ['FROM ' + reference + '@' + pin], 'Unreviewed base image')
            require(not any(line.startswith('ARG ') for line in dockerfile.splitlines()),
                    'Build overrides are forbidden')
            if component == 'db':
                require([line for line in dockerfile.splitlines()
                         if line.startswith('COPY ') and 'realtime.sql' in line]
                        == ['COPY ' + REALTIME_SOURCE + ' ' + REALTIME_DESTINATION],
                        'Unexpected bootstrap installation path')
                require(REALTIME_SHA256 in dockerfile and 'sha256sum -c -' in dockerfile,
                        'Missing bootstrap build hash check')
        require((STACK / '.dockerignore').read_text() == '\n'.join(CONTEXT_RULES) + '\n',
                'Unexpected build context allowlist')
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        raise SafetyError('Build input verification failed; no external actions performed') from None


USERS = {'db': '10001:10001', 'auth': '1000:1000', 'rest': '1000:1000',
         'realtime': '10001:10001', 'gateway': '10001:10001', 'mail': '10001:10001'}
STARTUP = {
    'db': ['/bin/sh', '/harness/postgres.sh'],
    'auth': ['/usr/local/bin/auth'], 'rest': ['/bin/postgrest'],
    'realtime': ['/usr/bin/tini', '-s', '-g', '--', '/bin/sh', '/harness/realtime.sh'],
    'gateway': ['/bin/sh', '/harness/gateway.sh'], 'mail': ['/mailpit'],
}
RUNTIME_PATH = '/var/lib/grocery-harness'
DISABLED_ENTRYPOINT = ['/harness/TASK_2_RUNTIME_DISABLED']  # Intentionally absent.
BLOCKERS = ['controlled build executor and authorization not provided', 'derived images unbuilt and unverified',
            'local credential generation/persistence not implemented',
            'native platform bootstrap parity unverified',
            'daemon inspection, isolation probes and lifecycle executor not implemented']


def _environment(run):
    # These are deliberately invalid, non-secret slots, NOT usable credentials.
    # No Compose ${...} interpolation, caller overrides or .env inputs exist.
    password = 'UNRESOLVED_LOCAL_DB_PASSWORD'
    jwt = 'UNRESOLVED_LOCAL_JWT_SECRET'
    common = {'HOME': RUNTIME_PATH + '/home', 'TMPDIR': RUNTIME_PATH + '/tmp'}
    return {
        'db': {**common, 'PGDATA': '/var/lib/postgresql/data/pgdata',
               'PGHOST': RUNTIME_PATH + '/socket', 'POSTGRES_HOST': RUNTIME_PATH + '/socket',
               'POSTGRES_PORT': '5432', 'POSTGRES_USER': 'supabase_admin',
               'POSTGRES_DB': 'postgres', 'POSTGRES_PASSWORD': password},
        'auth': {'GOTRUE_API_HOST': '0.0.0.0', 'GOTRUE_API_PORT': '9999',
                 'API_EXTERNAL_URL': API_ORIGIN + '/auth/v1', 'GOTRUE_SITE_URL': API_ORIGIN,
                 'GOTRUE_URI_ALLOW_LIST': API_ORIGIN, 'GOTRUE_DB_DRIVER': 'postgres',
                 'GOTRUE_DB_DATABASE_URL': f'postgres://supabase_auth_admin:{password}@db:5432/postgres',
                 'GOTRUE_JWT_SECRET': jwt, 'GOTRUE_JWT_AUD': 'authenticated',
                 'GOTRUE_JWT_ADMIN_ROLES': 'service_role',
                 'GOTRUE_JWT_DEFAULT_GROUP_NAME': 'authenticated', 'GOTRUE_JWT_EXP': '3600',
                 'GOTRUE_JWT_ISSUER': API_ORIGIN + '/auth/v1',
                 'GOTRUE_DISABLE_SIGNUP': 'false', 'GOTRUE_EXTERNAL_EMAIL_ENABLED': 'true',
                 'GOTRUE_EXTERNAL_PHONE_ENABLED': 'false',
                 'GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED': 'false',
                 'GOTRUE_MAILER_AUTOCONFIRM': 'false', 'GOTRUE_SMTP_HOST': 'mail',
                 'GOTRUE_SMTP_PORT': '1025', 'GOTRUE_SMTP_ADMIN_EMAIL': 'auth@grocery.invalid',
                 'GOTRUE_SMTP_SENDER_NAME': 'Disposable Grocery Harness',
                 **{'GOTRUE_MAILER_URLPATHS_' + purpose: '/auth/v1/verify'
                    for purpose in ('INVITE', 'CONFIRMATION', 'RECOVERY', 'EMAIL_CHANGE')}},
        'rest': {'PGRST_DB_URI': f'postgres://authenticator:{password}@db:5432/postgres',
                 'PGRST_DB_SCHEMAS': 'public', 'PGRST_DB_EXTRA_SEARCH_PATH': 'public,extensions',
                 'PGRST_DB_ANON_ROLE': 'anon', 'PGRST_JWT_SECRET': jwt,
                 'PGRST_DB_USE_LEGACY_GUCS': 'false', 'PGRST_SERVER_HOST': '0.0.0.0',
                 'PGRST_SERVER_PORT': '3000', 'PGRST_ADMIN_SERVER_HOST': '127.0.0.1',
                 'PGRST_ADMIN_SERVER_PORT': '3001'},
        'realtime': {**common, 'PORT': '4000', 'DB_HOST': 'db', 'DB_PORT': '5432',
                     'DB_NAME': 'postgres', 'DB_USER': 'supabase_admin', 'DB_PASSWORD': password,
                     'DB_SSL': 'false', 'DB_IP_VERSION': 'IPv4',
                     'DB_AFTER_CONNECT_QUERY': 'SET search_path TO _realtime',
                     'DB_ENC_KEY': 'UNRESOLVED_LOCAL_DB_ENC_KEY',
                     'API_JWT_SECRET': jwt, 'SECRET_KEY_BASE': 'UNRESOLVED_LOCAL_SECRET_KEY_BASE',
                     'RELEASE_COOKIE': 'UNRESOLVED_LOCAL_RELEASE_COOKIE',
                     'RELEASE_TMP': RUNTIME_PATH + '/release',
                     'ERL_CRASH_DUMP': RUNTIME_PATH + '/erl_crash.dump',
                     'APP_NAME': 'realtime', 'SELF_HOST_TENANT_NAME': 'grocery-' + run.nonce,
                     'SELF_HOST_TENANT_DB_HOST': 'db', 'SELF_HOST_TENANT_DB_PORT': '5432',
                     'CLUSTER_STRATEGIES': 'POSTGRES', 'DNS_NODES': '',
                     'METRICS_PUSHER_ENABLED': 'false', 'TENANT_METRICS_PUSHER_ENABLED': 'false',
                     'ENABLE_ERL_CRASH_DUMP': 'false', 'RUN_JANITOR': 'true',
                     'SEED_SELF_HOST': 'true', 'ERL_AFLAGS': '-proto_dist inet_tcp',
                     'REALTIME_IP_VERSION': 'ipv4'},
        'gateway': {**common, 'HARNESS_TENANT': 'grocery-' + run.nonce,
                    'HARNESS_PUBLISHABLE_KEY': 'UNRESOLVED_LOCAL_PUBLISHABLE_KEY',
                    'HARNESS_SECRET_KEY': 'UNRESOLVED_LOCAL_SECRET_KEY',
                    'HARNESS_ANON_JWT': 'UNRESOLVED_LOCAL_ANON_JWT',
                    'HARNESS_SERVICE_JWT': 'UNRESOLVED_LOCAL_SERVICE_JWT'},
        'mail': {**common, 'MP_DATABASE': RUNTIME_PATH + '/mailpit.db',
                 'MP_SMTP_BIND_ADDR': '0.0.0.0:1025', 'MP_UI_BIND_ADDR': '0.0.0.0:8025',
                 'MP_DISABLE_VERSION_CHECK': 'true', 'MP_SMTP_DISABLE_RDNS': 'true',
                 'MP_BLOCK_REMOTE_CSS_AND_FONTS': 'true', 'MP_SMTP_RELAY_ALL': 'false'},
    }


def _document(run):
    verify_build_inputs()
    net = identity(run, 'network', 'private')
    network = {'resource': net, 'driver': 'bridge', 'internal': True,
               'attachable': False, 'external': False, 'options': {}}
    components = ['data', 'db-run', 'realtime-run', 'gateway-run', 'mail-run']
    volumes = [{'resource': identity(run, 'volume', component), 'driver': 'local',
                'external': False, 'options': {}} for component in components]
    volume_by_component = dict(zip(components, volumes))
    policies, services = [], {}
    environments = _environment(run)
    for component in IMAGES:
        resource = identity(run, 'container', component)
        mount_specs = []
        if component == 'db':
            mount_specs.append(('data', '/var/lib/postgresql/data'))
        if component in ('db', 'realtime', 'gateway', 'mail'):
            mount_specs.append((component + '-run', RUNTIME_PATH))
        mounts = [{'type': 'volume', 'source': volume_by_component[name]['resource']['name'],
                   'target': target, 'read_only': False} for name, target in mount_specs]
        policy = {'resource': resource, 'network_mode': net['name'], 'privileged': False,
                  'cap_add': [], 'cap_drop': ['ALL'], 'security_opt': ['no-new-privileges:true'],
                  'read_only': True, 'user': USERS[component], 'mounts': mounts,
                  'ports': [], 'devices': [], 'pid_mode': '', 'ipc_mode': 'private',
                  'uts_mode': '', 'userns_mode': '', 'extra_hosts': [], 'dns': [],
                  'sysctls': {}, 'restart_policy': 'no'}
        policies.append(policy)
        services[component] = {
            'container_name': resource['name'], 'labels': resource['labels'],
            'image': f'grocery-harness-{run.nonce}-{component}:task2', 'pull_policy': 'never',
            'platform': PLATFORM,
            'build': {'context': '.', 'dockerfile': f'Dockerfile.{component}',
                      'network': 'none', 'args': {}},
            'entrypoint': DISABLED_ENTRYPOINT.copy(), 'command': [],
            'x-harness-intended-entrypoint': STARTUP[component].copy(),
            'user': policy['user'], 'read_only': True, 'privileged': False,
            'cap_add': [], 'cap_drop': ['ALL'], 'security_opt': ['no-new-privileges:true'],
            'ipc': 'private', 'restart': 'no', 'ports': [], 'devices': [],
            'extra_hosts': [], 'dns': [], 'sysctls': {},
            'networks': {'private': {'aliases': [component]}},
            'volumes': [{'type': 'volume', 'source': name, 'target': target,
                         'read_only': False, 'volume': {'nocopy': False}}
                        for name, target in mount_specs],
            'environment': environments[component],
            # Disable base-image healthchecks too: no accidental executable path.
            'healthcheck': {'disable': True},
        }
    compose = {
        'name': 'grocery-it-' + run.nonce,
        'x-harness-runtime-enabled': False,
        'services': services,
        'networks': {'private': {'name': net['name'], 'labels': net['labels'],
                                'driver': 'bridge', 'internal': True, 'attachable': False,
                                'external': False, 'driver_opts': {}}},
        'volumes': {name: {'name': v['resource']['name'], 'labels': v['resource']['labels'],
                           'driver': 'local', 'external': False, 'driver_opts': {}}
                    for name, v in volume_by_component.items()},
    }
    return {'run_id': run.nonce, 'runtime_enabled': False, 'blockers': BLOCKERS.copy(),
            'api_origin': API_ORIGIN, 'images': {k: {'base': v, 'digest': PINNED_DIGESTS[k], 'platform': PLATFORM}
                       for k, v in IMAGES.items()},
            'compose': compose, 'policies': {'network': network, 'volumes': volumes,
                                           'containers': policies},
            'artifacts': {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                          for p in sorted(STACK.iterdir()) if p.is_file()}
                         | {name: hashlib.sha256((STACK / name).read_bytes()).hexdigest()
                            for name in (REALTIME_SOURCE, REGISTRY_EVIDENCE)}}


def validate_plan(plan):
    """Validate the WHOLE document before projecting any Compose safety fields.

    No merges, extras, environment overrides, arbitrary paths or image inputs.
    Canonical JSON comparison is type-sensitive (True must not stand in for 1).
    """
    require(type(plan) is dict, 'Invalid stack document')
    run = RunIdentity(plan.get('run_id'))
    expected = _document(run)
    exact_keys(plan, expected)
    try:
        same = json.dumps(plan, sort_keys=True, allow_nan=False) == json.dumps(expected, sort_keys=True)
    except (ValueError, TypeError):
        raise SafetyError('Invalid stack document') from None
    require(same, 'Stack differs from the generated offline contract')
    validate_api_origin(plan['api_origin'])
    policies = plan['policies']
    validate_network_policy(run, policies['network'])
    for volume in policies['volumes']:
        validate_volume_policy(run, volume)
    for container in policies['containers']:
        validate_container_policy(run, container, policies['network'], policies['volumes'])
    return run


def create_plan(environment):
    validate_environment(environment)  # Before nonce generation or file reads.
    plan = _document(RunIdentity.new())
    validate_plan(plan)
    return plan


def require_runtime_ready(plan):
    validate_plan(plan)
    raise SafetyError('Task #2 is configuration-only; runtime is disabled')
