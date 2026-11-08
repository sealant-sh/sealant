import copy
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

import guest_boot as guest
import guest_capsule as capsule
import guest_parking as parking
import guest_receiver as receiver
import guest_resume as resume


class ResumeTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix='boat-cold-resume.'))
        self.addCleanup(self.cleanup)
        self.enterContext(patch.object(guest, 'ROOT', self.root))
        self.enterContext(patch.object(guest, 'boot_id', return_value='new-boot'))
        self.enterContext(patch.object(guest, 'census', return_value={'processes': []}))
        self.source_request = {'format': 'sealant-parking-close-v1',
            'binding': {'identity': {'deployment_id': 'local', 'instance_id': 'source', 'disk_lineage': 'old'},
                        'boot_id': 'old-boot', 'epoch': 1, 'operation_id': 'original'},
            'operation_id': '00000000-0000-4000-8000-000000000001'}
        (self.root / 'capsules').mkdir(mode=0o700)
        source = self.root / 'source'
        (source / 'tmp').mkdir(parents=True)
        (source / 'tmp/unsent').write_bytes(b'never uploaded')
        fd = os.open(source, os.O_RDONLY | os.O_DIRECTORY)
        try:
            receipt = capsule.export(fd, [{'path': '/tmp', 'exclude': []}],
                                     parking.directory(self.source_request), self.source_request)
        finally:
            os.close(fd)
        guest.save(parking.path(), {'format': 'sealant-parking-state-v1', 'request': self.source_request,
                   'phase': 'closed', 'source': {'group': 'old', 'cgroup_identity': [], 'gate': {}},
                   'volumes': [], 'capsule': receipt})
        guest.save(self.root / 'receiver.json', {'format': 'sealant-receiver-v1',
                   'identity': self.source_request['binding']['identity'], 'admission': None})
        guest.save(self.root / 'invocation.json', {'historical': True})
        self.request = {'format': 'sealant-parking-rebind-v1', 'source_request': self.source_request,
            'capsule': receipt, 'identity': {'deployment_id': 'local', 'instance_id': 'child', 'disk_lineage': 'fresh'},
            'boot_id': 'new-boot', 'operation_id': '00000000-0000-4000-8000-000000000002',
            'capture_launch_id': 'original-capture-launch'}

    def cleanup(self):
        print(json.dumps({'ownedScratch': str(self.root), 'entries': sorted(str(p.relative_to(self.root)) for p in self.root.rglob('*'))}))
        shutil.rmtree(self.root)
        self.assertFalse(self.root.exists())

    def test_rebind_restores_exact_volatile_bytes_preserves_history_and_replays_exactly(self):
        result = resume.rebind(self.request)
        self.assertEqual(result['admission'], 'held')
        self.assertEqual(result, resume.rebind(self.request))
        self.assertFalse(parking.path().exists())
        self.assertFalse((self.root / 'invocation.json').exists())
        self.assertEqual(guest.private_json(self.root / ('history-' + self.request['operation_id']) / 'invocation.json'), {'historical': True})
        self.assertEqual(receiver.disk_state()['identity'], self.request['identity'])
        mount = resume.mounts()[0]
        self.assertEqual(mount['path'], '/tmp')
        self.assertEqual((Path(mount['source']) / 'unsent').read_bytes(), b'never uploaded')

    def test_wrong_bytes_and_live_writer_refuse_before_rebinding(self):
        original = (self.root / 'receiver.json').read_bytes()
        with patch.object(guest, 'census', return_value={'processes': [1]}), self.assertRaisesRegex(receiver.Refusal, 'existing-writer'):
            resume.rebind(self.request)
        with self.assertRaisesRegex(receiver.Refusal, 'source-conflict'):
            resume.rebind({**self.request, 'capsule': {**self.request['capsule'], 'archive_sha256': 'f' * 64}})
        self.assertEqual((self.root / 'receiver.json').read_bytes(), original)
        self.assertFalse(resume.path().exists())

    def test_fresh_id_cannot_replace_a_reserved_child_and_hooks_cannot_replay(self):
        resume.rebind(self.request)
        with self.assertRaisesRegex(receiver.Refusal, 'conflict'):
            resume.rebind({**self.request, 'identity': {**self.request['identity'], 'instance_id': 'another'}})
        env = {'SEALANT_WORKSPACE_SOURCE': 'capture', 'SEALANT_CAPTURE_LAUNCH_ID': 'original-capture-launch',
               'SEALANT_LIFECYCLE_SETUP_JSON': '[]', 'SEALANT_LIFECYCLE_STARTUP_JSON': '[]',
               'SEALANT_FOREGROUND_COMMAND': 'sleep infinity'}
        resume.validate_launch({'boot_env': env})
        for key, value in [('SEALANT_LIFECYCLE_SETUP_JSON', '[{"run":"bad"}]'),
                           ('SEALANT_DOTFILES_REPOSITORY', 'bad'), ('SEALANT_CAPTURE_LAUNCH_ID', 'fresh')]:
            with self.subTest(key=key), self.assertRaisesRegex(receiver.Refusal, 'replays-user-code'):
                resume.validate_launch({'boot_env': {**env, key: value}})

    def test_partial_history_move_reconciles_the_original_intent(self):
        rename = os.rename
        calls = 0
        def fail_once(source, destination):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError('crash before history completed')
            return rename(source, destination)
        with patch.object(os, 'rename', side_effect=fail_once), self.assertRaises(OSError):
            resume.rebind(self.request)
        self.assertEqual(guest.private_json(resume.path())['phase'], 'preparing')
        self.assertEqual(resume.rebind(self.request)['admission'], 'held')
        self.assertEqual(receiver.disk_state()['identity'], self.request['identity'])

    def test_second_cold_cycle_requires_a_new_positive_closed_writer_receipt(self):
        resume.rebind(self.request)
        second_source = {**self.source_request, 'operation_id': '00000000-0000-4000-8000-000000000003',
                         'binding': {**self.source_request['binding'], 'identity': self.request['identity'],
                                     'boot_id': 'new-boot'}}
        second = {**self.request, 'operation_id': '00000000-0000-4000-8000-000000000004',
                  'source_request': second_source, 'boot_id': 'third-boot',
                  'identity': {**self.request['identity'], 'instance_id': 'third', 'disk_lineage': 'third'}}
        with patch.object(guest, 'boot_id', return_value='third-boot'):
            with self.assertRaisesRegex(receiver.Refusal, 'conflict'):
                resume.rebind(second)
            fd = os.open(self.root / 'source', os.O_RDONLY | os.O_DIRECTORY)
            try:
                receipt = capsule.export(fd, [{'path': '/tmp', 'exclude': []}], parking.directory(second_source), second_source)
            finally:
                os.close(fd)
            second['capsule'] = receipt
            guest.save(parking.path(), {'format': 'sealant-parking-state-v1', 'request': second_source,
                       'phase': 'closed', 'source': {'group': 'old', 'cgroup_identity': [], 'gate': {}}, 'volumes': [], 'capsule': receipt})
            self.assertEqual(resume.rebind(second)['identity'], second['identity'])
            self.assertEqual((Path(resume.mounts()[0]['source']) / 'unsent').read_bytes(), b'never uploaded')
            self.assertTrue((self.root / ('resume-history-' + self.request['operation_id'] + '.json')).is_file())


if __name__ == '__main__':
    unittest.main()
