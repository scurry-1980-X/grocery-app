"""Task #3A evidence verification is entirely offline; SQL/JSON are read as bytes."""
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]
STACK = ROOT / 'tests/supabase_integration/stack'
EVIDENCE = STACK / 'evidence'
INDEX = 'application/vnd.oci.image.index.v1+json'
MANIFEST_TYPES = {'application/vnd.oci.image.manifest.v1+json',
                  'application/vnd.docker.distribution.manifest.v2+json'}
SERVICES = {'db','auth','rest','realtime','gateway','mail'}


def require(condition):
    if not condition:
        raise ValueError('Inconsistent upstream evidence')


def body(record):
    raw = record['body'].encode('utf-8')
    digest = 'sha256:' + hashlib.sha256(raw).hexdigest()
    require(record['digest'] == record['docker_content_digest'] == digest)
    require(record['size'] == len(raw))
    parsed = json.loads(raw)
    require(parsed['schemaVersion'] == 2 and parsed['mediaType'] == record['media_type'])
    return parsed


def verify_registry(evidence, provenance):
    records = evidence['records']
    require(len(records) == 6 and {r['service'] for r in records} == SERVICES)
    require(evidence['account_credentials_used'] is False)
    require(evidence['anonymous_registry_tokens_persisted'] is False)
    require(evidence['layers_fetched'] is False and evidence['image_configs_fetched'] is False)
    require(evidence['docker_used'] is False)
    count = 0
    for record in records:
        image = provenance['images'][record['service']]
        require(record['reference'] == image['reference'])
        repo, tag = record['reference'].rsplit(':', 1)
        base = 'https://registry-1.docker.io/v2/' + repo + '/manifests/'
        require(record['repository'] == repo and record['registry'] == 'registry-1.docker.io')
        require(record['tag_url'] == base + tag)
        require(record['index_url'] == base + image['digest'])
        require(record['index']['media_type'] == INDEX)
        index = body(record['index'])
        require(record['index']['digest'] == image['digest'] == record['index']['immutable_response_digest'])
        require(image['digest_kind'] == 'oci_image_index')
        manifests = record['verified_platform_manifests']
        require(len(manifests) == 2)
        seen = set()
        for manifest in manifests:
            platform = manifest['platform']
            require(platform['os'] == 'linux' and platform['architecture'] in ('amd64','arm64'))
            key = platform['os'] + '/' + platform['architecture']
            require(key not in seen)
            seen.add(key)
            matches = [d for d in index['manifests'] if d.get('platform') == platform]
            require(len(matches) == 1)
            desc, = matches
            require(desc['digest'] == manifest['digest'])
            require(desc['size'] == manifest['size'] and desc['mediaType'] == manifest['media_type'])
            require(manifest['media_type'] in MANIFEST_TYPES and manifest['url'] == base + desc['digest'])
            child = body(manifest)
            recorded = image['platform_manifests'][key]
            require(recorded['digest'] == desc['digest'] and recorded['platform'] == platform)
            require(recorded['media_type'] == desc['mediaType'])
            require(recorded['config_digest'] == child['config']['digest'])
            require(recorded['config_fetched'] is False and recorded['manifest_verified'] is True)
            for descriptor in [child['config'], *child['layers']]:
                require(re.fullmatch(r'sha256:[0-9a-f]{64}', descriptor['digest']) is not None)
                require(type(descriptor['size']) is int and descriptor['size'] > 0)
            count += 1
        require(seen == {'linux/amd64','linux/arm64'})
        require(image['platform'] == 'linux/amd64')
        require(image['selected_platform_digest'] == image['platform_manifests']['linux/amd64']['digest'])
        require(image['source_commit_to_published_image_binding_verified'] is False)
    require(count == 12)


class UpstreamProvenanceTests(unittest.TestCase):
    def setUp(self):
        self.provenance = json.loads((STACK/'provenance.json').read_text())
        self.evidence = json.loads((EVIDENCE/'registry-manifests.json').read_text())

    def test_eighteen_raw_registry_bodies_validate_complete_digest_chain(self):
        verify_registry(self.evidence, self.provenance)
        task = self.provenance['task3a']
        self.assertEqual(task['index_count'], 6)
        self.assertEqual(task['verified_platform_manifest_count'], 12)
        self.assertEqual(hashlib.sha256((EVIDENCE/'registry-manifests.json').read_bytes()).hexdigest(),
                         task['registry_evidence_sha256'])

    def test_exact_realtime_source_bytes_and_provenance(self):
        source = (EVIDENCE/'realtime.sql').read_bytes()
        self.assertEqual(len(source), 117)
        self.assertEqual(hashlib.sha256(source).hexdigest(),
                         '7e9e442e7fc4dae05544c07b67bede37a00d84644304dfce4d937134cb4c8f88')
        self.assertEqual(source.decode().splitlines(), [
            r'\set pguser `echo "$POSTGRES_USER"`', '',
            'create schema if not exists _realtime;', 'alter schema _realtime owner to :pguser;'])
        self.assertEqual(source.count(b'\n'), 4)
        self.assertNotIn(b'\r', source)
        record, = self.provenance['resolved_sources']
        self.assertEqual(record['source_commit'], 'e854b84ed4517b0f21a1acd0a0abdd8a8d5cb9a7')
        self.assertEqual(record['source_path'], 'docker/volumes/db/realtime.sql')
        self.assertEqual(record['local_path'], 'evidence/realtime.sql')
        self.assertEqual(record['size'], len(source))
        self.assertEqual(record['sha256'], hashlib.sha256(source).hexdigest())
        self.assertEqual(record['git_blob_sha1_derived'],
                         hashlib.sha1(b'blob 117\0' + source).hexdigest())
        self.assertIs(record['runtime_installed'], False)
        self.assertIs(record['github_page_commit_and_lines_match'], True)
        self.assertEqual((EVIDENCE/'.gitattributes').read_text(), 'realtime.sql -text\n')

    def test_runtime_files_and_safety_baselines_remain_byte_identical(self):
        expected = {**self.provenance['unchanged_files'],
                    **self.provenance['task3b']['unchanged_files']}
        self.assertIn('tests/supabase_integration/stack/postgres.sh', expected)
        self.assertIn('tests/supabase_integration/stack/evidence/realtime.sql', expected)
        for name, digest in expected.items():
            with self.subTest(path=name):
                self.assertEqual(hashlib.sha256((ROOT/name).read_bytes()).hexdigest(), digest)
        self.assertEqual(self.provenance['status'], 'CONFIGURATION_ONLY_RUNTIME_DISABLED')
        # Only the exact SQL source, not registry metadata, enters the context.
        ignore = (STACK/'.dockerignore').read_text().splitlines()
        self.assertEqual(ignore[0], '**')
        self.assertEqual(ignore[-3:], ['!evidence/', 'evidence/**', '!evidence/realtime.sql'])
        self.assertNotIn('!evidence/registry-manifests.json', ignore)
        self.assertIn('COPY evidence/realtime.sql /docker-entrypoint-initdb.d/migrations/99-realtime.sql',
                      (STACK/'Dockerfile.db').read_text())
        for path in STACK.glob('Dockerfile.*'):
            if path.name != 'Dockerfile.db':
                self.assertNotIn('realtime.sql', path.read_text())

    def test_mutated_raw_body_cannot_keep_recorded_digest(self):
        for key in ('index', 'child'):
            changed = deepcopy(self.evidence)
            record = changed['records'][0]
            target = record['index'] if key == 'index' else record['verified_platform_manifests'][0]
            target['body'] += '\n'
            with self.subTest(key=key), self.assertRaises(ValueError):
                verify_registry(changed, self.provenance)

    def test_wrong_tag_index_platform_or_config_identity_rejected(self):
        for field in ('digest','selected_platform_digest','config_digest'):
            changed = deepcopy(self.provenance)
            image = changed['images']['db']
            if field == 'config_digest': image = image['platform_manifests']['linux/amd64']
            image[field] = 'sha256:'+'0'*64
            with self.subTest(field=field), self.assertRaises(ValueError):
                verify_registry(self.evidence, changed)
        changed = deepcopy(self.evidence)
        changed['records'][0]['tag_url'] = 'https://foreign.invalid/manifest'
        with self.assertRaises(ValueError): verify_registry(changed, self.provenance)

    def test_missing_duplicate_or_attestation_platform_cannot_count_as_verified_image(self):
        for mode in ('missing','duplicate','attestation'):
            changed = deepcopy(self.evidence)
            manifests = changed['records'][0]['verified_platform_manifests']
            if mode == 'missing': manifests.pop()
            elif mode == 'duplicate': manifests[1] = deepcopy(manifests[0])
            else: manifests[1]['platform'] = {'os':'unknown','architecture':'unknown'}
            with self.subTest(mode=mode), self.assertRaises(ValueError):
                verify_registry(changed, self.provenance)

    def test_response_digest_or_size_mismatch_rejected(self):
        for field, value in (('docker_content_digest','sha256:'+'f'*64), ('size',0)):
            changed = deepcopy(self.evidence)
            changed['records'][0]['index'][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                verify_registry(changed, self.provenance)

    def test_publisher_architecture_labels_are_distinct_from_unverified_attestations(self):
        for record in self.evidence['records']:
            index = json.loads(record['index']['body'])
            for desc in index['manifests']:
                if desc['platform']['architecture'] == 'unknown':
                    self.assertEqual(desc['annotations']['vnd.docker.reference.type'], 'attestation-manifest')
        rest = next(r for r in self.evidence['records'] if r['service']=='rest')
        kinds = {r['platform']['architecture']:r['media_type'] for r in rest['verified_platform_manifests']}
        self.assertEqual(kinds['amd64'], 'application/vnd.docker.distribution.manifest.v2+json')
        self.assertEqual(kinds['arm64'], 'application/vnd.oci.image.manifest.v1+json')
        mail = next(r for r in self.evidence['records'] if r['service']=='mail')
        self.assertIn({'architecture':'386','os':'linux'},
                      [d['platform'] for d in json.loads(mail['index']['body'])['manifests']])


if __name__ == '__main__':
    unittest.main()
