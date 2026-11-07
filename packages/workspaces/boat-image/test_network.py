import base64
from contextlib import contextmanager
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

import guest_boot as guest
import guest_network as network
from guest_contract import canonical


def config():
    return {'format': 'sealant-guest-network-v1', 'binding': {'boot_id': 'boot', 'epoch': 1},
            'private_key': base64.b64encode(b'a' * 32).decode(), 'public_key': base64.b64encode(b'b' * 32).decode(),
            'gateway_key': base64.b64encode(b'c' * 32).decode(), 'endpoint': '10.0.0.41', 'port': 40000, 'subnet': '10.33.0.0/27'}


class NetworkTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix='boat-network-unit-'))
        self.addCleanup(self.cleanup)
        self.enterContext(patch.object(guest, 'ROOT', self.root))
        self.enterContext(patch.object(guest, 'boot_id', return_value='boot'))
        self.config = config()
        self.binding = self.config['binding']

    def cleanup(self):
        print(json.dumps({'ownedScratch': str(self.root), 'entries': sorted(str(item.relative_to(self.root)) for item in self.root.rglob('*'))}))
        shutil.rmtree(self.root)
        self.assertFalse(self.root.exists())

    @contextmanager
    def kernel(self, prepare=None, observation=None):
        with patch.object(network, 'command', return_value=self.config['public_key']), \
             patch.object(network, 'prepare', side_effect=prepare) as applied, \
             patch.object(network, 'inspect', return_value=observation or {'namespace': {'device': 4, 'inode': 5}}):
            yield applied

    def test_parser_rejects_generated_non_private_reach_ranges_and_malformed_endpoints(self):
        for subnet in ['11.0.0.0/27', '172.15.0.0/27', '172.32.0.0/27', '192.169.0.0/27', '100.127.255.224/27', '10.0.0.1/27', '10.0.0.0/26', '::/27']:
            with self.subTest(subnet=subnet), self.assertRaises(ValueError):
                network.parse({**self.config, 'subnet': subnet})
        for endpoint in ['127.0.0.1', '169.254.169.254', '224.0.0.1', '0.0.0.0', '::1', 'host.example', '10.0.0.41;bad']:
            with self.subTest(endpoint=endpoint), self.assertRaises(ValueError):
                network.parse({**self.config, 'endpoint': endpoint})
        for port in [True, 0, -1, 65536, '51820']:
            with self.subTest(port=port), self.assertRaises(ValueError):
                network.parse({**self.config, 'port': port})
        self.assertFalse(network.record_path().exists())

    def test_secret_is_wrapped_and_cannot_enter_public_record(self):
        parsed = network.parse(self.config)
        self.assertNotIn(self.config['private_key'], repr(parsed))
        self.assertNotIn(self.config['private_key'], canonical(network.public(parsed)).decode())
        for key in ['!', '', base64.b64encode(b'\0' * 32).decode(), base64.b64encode(b'a' * 31).decode()]:
            with self.assertRaises(ValueError):
                network.parse({**self.config, 'private_key': key})

    def test_exact_reply_loss_adopts_without_any_kernel_mutation(self):
        with self.kernel() as applied:
            first = network.configure(self.config, self.binding)
            self.assertEqual(first, network.configure(self.config, self.binding))
            self.assertEqual(applied.call_count, 1)
        self.assertEqual(first['admission'], 'held')
        self.assertEqual(first['handshake'], 'unverified')
        self.assertFalse((self.root / 'execution-permit.json').exists())

    def test_intent_survives_partial_setup_without_reissuing(self):
        def fail(config):
            self.assertEqual(guest.private_json(network.record_path())['status'], 'preparing')
            raise OSError('lost during setup')
        with self.kernel(prepare=fail) as applied:
            with self.assertRaises(OSError):
                network.configure(self.config, self.binding)
            with self.assertRaisesRegex(network.Refusal, 'network-setup-unresolved'):
                network.configure(self.config, self.binding)
            self.assertEqual(applied.call_count, 1)
        self.assertNotIn('private_key', network.record_path().read_text())

    def test_observation_write_failure_cannot_recreate_namespace(self):
        original = guest.save
        def fail(path, value, exclusive=False):
            if value.get('status') == 'configured':
                raise OSError('lost final observation')
            original(path, value, exclusive)
        with self.kernel() as applied:
            with patch.object(guest, 'save', side_effect=fail), self.assertRaises(OSError):
                network.configure(self.config, self.binding)
            with self.assertRaisesRegex(network.Refusal, 'network-setup-unresolved'):
                network.configure(self.config, self.binding)
            self.assertEqual(applied.call_count, 1)

    def test_changed_policy_key_endpoint_binding_and_boot_refuse(self):
        with self.kernel():
            network.configure(self.config, self.binding)
            for change in ({'endpoint': '10.0.0.42'}, {'port': 40001}, {'gateway_key': self.config['public_key']},
                           {'subnet': '10.33.1.0/27'}, {'binding': {**self.binding, 'epoch': True}}):
                with self.subTest(change=list(change)), self.assertRaises(network.Refusal):
                    network.configure({**self.config, **change}, self.binding)
            with patch.object(guest, 'boot_id', return_value='clone'), self.assertRaisesRegex(network.Refusal, 'network-setup-unresolved'):
                network.verify(self.binding)
        with self.kernel(observation={'namespace': {'device': 4, 'inode': 6}}), self.assertRaisesRegex(network.Refusal, 'network-state-changed'):
            network.configure(self.config, self.binding)

    def test_workspace_launch_refuses_before_starting_any_process_without_setup(self):
        with patch.object(guest.subprocess, 'Popen') as launch, self.assertRaises(FileNotFoundError):
            guest.launch_mapped('workspace', self.root / 'launch', None, [], {}, self.root / 'receipt', self.binding)
        launch.assert_not_called()

    def test_gate_must_join_exact_namespace(self):
        with self.kernel():
            network.configure(self.config, self.binding)
            with self.assertRaisesRegex(network.Refusal, 'workspace-network-namespace-changed'):
                network.verify(self.binding, os.getpid())


if __name__ == '__main__':
    unittest.main()
