"""Configuration-only stack factory. No executor, exporter, secret input or I/O APIs.

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
BLOCKERS = ['image digests unresolved', 'derived images unbuilt and unverified',
            'local credential generation/persistence not implemented',
            'native platform bootstrap parity and Realtime prerequisite review pending',
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
            'platform': 'linux/amd64',
            'build': {'context': '.', 'dockerfile': f'Dockerfile.{component}',
                      'network': 'none', 'args': {'BASE_DIGEST': 'UNRESOLVED'}},
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
            'api_origin': API_ORIGIN, 'images': {k: {'base': v, 'digest': None} for k, v in IMAGES.items()},
            'compose': compose, 'policies': {'network': network, 'volumes': volumes,
                                           'containers': policies},
            'artifacts': {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                          for p in sorted(STACK.iterdir()) if p.is_file()}}


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
