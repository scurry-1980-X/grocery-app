"""Offline #4A verification; no Docker calls, downloads or SQL execution."""
from copy import deepcopy
import io
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

from test_supabase_integration_stack import load, SUPPORT, safety, stack

preflight = load('grocery_build_preflight', SUPPORT / 'build_preflight.py')


class BuildPreflightTests(unittest.TestCase):
    def setUp(self):
        self.evidence = json.loads((preflight.REVIEW/'image-configs.json').read_bytes())
        self.inventory = json.loads((preflight.REVIEW/'context-snapshot.json').read_bytes())

    def test_six_configs_match_exact_reviewed_manifest_descriptors(self):
        configs = preflight.verify_configs(self.evidence)
        self.assertEqual(set(configs), set(stack.IMAGES))
        for config in configs.values():
            self.assertEqual((config['os'], config['architecture']), ('linux', 'amd64'))
            self.assertIn(config['config'].get('OnBuild'), (None, []))
            self.assertIn(config['config'].get('Volumes'), (None, {}))

    def test_config_body_tampering_cannot_retain_digest(self):
        for field, value in [('OnBuild', ['RUN false']), ('Volumes', {'/foreign': {}}),
                             ('Entrypoint', ['/foreign'])]:
            changed = deepcopy(self.evidence)
            body = json.loads(changed['records'][0]['body'])
            body['config'][field] = value
            changed['records'][0]['body'] = json.dumps(body)
            with self.assertRaises(safety.SafetyError): preflight.verify_configs(changed)

    def test_missing_duplicate_or_foreign_config_inventory_rejected(self):
        for operation in ('missing', 'duplicate', 'foreign'):
            changed = deepcopy(self.evidence)
            if operation == 'missing': changed['records'].pop()
            elif operation == 'duplicate': changed['records'][0] = changed['records'][1]
            else: changed['records'][0]['reference'] = 'foreign:latest'
            with self.assertRaises(safety.SafetyError): preflight.verify_configs(changed)

    def test_changed_descriptor_platform_pin_or_source_rejected(self):
        for key, value in [('digest', 'sha256:'+'0'*64), ('size', 1),
                           ('manifest_digest', 'sha256:'+'0'*64),
                           ('media_type', 'application/octet-stream'),
                           ('url', 'https://foreign.invalid/config')]:
            changed = deepcopy(self.evidence)
            changed['records'][0][key] = value
            with self.assertRaises(safety.SafetyError): preflight.verify_configs(changed)

    def test_acquisition_flags_fail_closed(self):
        for key in ('layers_fetched', 'account_credentials_used', 'anonymous_tokens_persisted'):
            changed = deepcopy(self.evidence)
            changed[key] = True
            with self.assertRaises(safety.SafetyError): preflight.verify_configs(changed)

    def test_context_matches_checkpoint_inventory_and_archive(self):
        files = preflight.capture_context()
        data = preflight.verify_context(files, self.inventory)
        self.assertEqual(len(files), 15)
        self.assertEqual(data, preflight.context_archive(dict(reversed(list(files.items())))))
        with tarfile.open(fileobj=io.BytesIO(data)) as archive:
            self.assertEqual(set(archive.getnames()), {*preflight.CONTEXT_FILES, 'evidence'})
            for item in archive:
                self.assertEqual((item.uid, item.gid, item.mtime), (0, 0, 0))
                self.assertFalse(item.issym() or item.islnk() or item.isdev())
                if item.isfile(): self.assertEqual(archive.extractfile(item).read(), files[item.name])
        self.assertNotIn('evidence/registry-manifests.json', files)
        self.assertNotIn('provenance.json', files)

    def test_context_byte_drift_rejected(self):
        files = preflight.capture_context()
        for name in ('common.sh', 'evidence/realtime.sql', 'Dockerfile.db'):
            changed = dict(files)
            changed[name] += b'\n'
            with self.assertRaises(safety.SafetyError): preflight.verify_context(changed, self.inventory)

    def test_extra_missing_or_traversal_archive_members_rejected(self):
        files = preflight.capture_context()
        for name in ('../secret', '/tmp/secret', 'evidence/secret', 'Dockerfile.extra'):
            changed = {**files, name: b'secret'}
            with self.assertRaises(safety.SafetyError): preflight.context_archive(changed)
        files.pop('common.sh')
        with self.assertRaises(safety.SafetyError): preflight.context_archive(files)

    def test_copy_escape_and_add_forms_rejected(self):
        files = preflight.capture_context()
        base = files['Dockerfile.db']
        for line in ('COPY ../secret /harness/', 'COPY /etc/passwd /harness/',
                     'COPY https://foreign.invalid/x /harness/', 'COPY . /harness/',
                     'COPY *.sh /harness/', 'COPY $INPUT /harness/',
                     'COPY --from=foreign /x /harness/', 'COPY common.sh /harness/../x',
                     'COPY ["common.sh", "/harness/"]', 'ADD common.sh /harness/',
                     'RUN --mount=type=bind,source=/,target=/host true',
                     'RUN --network=host true', '# syntax=foreign/frontend:latest'):
            with self.subTest(line=line), self.assertRaises(safety.SafetyError):
                preflight.validate_dockerfile(base+b'\n'+line.encode()+b'\n', 'db', files)

    def test_symlinks_hardlinks_special_files_and_ignore_overrides_rejected(self):
        for kind in ('file-link', 'directory-link', 'root-link', 'hardlink', 'ignore', 'fifo'):
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)/'stack'
                shutil.copytree(stack.STACK, root)
                target = root/'common.sh'
                if kind == 'file-link':
                    target.unlink(); target.symlink_to(stack.STACK/'common.sh')
                elif kind == 'directory-link':
                    shutil.rmtree(root/'evidence'); (root/'evidence').symlink_to(stack.STACK/'evidence')
                elif kind == 'root-link':
                    link = Path(directory)/'link'; link.symlink_to(root); root = link
                elif kind == 'hardlink': os.link(target, Path(directory)/'alias')
                elif kind == 'ignore': (root/'Dockerfile.db.dockerignore').write_text('!**\n')
                else: target.unlink(); os.mkfifo(target)
                with self.subTest(kind=kind), self.assertRaises(safety.SafetyError):
                    preflight.capture_context(root)

    def test_allowlist_widening_fails(self):
        files = preflight.capture_context()
        files['.dockerignore'] += b'!**\n'
        with self.assertRaises(safety.SafetyError): preflight.context_archive(files)

    def test_output_identity_matches_existing_nonce_names_and_adds_image_labels(self):
        run = safety.RunIdentity.new()
        context_hash = self.inventory['archive_sha256']
        for component in stack.IMAGES:
            output = preflight.output_identity(run, component, context_hash)
            self.assertEqual(output['tag'], f'grocery-harness-{run.nonce}-{component}:task2')
            labels = output['labels']
            self.assertEqual(labels[safety.LABEL_PREFIX+'run'], run.nonce)
            self.assertEqual(labels[safety.LABEL_PREFIX+'context-sha256'], context_hash)
            self.assertEqual(labels[safety.LABEL_PREFIX+'base-manifest'], stack.PINNED_DIGESTS[component])
        with self.assertRaises(safety.SafetyError): preflight.output_identity(run, 'foreign', context_hash)
        with self.assertRaises(safety.SafetyError): preflight.output_identity(run, 'db', 'not-a-hash')

    def test_historical_observations_never_grant_build_authority(self):
        observed = json.loads((preflight.REVIEW/'observations.json').read_bytes())
        self.assertFalse(observed['build_authorized'])
        self.assertFalse(observed['runtime_authorized'])
        self.assertFalse(observed['builder']['bootstrapped'])
        self.assertFalse(observed['builder']['cache_isolation_verified'])
        self.assertFalse(observed['daemon']['socket_fd_binding_verified'])
        self.assertEqual(observed['context_archive_sha256'], self.inventory['archive_sha256'])
        self.assertEqual(observed['image_config_evidence_sha256'],
                         preflight.digest((preflight.REVIEW/'image-configs.json').read_bytes()))
        with self.assertRaises(safety.SafetyError): preflight.require_build_ready()

    def test_offline_checks_use_no_network_processes_or_runtime(self):
        with patch.object(socket, 'socket', side_effect=AssertionError('network')), \
             patch.object(subprocess, 'Popen', side_effect=AssertionError('process')):
            preflight.verify_configs(self.evidence)
            preflight.verify_context(preflight.capture_context(), self.inventory)
            plan = stack.create_plan({})
            for service in plan['compose']['services'].values():
                self.assertEqual(service['entrypoint'], stack.DISABLED_ENTRYPOINT)
            with self.assertRaises(safety.SafetyError): stack.require_runtime_ready(plan)


if __name__ == '__main__':
    unittest.main()
