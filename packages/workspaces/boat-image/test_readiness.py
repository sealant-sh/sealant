from contextlib import contextmanager
import json
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

import guest_boot as guest
import guest_invocation as invocation
import guest_network as network
import guest_readiness as ready
import guest_receiver as receiver
from guest_contract import canonical, digest


class ReadinessTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix='boat-readiness-'))
        self.runtime = self.root / 'runtime'
        self.runtime.mkdir(mode=0o700)
        self.addCleanup(self.cleanup)
        self.enterContext(patch.object(guest, 'ROOT', self.root))
        self.enterContext(patch.object(receiver, 'RUNTIME', self.runtime))
        self.binding = {'identity': {'deployment_id': 'local', 'instance_id': 'bx_test', 'disk_lineage': 'disk'},
                        'boot_id': 'boot', 'epoch': 1, 'operation_id': 'launch'}
        self.enterContext(patch.object(invocation, 'binding', return_value=self.binding))
        guest.save(network.record_path(), {'config': {'gateway_key': 'public'}})
        self.request = {'format': 'sealant-execution-permit-v2', 'binding': self.binding,
                        'resource_receipt': digest(network.record_path().read_bytes()),
                        'tunnel_receipt': 'b' * 64, 'limits': ready.LIMITS}

    def cleanup(self):
        print(json.dumps({'ownedScratch': str(self.root), 'entries': sorted(str(item.relative_to(self.root)) for item in self.root.rglob('*'))}))
        shutil.rmtree(self.root)
        self.assertFalse(self.root.exists())

    @contextmanager
    def isolated(self):
        with patch.object(receiver, 'require_tmpfs'), patch.object(receiver, 'revalidate_execution', return_value=[]), \
             patch.object(guest, 'run'), patch.object(ready, 'limits', return_value='/sealant.slice/sealant-workspace.slice'), \
             patch.object(ready, 'peer', return_value={'dns': 'udp-and-tcp', 'nonce': 'd' * 32}):
            yield

    def test_permit_is_exact_replay_and_keeps_admission_held(self):
        with self.isolated():
            first = ready.permit(self.request)
            self.assertEqual(first, ready.permit(self.request))
            self.assertEqual(first['receipt'], digest(canonical(self.request)))
            self.assertEqual(first['handshake'], 'verified')
            self.assertEqual(first['admission'], 'held')
            for change in ({'tunnel_receipt': 'c' * 64}, {'resource_receipt': 'd' * 64},
                           {'binding': {**self.binding, 'boot_id': 'clone'}}, {'limits': {**ready.LIMITS, 'tasks': 513}}):
                with self.subTest(change=change), self.assertRaises(receiver.Refusal):
                    ready.permit({**self.request, **change})
            self.assertEqual(guest.private_json(ready.permit_path()), self.request)

    def test_each_missing_policy_refuses_before_permit(self):
        for owner, method in ((receiver, 'revalidate_execution'), (ready, 'limits'), (ready, 'peer')):
            with self.subTest(method=method), self.isolated(), patch.object(owner, method, side_effect=ValueError('refused')):
                with self.assertRaises(ValueError):
                    ready.permit(self.request)
                self.assertFalse(ready.permit_path().exists())

    def test_lost_permit_reply_reuses_original_file_and_write_failure_grants_nothing(self):
        with self.isolated(), patch.object(guest, 'save', side_effect=OSError('disk full')):
            with self.assertRaises(OSError):
                ready.permit(self.request)
        self.assertFalse(ready.permit_path().exists())
        with self.isolated():
            ready.permit(self.request)
            inode = ready.permit_path().stat().st_ino
            ready.permit(self.request)
            self.assertEqual(ready.permit_path().stat().st_ino, inode)

    def test_peer_requires_actual_udp_tcp_roundtrip_then_expected_handshake(self):
        record = {'config': {'gateway_key': 'public'}}
        def command(program, *args, **kwargs):
            self.assertTrue(kwargs['inside'])
            if program.endswith('python3'):
                self.assertIn('socket.SOCK_DGRAM,socket.SOCK_STREAM', args[-1])
                return json.dumps({'dns': 'udp-and-tcp', 'nonce': 'a' * 32})
            return 'public\t123'
        with patch.object(network, 'verify', return_value=record), patch.object(network, 'command', side_effect=command):
            self.assertEqual(ready.peer(self.binding)['dns'], 'udp-and-tcp')
        for reply in ('public\t0', 'other\t123', '', 'public\t-1'):
            with self.subTest(reply=reply), patch.object(network, 'verify', return_value=record), \
                 patch.object(network, 'command', side_effect=[json.dumps({'dns': 'udp-and-tcp', 'nonce': 'a' * 32}), reply]):
                with self.assertRaisesRegex(receiver.Refusal, 'tunnel-handshake-unavailable'):
                    ready.peer(self.binding)

    def test_kernel_limits_and_systemd_properties_must_both_match(self):
        group = self.root / ready.SLICE
        group.mkdir()
        files = {'cpu.max': '100000 100000', 'memory.max': '2147483648', 'memory.swap.max': '0', 'pids.max': '512'}
        properties = 'ControlGroup=/' + ready.SLICE + '\nMemoryMax=2147483648\nMemorySwapMax=0\nTasksMax=512\nCPUQuotaPerSecUSec=1s'
        for name, value in files.items():
            (group / name).write_text(value)
        with patch.object(ready, 'CGROUP', self.root), patch.object(guest, 'run', return_value=properties):
            self.assertEqual(ready.limits(), '/' + ready.SLICE)
            for name, value in files.items():
                (group / name).write_text('max' if name != 'cpu.max' else '200000 100000')
                with self.subTest(file=name), self.assertRaises(receiver.Refusal):
                    ready.limits()
                (group / name).write_text(value)
            for field in properties.splitlines():
                with patch.object(guest, 'run', return_value=properties.replace(field, field.split('=')[0] + '=infinity')), self.assertRaises((receiver.Refusal, FileNotFoundError)):
                    ready.limits()

    def test_readiness_requires_running_invocation_inside_the_slice(self):
        group = '/sealant.slice/sealant-workspace.slice'
        owner = {'systemd_invocation': 'd' * 32, 'process': {'cgroup': '0::' + group + '/sealant-workspace.service'}}
        record = {'owner': owner, 'launcher': {'cgroup': '0::' + group + '/sealant-native-workspace.service'},
                  'gate': {'cgroup': '0::' + group + '/sealant-native-workspace.service/payload'}}
        request = {'format': 'sealant-readiness-v1', 'binding': self.binding, 'permit_receipt': digest(canonical(self.request))}
        with self.isolated(), patch.object(ready, 'verify_permit', return_value=self.request), \
             patch.object(invocation, 'observe', return_value='running'), patch.object(invocation, 'state', return_value=record):
            self.assertEqual(ready.readiness(request)['invocation'], 'd' * 32)
            with patch.object(invocation, 'observe', return_value='unresolved'), self.assertRaises(receiver.Refusal):
                ready.readiness(request)
            with patch.object(invocation, 'state', return_value={**record, 'gate': {'cgroup': '0::/elsewhere'}}), self.assertRaisesRegex(receiver.Refusal, 'workspace-outside-limits'):
                ready.readiness(request)
            for change in ({'permit_receipt': 'c' * 64}, {'binding': {**self.binding, 'epoch': 2}}):
                with self.subTest(change=change), self.assertRaises(receiver.Refusal):
                    ready.readiness({**request, **change})

    def test_running_network_replay_does_not_rerun_held_boot(self):
        guest.save(invocation.path(), {'binding': self.binding})
        process = type('Held', (), {'close': lambda self: None})()
        with patch.object(invocation, 'state', return_value={'binding': self.binding}), \
             patch.object(invocation, 'observe', return_value='running'), \
             patch.object(guest, 'private_json', return_value={}), patch.object(receiver.ProtectedManifest, 'parse', return_value=type('Manifest', (), {})()), \
             patch.object(guest, 'verify_protected'), patch.object(guest, 'HeldProcess', return_value=process), \
             patch.object(guest, 'revalidate', side_effect=AssertionError('held boot cannot approve running work')):
            self.assertEqual(receiver.revalidate_execution(), [process])
            with patch.object(invocation, 'observe', return_value='unresolved'), self.assertRaises(receiver.Refusal):
                receiver.revalidate_execution()


if __name__ == '__main__':
    unittest.main()
