from contextlib import contextmanager
from dataclasses import asdict
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

import guest_boot as guest
import guest_capsule as capsule
import guest_invocation as invocation
import guest_parking as parking
import guest_readiness as readiness
import guest_receiver as receiver
import guest_recovery as recovery


class ParkingTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix='boat-parking-test.'))
        self.addCleanup(self.cleanup)
        self.enterContext(patch.object(guest, 'ROOT', self.root))
        self.binding = {'identity': {'deployment_id': 'deployment', 'instance_id': 'bx_source', 'disk_lineage': 'disk'},
                        'boot_id': 'boot', 'epoch': 1, 'operation_id': 'launch'}
        self.request = parking.request_for(self.binding, '00000000-0000-4000-8000-000000000001')
        self.gate = guest.identity(os.getpid())
        self.group = '/sealant-workspace.slice'
        self.enterContext(patch.object(invocation, 'binding', return_value=self.binding))
        self.enterContext(patch.object(invocation, 'observe', return_value='running'))
        self.enterContext(patch.object(invocation, 'state', return_value={'gate': asdict(self.gate)}))
        self.enterContext(patch.object(readiness, 'limits', return_value=self.group))
        self.enterContext(patch.object(readiness, 'CGROUP', self.root))
        (self.root / readiness.SLICE).mkdir()

    def cleanup(self):
        print(json.dumps({'ownedScratch': str(self.root), 'entries': sorted(str(p.relative_to(self.root))
                                                                          for p in self.root.rglob('*'))}))
        shutil.rmtree(self.root)
        self.assertFalse(self.root.exists())

    @contextmanager
    def system(self, fail=None):
        calls = []
        gate = asdict(self.gate)
        gate['cgroup'] = '0::' + self.group + '/owned'
        identity = type(self.gate)(**gate)
        root = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY)
        self.addCleanup(os.close, root)
        class Writers:
            def __init__(_, record):
                self.assertTrue(parking.path().exists())
                self.assertEqual(record, parking.state())
                calls.append('frozen')
            def __enter__(_):
                _.root = root
                return _
            def __exit__(_, *args):
                pass
            def close(_):
                self.assertEqual(parking.state()['phase'], 'exported')
                self.assertTrue((parking.directory(self.request) / 'manifest.json').exists())
                calls.append('killed')
                if fail == 'kill':
                    raise OSError('lost kill reply')
        with patch.object(guest, 'identity', return_value=identity), patch.object(guest, 'census', return_value={'processes': []}), \
                patch.object(parking, 'Writers', Writers), patch.object(capsule, 'plan', return_value=[]), \
                patch.object(os, 'sync', side_effect=lambda: calls.append('sync')):
            yield calls

    def test_freeze_export_commit_kill_sync_close_order_and_exact_replay(self):
        with self.system() as calls:
            result = parking.close(self.request)
            self.assertEqual(calls, ['frozen', 'killed', 'sync'])
            self.assertEqual(result['writers'], 'closed')
            self.assertEqual(result['capsule']['bytes'], 0)
            self.assertGreater(result['capsule']['stored_bytes'], 0)
            self.assertEqual(parking.close(self.request), result)
            self.assertEqual(calls, ['frozen', 'killed', 'sync'])

    def test_conflicting_request_never_replays_close(self):
        with self.system() as calls:
            parking.close(self.request)
            with self.assertRaisesRegex(receiver.Refusal, 'intent-conflict'):
                parking.close({**self.request, 'operation_id': '00000000-0000-4000-8000-000000000002'})
            self.assertEqual(calls, ['frozen', 'killed', 'sync'])

    def test_wrong_binding_refuses_before_writer_exclusion(self):
        with self.system() as calls, self.assertRaisesRegex(receiver.Refusal, 'binding-conflict'):
            parking.close({**self.request, 'binding': {**self.binding, 'epoch': 2}})
        self.assertEqual(calls, [])
        self.assertFalse(parking.path().exists())

    def test_unknown_kill_keeps_exported_state_and_adopts_same_capsule(self):
        with self.system(fail='kill'), self.assertRaises(OSError):
            parking.close(self.request)
        self.assertEqual(parking.state()['phase'], 'exported')
        original = (parking.directory(self.request) / 'manifest.json').read_bytes()
        with self.system() as calls:
            result = parking.close(self.request)
            self.assertEqual(calls, ['frozen', 'killed', 'sync'])
        self.assertEqual(result['phase'], 'closed')
        self.assertEqual((parking.directory(self.request) / 'manifest.json').read_bytes(), original)

    def test_barrier_closes_ordinary_stage_start_and_recovery(self):
        with self.system():
            parking.close(self.request)
        with self.assertRaisesRegex(receiver.Refusal, 'ordinary-invocation-closed'):
            invocation.start({})
        with self.assertRaisesRegex(receiver.Refusal, 'ordinary-invocation-closed'):
            invocation.run()
        with self.assertRaises(receiver.Refusal):
            recovery.start({})
        with self.assertRaises(receiver.Refusal):
            receiver.stage({})

    def test_incomplete_capsule_refuses_without_writer_kill(self):
        with self.system(fail='kill'), self.assertRaises(OSError):
            parking.close(self.request)
        (parking.directory(self.request) / 'manifest.json').unlink()
        with self.system() as calls, self.assertRaises(FileNotFoundError):
            parking.close(self.request)
        self.assertEqual(calls, ['frozen'])
        self.assertEqual(parking.state()['phase'], 'exported')

    def test_export_failure_keeps_durable_barrier_and_never_kills(self):
        with self.system() as calls, patch.object(capsule, 'export', side_effect=OSError('storage full')), \
                self.assertRaises(OSError):
            parking.close(self.request)
        self.assertEqual(calls, ['frozen'])
        self.assertEqual(parking.state()['phase'], 'closing')

    def test_uncontained_writer_refuses_before_barrier(self):
        with self.system(), patch.object(guest, 'census', return_value={'processes': [{'identity': {'cgroup': '0::/outside'}}]}), \
                self.assertRaisesRegex(receiver.Refusal, 'uncontained-workspace-writer'):
            parking.close(self.request)
        self.assertFalse(parking.path().exists())


if __name__ == '__main__':
    unittest.main()
