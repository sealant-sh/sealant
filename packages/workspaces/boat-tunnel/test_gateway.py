import base64
import importlib.util
import ipaddress
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('gateway', Path(__file__).with_name('gateway.py'))
gateway = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gateway)


class GatewayPolicyTests(unittest.TestCase):
    def config(self):
        return {'format': 'sealant-resource-tunnel-v1', 'binding': 'a' * 64,
                'privateKey': base64.b64encode(bytes(range(32))).decode(),
                'publicKey': base64.b64encode(bytes(range(1, 33))).decode(),
                'peerKey': base64.b64encode(bytes(range(2, 34))).decode(),
                'subnet': '10.250.1.0/27', 'bridge': '10.250.1.1'}

    def test_public_receipt_excludes_the_private_key(self):
        config = gateway.parse_config(self.config())
        self.assertNotIn('privateKey', gateway.public(config))
        self.assertNotIn(config['privateKey'], gateway.canonical(gateway.public(config)))

    def test_only_private_canonical_reach_networks_are_accepted(self):
        for n in range(1, 100):
            subnet = f'10.250.{n}.0/27'
            config = gateway.parse_config({**self.config(), 'subnet': subnet, 'bridge': f'10.250.{n}.1'})
            self.assertEqual(config['subnet'], subnet)
        for subnet, bridge in [('8.8.8.0/27', '8.8.8.1'), ('10.250.1.1/27', '10.250.1.1'),
                               ('10.250.1.0/24', '10.250.1.1'), ('::/27', '::1'),
                               ('127.0.0.0/27', '127.0.0.1'), ('169.254.1.0/27', '169.254.1.1'),
                               ('10.250.1.0/27', '10.250.2.1')]:
            with self.subTest(subnet=subnet), self.assertRaises(ValueError):
                gateway.parse_config({**self.config(), 'subnet': subnet, 'bridge': bridge})

    def test_malformed_and_zero_keys_refuse(self):
        for value in ('', 'secret', 'A' * 43 + '=', base64.b64encode(b'x' * 31).decode()):
            with self.subTest(value=value), self.assertRaises(ValueError):
                gateway.parse_config({**self.config(), 'peerKey': value})

    def test_forwarding_is_confined_to_the_one_reach_interface_and_peer(self):
        config = gateway.parse_config(self.config())
        rules = gateway.rules(config, 'eth1', '10.250.1.2')
        allowed = [rule for rule in rules['FORWARD'] if rule[-1] == 'ACCEPT']
        self.assertEqual(len(allowed), 2)
        self.assertIn(['-i', 'wg0', '-o', 'eth1', '-s', gateway.CLIENT + '/32', '-d', config['subnet'], '-j', 'ACCEPT'], allowed)
        self.assertTrue(all('RELATED,ESTABLISHED' in rule for rule in allowed if rule[1] != 'wg0'))
        for address in (config['bridge'], '10.250.1.2'):
            self.assertIn(['-i', 'wg0', '-d', address + '/32', '-j', 'REJECT'], rules['FORWARD'])
        self.assertTrue(ipaddress.ip_address(gateway.CLIENT) not in ipaddress.ip_network(config['subnet']))


if __name__ == '__main__':
    unittest.main()
