"""Offline-only safety contracts. No Docker, socket, HTTP, SQL or process APIs.

These records describe safety requirements, not a Compose stack or permission to
run it. A later executor must validate real observations against these contracts.
"""
from dataclasses import dataclass
import re
import secrets

OWNER = 'grocery-disposable-integration-v1'
LABEL_PREFIX = 'com.grocery.integration.'
DOCKER_SOCKET = 'unix:///var/run/docker.sock'
API_ORIGIN = 'http://127.0.0.1:54321'
KINDS = {'container': 'c', 'network': 'n', 'volume': 'v'}
COMPONENT = re.compile(r'[a-z][a-z0-9-]{0,11}\Z', re.ASCII)
RUN_ID = re.compile(r'[0-9a-f]{32}\Z', re.ASCII)
OBJECT_ID = re.compile(r'[0-9a-f]{64}\Z', re.ASCII)
# No inherited connection, context, application config, or credential selectors.
# Other ambient variables are ignored, never passed to a child or used as config.
FORBIDDEN_ENV = re.compile(
    r'^(?:PG.*|DB(?:_|$).*|DATABASE.*|SUPABASE.*|GROCERY.*|'
    r'DOCKER.*|COMPOSE.*|CONTAINER.*|PODMAN.*|KUBE.*|'
    r'AWS.*|AZURE.*|GOOGLE_APPLICATION_CREDENTIALS|CLOUDSDK.*|'
    r'GOTRUE.*|PGRST.*|POSTGRES.*|JWT.*|ANON_KEY|SERVICE_ROLE_KEY|'
    r'.*(?:URL|URI|DSN|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|PROJECT_REF).*)$', re.ASCII)
FOREIGN_VALUE = re.compile(
    r'(?i)(?:supabase\.(?:co|com|in|net)|sb_(?:publishable|secret)_|'
    r'\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|'
    r'(?:https?|postgres(?:ql)?|tcp|ssh)://)')


class SafetyError(ValueError):
    """Only fixed messages may cross the CLI boundary; never echo input values."""


def require(condition, message):
    if not condition:
        raise SafetyError(message)


def exact_keys(value, keys):
    require(type(value) is dict and set(value) == set(keys), 'Unexpected policy fields')


def validate_environment(environment):
    """Reject connection/credential selectors before any future external activity.

    Presence is rejected even when empty. Known credential/URL forms under renamed
    keys are also rejected. Unrecognized ambient variables are never consumed.
    This is not a universal secret detector; no external credential input exists.
    """
    require(hasattr(environment, 'items'), 'Invalid environment')
    for key, value in environment.items():
        require(type(key) is str and type(value) is str, 'Invalid environment')
        require(not FORBIDDEN_ENV.fullmatch(key.upper()), 'Connection or credential environment is forbidden')
        # Standard proxy variables are ignored as ambient infrastructure, not
        # accepted for use. No executor/child environment exists in this stage.
        if key.upper() in {'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'}:
            continue
        require(not FOREIGN_VALUE.search(value), 'Foreign connection or credential value is forbidden')


@dataclass(frozen=True)
class RunIdentity:
    nonce: str

    def __post_init__(self):
        require(type(self.nonce) is str and RUN_ID.fullmatch(self.nonce), 'Invalid run identity')

    @classmethod
    def new(cls):
        return cls(secrets.token_hex(16))


def identity(run, kind, component):
    require(type(run) is RunIdentity, 'Invalid run identity')
    require(type(kind) is str and kind in KINDS, 'Invalid resource kind')
    require(type(component) is str and COMPONENT.fullmatch(component), 'Invalid component')
    return {
        'kind': kind,
        'name': f'grocery-it-{run.nonce}-{KINDS[kind]}-{component}',
        'labels': {LABEL_PREFIX + 'owner': OWNER, LABEL_PREFIX + 'run': run.nonce,
                   LABEL_PREFIX + 'kind': kind, LABEL_PREFIX + 'component': component},
    }


def validate_identity(run, resource, kind):
    exact_keys(resource, {'kind', 'name', 'labels'})
    require(type(resource['labels']) is dict, 'Invalid ownership labels')
    component = resource['labels'].get(LABEL_PREFIX + 'component')
    expected = identity(run, kind, component)
    require(resource == expected, 'Resource does not belong to this run')


def validate_api_origin(value):
    # Exact byte comparison: no parser, DNS, redirects or host aliases. Even
    # localhost, alternative numeric forms, userinfo and URL suffixes are denied.
    # This reserves an origin inside a future isolated test network namespace;
    # it is NOT permission to contact host loopback or publish a host port.
    require(type(value) is str and value == API_ORIGIN, 'Unexpected API origin')


def validate_docker_context(record):
    """Validate a minimal context projection, not query Docker or load contexts."""
    exact_keys(record, {'name', 'host', 'skip_tls_verify'})
    require(record['name'] == 'default' and record['host'] == DOCKER_SOCKET
            and record['skip_tls_verify'] is False, 'Unsafe Docker context')


def validate_network_policy(run, record):
    exact_keys(record, {'resource', 'driver', 'internal', 'attachable', 'external', 'options'})
    validate_identity(run, record['resource'], 'network')
    require(record['driver'] == 'bridge' and record['internal'] is True
            and record['attachable'] is False and record['external'] is False
            and type(record['options']) is dict and not record['options'], 'Unsafe network policy')


def validate_volume_policy(run, record):
    exact_keys(record, {'resource', 'driver', 'external', 'options'})
    validate_identity(run, record['resource'], 'volume')
    require(record['driver'] == 'local' and record['external'] is False
            and type(record['options']) is dict and not record['options'], 'Unsafe volume policy')


def validate_container_policy(run, record, network, volumes):
    """Narrow safety projection. Unsupported fields fail rather than being ignored.

    No image, command, environment, secrets or Compose extensions are accepted.
    Those require a separately reviewed, generated runtime configuration later.
    """
    exact_keys(record, {
        'resource', 'network_mode', 'privileged', 'cap_add', 'cap_drop', 'security_opt',
        'read_only', 'user', 'mounts', 'ports', 'devices', 'pid_mode', 'ipc_mode',
        'uts_mode', 'userns_mode', 'extra_hosts', 'dns', 'sysctls', 'restart_policy',
    })
    validate_identity(run, record['resource'], 'container')
    validate_network_policy(run, network)
    require(type(volumes) is list, 'Invalid volume inventory')
    names = set()
    for volume in volumes:
        validate_volume_policy(run, volume)
        name = volume['resource']['name']
        require(name not in names, 'Duplicate volume identity')
        names.add(name)
    require(record['network_mode'] == network['resource']['name'], 'Unsafe container network')
    require(record['privileged'] is False and record['read_only'] is True, 'Unsafe container privilege')
    require(record['cap_add'] == [] and record['cap_drop'] == ['ALL']
            and record['security_opt'] == ['no-new-privileges:true'], 'Unsafe security options')
    require(type(record['user']) is str
            and re.fullmatch(r'[1-9][0-9]{0,9}:[1-9][0-9]{0,9}', record['user'])
            and all(int(part) <= 2147483647 for part in record['user'].split(':')),
            'Container must use explicit non-root numeric user and group')
    require(all(type(record[k]) is list and not record[k] for k in
                ('ports', 'devices', 'extra_hosts', 'dns')), 'Unsafe container connectivity or devices')
    require(record['pid_mode'] == '' and record['ipc_mode'] == 'private'
            and record['uts_mode'] == '' and record['userns_mode'] == ''
            and record['restart_policy'] == 'no' and type(record['sysctls']) is dict
            and not record['sysctls'], 'Unsafe container namespaces or runtime options')
    require(type(record['mounts']) is list, 'Invalid mount inventory')
    targets = set()
    for mount in record['mounts']:
        exact_keys(mount, {'type', 'source', 'target', 'read_only'})
        require(mount['type'] == 'volume' and type(mount['source']) is str
                and mount['source'] in names, 'Unowned or unsafe mount')
        require(mount['target'] in ('/var/lib/postgresql/data', '/var/lib/grocery-harness')
                and type(mount['read_only']) is bool, 'Unexpected mount target')
        require(mount['target'] not in targets, 'Duplicate mount target')
        targets.add(mount['target'])


def cleanup_candidates(run, recorded, observed):
    """Validate a future exact inventory, returning IDs only; NEVER delete anything.

    Both inventories must have identical identities and IDs. The future executor
    must obtain observations itself, bind records to its verified daemon, protect
    its journal and re-inspect immediately before deletion. Labels are not secrets.
    """
    require(type(recorded) is list and type(observed) is list and recorded,
            'Missing ownership inventory')

    def checked(records):
        result = {}
        for record in records:
            exact_keys(record, {'resource', 'id'})
            resource = record['resource']
            require(type(resource) is dict, 'Invalid resource inventory')
            kind = resource.get('kind')
            require(type(kind) is str and kind in KINDS, 'Invalid resource kind')
            validate_identity(run, resource, kind)
            resource_id = record['id']
            require(type(resource_id) is str, 'Invalid resource ID')
            if kind == 'volume':
                require(resource_id == resource['name'], 'Volume identity mismatch')
            else:
                require(OBJECT_ID.fullmatch(resource_id), 'Full resource ID required')
            key = kind, resource_id
            require(key not in result and not any(r['name'] == resource['name'] for r in result.values()),
                    'Duplicate resource inventory')
            result[key] = resource
        return result

    expected, actual = checked(recorded), checked(observed)
    require(expected == actual, 'Ownership inventory mismatch')
    return tuple(sorted(expected))


def offline_preflight(environment):
    validate_environment(environment)
    run = RunIdentity.new()
    return {
        'status': 'OFFLINE_ONLY_RUNTIME_DISABLED',
        'run_id': run.nonce,
        'runtime_enabled': False,
        'docker_context_verified': False,
        'resources_created': False,
        'resource_example': identity(run, 'network', 'private'),
    }
