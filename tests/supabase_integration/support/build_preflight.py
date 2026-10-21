"""Task #4A offline evidence/context checks; no build, network or Docker executor.

This module cannot authorize a build. Observations are historical, not live proof.
The trusted repository supplies all pins and the reviewed context inventory.
"""
import hashlib
import io
import json
from pathlib import Path
import re
import stat
import tarfile

from grocery_integration_safety import RunIdentity, OWNER, LABEL_PREFIX, require, SafetyError
from grocery_integration_stack import IMAGES, PINNED_DIGESTS, STACK, REGISTRY_SHA256, CONTEXT_RULES

REVIEW = Path(__file__).resolve().parents[1] / 'preflight'
CHECKPOINT = 'c5f1d886e3094c7c3963dbf2c16520d4a4460a80'
CONTEXT_FILES = tuple(sorted([
    '.dockerignore', *(f'Dockerfile.{name}' for name in IMAGES),
    'common.sh', 'postgres.sh', 'postgres-passwords.sh', 'realtime.sh',
    'gateway.sh', 'gateway.json', 'gateway.lua', 'evidence/realtime.sql',
]))


def digest(data):
    return hashlib.sha256(data).hexdigest()


def verify_configs(evidence):
    """Bind exact config bodies to the previously reviewed child manifests."""
    raw = (STACK / 'evidence/registry-manifests.json').read_bytes()
    require(digest(raw) == REGISTRY_SHA256, 'Registry evidence changed')
    manifests = json.loads(raw)['records']
    require(evidence['checkpoint'] == CHECKPOINT, 'Wrong review checkpoint')
    for flag in ('layers_fetched', 'account_credentials_used', 'anonymous_tokens_persisted'):
        require(evidence[flag] is False, 'Unexpected acquisition method')
    records = evidence['records']
    require(len(records) == 6 and {r['service'] for r in records} == set(IMAGES),
            'Unexpected config inventory')
    result = {}
    for record in records:
        name = record['service']
        parent, = [m for r in manifests if r['service'] == name
                   for m in r['verified_platform_manifests']
                   if m['digest'] == PINNED_DIGESTS[name]]
        require('sha256:' + digest(parent['body'].encode()) == PINNED_DIGESTS[name],
                'Manifest identity mismatch')
        desc = json.loads(parent['body'])['config']
        raw = record['body'].encode('utf-8')
        require(record['manifest_digest'] == PINNED_DIGESTS[name]
                and record['reference'] == IMAGES[name], 'Wrong base image')
        require(record['digest'] == desc['digest'] == 'sha256:' + digest(raw)
                and record['size'] == desc['size'] == len(raw)
                and record['media_type'] == desc['mediaType'], 'Config identity mismatch')
        require(record['docker_content_digest'] in (None, desc['digest']), 'Config header mismatch')
        repo = IMAGES[name].rsplit(':', 1)[0]
        require(record['url'] == 'https://registry-1.docker.io/v2/' + repo + '/blobs/' + desc['digest'],
                'Unexpected config source')
        config = json.loads(raw)
        require(config['os'] == 'linux' and config['architecture'] == 'amd64',
                'Unsupported base platform')
        settings = config['config']
        require(settings.get('OnBuild') in (None, []), 'Inherited build triggers forbidden')
        require(settings.get('Volumes') in (None, {}), 'Inherited volumes require review')
        result[name] = config
    return result


def validate_dockerfile(data, component, files):
    """Accept the current narrow grammar, never general Dockerfile path expansion."""
    text = data.decode('utf-8')
    require(not re.search(r'(?im)^\s*#\s*(?:syntax|escape)\s*=', text), 'Parser override forbidden')
    lines = text.replace('\\\n', ' ').splitlines()
    bases = []
    for line in lines:
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        instruction, _, args = line.partition(' ')
        require(instruction in {'FROM', 'USER', 'RUN', 'COPY', 'WORKDIR',
                                'HEALTHCHECK', 'ENTRYPOINT', 'CMD'}, 'Unsupported instruction')
        if instruction == 'FROM':
            bases.append(args)
        if instruction == 'RUN':
            require(not args.startswith('--'), 'Build execution override forbidden')
        if instruction == 'COPY':
            tokens = args.split()
            require(len(tokens) >= 2, 'Invalid COPY')
            for source in tokens[:-1]:
                require(source in files and source != '.dockerignore'
                        and not source.startswith('Dockerfile.'), 'Unreviewed COPY source')
            destination = tokens[-1]
            require(re.fullmatch(r'/[A-Za-z0-9_./-]+', destination) is not None
                    and '..' not in destination.split('/'), 'Invalid COPY destination')
    require(bases == [IMAGES[component] + '@' + PINNED_DIGESTS[component]], 'Unreviewed FROM')


def capture_context(root=STACK):
    """Capture regular files once; exclude symlinks, hardlinks and special files.

    Returns bytes in memory, not an exported/buildable CLI. A future executor must
    consume the validated snapshot, never reread mutable paths after validation.
    """
    root = Path(root)
    require(root.is_absolute(), 'Absolute reviewed context required')
    for parent in (root, *root.parents):
        require(not parent.is_symlink(), 'Symlinked context forbidden')
    require({p.name for p in root.glob('Dockerfile.*')} ==
            {f'Dockerfile.{name}' for name in IMAGES}, 'Unexpected Dockerfile or ignore override')
    result = {}
    for name in CONTEXT_FILES:
        path = root / name
        require(not path.parent.is_symlink(), 'Symlinked context parent forbidden')
        metadata = path.lstat()
        require(stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1
                and stat.S_IMODE(metadata.st_mode) in (0o600, 0o644), 'Unsafe context file')
        require(metadata.st_size <= 1000000, 'Oversized context file')
        result[name] = path.read_bytes()
    return result


def context_archive(files):
    """Deterministic USTAR snapshot: reviewed bytes, uid/gid/mtime=0, mode=0644."""
    require(set(files) == set(CONTEXT_FILES), 'Unexpected context members')
    require(files['.dockerignore'] == ('\n'.join(CONTEXT_RULES) + '\n').encode(),
            'Context allowlist changed')
    for component in IMAGES:
        validate_dockerfile(files[f'Dockerfile.{component}'], component, files)
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode='w', format=tarfile.USTAR_FORMAT) as archive:
        directory = tarfile.TarInfo('evidence')
        directory.type = tarfile.DIRTYPE
        directory.mode = 0o755
        archive.addfile(directory)
        for name in CONTEXT_FILES:
            entry = tarfile.TarInfo(name)
            entry.size = len(files[name])
            entry.mode = 0o644
            archive.addfile(entry, io.BytesIO(files[name]))
    return stream.getvalue()


def verify_context(files, inventory):
    archive = context_archive(files)
    require(inventory['checkpoint'] == CHECKPOINT, 'Wrong context checkpoint')
    actual = {name: {'sha256': digest(data), 'size': len(data), 'mode': '0644'}
              for name, data in files.items()}
    require(actual == inventory['files'], 'Context differs from reviewed snapshot')
    require(digest(archive) == inventory['archive_sha256']
            and len(archive) == inventory['archive_size'], 'Context archive differs')
    return archive


def output_identity(run, component, context_hash):
    """Future image identity only; labels are not proof of ownership or authority."""
    require(type(run) is RunIdentity and component in IMAGES, 'Invalid build identity')
    require(type(context_hash) is str and re.fullmatch('[0-9a-f]{64}', context_hash),
            'Invalid context hash')
    return {
        'tag': f'grocery-harness-{run.nonce}-{component}:task2',
        'labels': {LABEL_PREFIX + 'owner': OWNER, LABEL_PREFIX + 'run': run.nonce,
                   LABEL_PREFIX + 'kind': 'image', LABEL_PREFIX + 'component': component,
                   LABEL_PREFIX + 'context-sha256': context_hash,
                   LABEL_PREFIX + 'base-manifest': PINNED_DIGESTS[component]},
    }


def require_build_ready():
    raise SafetyError('Task #4A is preflight only; daemon binding and cache isolation remain unresolved')
