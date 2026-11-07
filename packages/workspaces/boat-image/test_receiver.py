import base64
import configparser
from contextlib import contextmanager
from dataclasses import asdict
import http.client
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import patch

import guest_boot as guest
import guest_receiver as receiver
from guest_contract import canonical, digest


class ReceiverTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix='boat-receiver-'))
        self.runtime = Path(tempfile.mkdtemp(prefix='boat-receiver-', dir='/dev/shm'))
        self.addCleanup(self.cleanup)
        self.enterContext(patch.object(guest, 'ROOT', self.root))
        self.enterContext(patch.object(receiver, 'RUNTIME', self.runtime))
        self.enterContext(patch.object(guest, 'boot_id', return_value='boot-one'))
        self.identity = {'deployment_id': 'deployment', 'instance_id': 'bx_instance', 'disk_lineage': 'disk'}
        guest.save(self.root / 'receiver.json', {'format': 'sealant-receiver-v1', 'identity': self.identity, 'admission': None})
        guest.save(self.runtime / 'control.json', {'boot_id': 'boot-one', 'token': 'a' * 64})
        self.value = {'format': 'sealant-admission-stage-v1', 'identity': self.identity,
                      'boot_id': 'boot-one', 'epoch': 1, 'operation_id': 'launch-one',
                      'files': [{'name': 'launch', 'size': 6, 'sha256': digest(b'secret'),
                                 'data': base64.b64encode(b'secret').decode()}]}

    def cleanup(self):
        for root in (self.root, self.runtime):
            print(json.dumps({'ownedScratch': str(root), 'entries': sorted(str(p.relative_to(root)) for p in root.rglob('*'))}))
            shutil.rmtree(root)
            self.assertFalse(root.exists())

    @contextmanager
    def validated(self):
        with patch.object(guest, 'revalidate', return_value=(None, [], {})) as check:
            yield check

    def test_install_replays_same_epoch_without_returning_secret_or_fingerprints(self):
        with self.validated():
            first = receiver.stage(self.value)
            self.assertEqual(receiver.stage(json.loads(json.dumps(self.value))), first)
        self.assertEqual((first['stage'], first['execution'], first['admission']), ('installed', 'unavailable', 'held'))
        self.assertNotIn('secret', json.dumps(first))
        self.assertNotIn(digest(b'secret'), json.dumps(first))
        self.assertEqual((self.runtime / 'epoch-1/launch').read_bytes(), b'secret')
        self.assertEqual((self.runtime / 'epoch-1/launch').stat().st_mode & 0o777, 0o600)

    def test_fresh_logical_id_or_epoch_cannot_bypass_disk_barrier(self):
        with self.validated():
            receiver.stage(self.value)
            for key, value in [('operation_id', 'launch-two'), ('epoch', 2), ('boot_id', 'boot-two')]:
                with self.subTest(key=key), self.assertRaises(receiver.Refusal):
                    receiver.stage({**self.value, key: value})
            with patch.object(guest, 'boot_id', return_value='boot-two'):
                guest.save(self.runtime / 'control.json', {'boot_id': 'boot-two', 'token': 'b' * 64})
                with self.assertRaisesRegex(receiver.Refusal, 'disk-admission-conflict'):
                    receiver.stage({**self.value, 'boot_id': 'boot-two', 'epoch': 2, 'operation_id': 'fresh'})

    def test_acceptance_is_durable_before_any_staging_side_effect_and_retry_converges(self):
        original = receiver.private_directory
        def fail(path):
            if path.name == 'epoch-1':
                self.assertEqual(receiver.disk_state()['admission']['status'], 'prepared')
                raise OSError('lost after durable acceptance')
            original(path)
        with self.validated():
            with patch.object(receiver, 'private_directory', side_effect=fail), self.assertRaises(OSError):
                receiver.stage(self.value)
            self.assertEqual(receiver.stage(self.value)['stage'], 'installed')

    def test_partial_temporary_file_from_killed_writer_can_be_repaired(self):
        directory = self.runtime / 'epoch-1'
        directory.mkdir(mode=0o700)
        (directory / '.pending-launch').write_bytes(b'se')
        with self.validated():
            self.assertEqual(receiver.stage(self.value)['stage'], 'installed')
        self.assertEqual([p.name for p in directory.iterdir()], ['launch'])

    def test_corrupted_final_files_and_symlinks_refuse(self):
        with self.validated():
            receiver.stage(self.value)
            path = self.runtime / 'epoch-1/launch'
            path.write_bytes(b'wrong!')
            with self.assertRaisesRegex(receiver.Refusal, 'staged-file-conflict'):
                receiver.stage(self.value)
            path.unlink()
            path.symlink_to(self.root / 'receiver.json')
            with self.assertRaises(OSError):
                receiver.stage(self.value)

    def test_malformed_unbounded_and_traversal_payloads_refuse_before_acceptance(self):
        entries = [
            {**self.value['files'][0], 'name': '../escape'},
            {**self.value['files'][0], 'name': '/root/escape'},
            {**self.value['files'][0], 'name': 'a/b'},
            {**self.value['files'][0], 'size': True},
            {**self.value['files'][0], 'sha256': '0' * 64},
            {**self.value['files'][0], 'data': '!'},
        ]
        with self.validated() as check:
            for entry in entries:
                with self.subTest(entry=entry), self.assertRaises(receiver.Refusal):
                    receiver.stage({**self.value, 'files': [entry]})
            for epoch in [0, -1, True, 1.5, 9007199254740992]:
                with self.subTest(epoch=epoch), self.assertRaises(receiver.Refusal):
                    receiver.stage({**self.value, 'epoch': epoch})
            with self.assertRaises(receiver.Refusal):
                receiver.stage({**self.value, 'files': self.value['files'] * 17})
            self.assertIsNone(receiver.disk_state()['admission'])
            check.assert_not_called()

    def test_wrong_disk_and_stale_boot_refuse_before_revalidation(self):
        with self.validated() as check:
            for identity in [{**self.identity, 'instance_id': 'other'}, {**self.identity, 'disk_lineage': 'other'}]:
                with self.assertRaises(receiver.Refusal):
                    receiver.stage({**self.value, 'identity': identity})
            with self.assertRaises(receiver.Refusal):
                receiver.stage({**self.value, 'boot_id': 'old'})
            check.assert_not_called()

    def test_disk_staging_is_not_a_fallback(self):
        with patch.object(receiver, 'RUNTIME', self.root):
            with self.assertRaisesRegex(receiver.Refusal, 'tmpfs'):
                receiver.require_tmpfs()

    def test_live_unix_http_authentication_limits_and_fixed_routes(self):
        path = str(self.runtime / 'http.sock')
        server = receiver.UnixServer(path, receiver.Handler)
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        try:
            def request(method, route, body=None, auth='Bearer ' + 'a' * 64, headers=None):
                connection = http.client.HTTPConnection('localhost', timeout=5)
                connection.sock = socket.socket(socket.AF_UNIX)
                connection.sock.connect(path)
                try:
                    connection.request(method, route, body=body, headers={'Authorization': auth, **(headers or {})})
                    response = connection.getresponse()
                    return response.status, json.loads(response.read())
                finally:
                    connection.close()
            with self.validated():
                self.assertEqual(request('GET', '/sealant/bootstrap/status', auth='wrong')[0], 401)
                self.assertEqual(request('GET', '/anything')[0], 404)
                self.assertEqual(request('POST', '/sealant/bootstrap/isolate', '{}', auth='wrong', headers={'Content-Type': 'application/json'})[0], 401)
                self.assertEqual(request('POST', '/sealant/bootstrap/isolate', '{}', headers={'Content-Type': 'application/json'})[0], 409)
                for route in ('permit', 'readiness'):
                    url = '/sealant/bootstrap/' + route
                    self.assertEqual(request('POST', url, '{}', auth='wrong', headers={'Content-Type': 'application/json'})[0], 401)
                    self.assertEqual(request('POST', url, '{}', headers={'Content-Type': 'application/json'})[0], 409)
                self.assertEqual(request('GET', '/sealant/bootstrap/status')[1]['execution'], 'unavailable')
                code, body = request('POST', '/sealant/bootstrap/stage', json.dumps(self.value),
                                     headers={'Content-Type': 'application/json'})
                self.assertEqual((code, body['stage']), (200, 'installed'))
                self.assertEqual(request('POST', '/sealant/bootstrap/stage',
                                         headers={'Content-Type': 'text/plain', 'Content-Length': '2'})[0], 409)
                self.assertEqual(request('POST', '/sealant/bootstrap/stage',
                                         headers={'Content-Type': 'application/json', 'Content-Length': str(receiver.MAX_BODY + 1)})[0], 409)
                self.assertEqual(request('POST', '/sealant/bootstrap/start')[0], 409)
                # After staging, the route reaches the strict network parser, never arbitrary exec.
                self.assertEqual(request('POST', '/sealant/bootstrap/isolate', '{}', headers={'Content-Type': 'application/json'}), (409, {'error': 'invalid-network-config'}))
        finally:
            server.shutdown()
            thread.join()
            server.server_close()

    def test_public_bind_encrypts_same_bearer_on_replay_and_refuses_conflicts(self):
        node = shutil.which('node')
        self.assertIsNotNone(node)
        key = json.loads(subprocess.check_output([node, '-e', """
const c=require('node:crypto');const k=c.generateKeyPairSync('rsa',{modulusLength:3072});
process.stdout.write(JSON.stringify({public:k.publicKey.export({type:'spki',format:'pem'}),
private:k.privateKey.export({type:'pkcs8',format:'pem'})}));
"""], text=True))
        source = Path(__file__).with_name('bootstrap-crypto.mjs')
        shutil.copyfile(source, self.root / source.name)
        (self.runtime / 'control.json').unlink()
        shipped = self.root / 'shipped'
        shipped.write_bytes(b'protected')
        shipped.chmod(0o600)
        manifest = {'format': 'sealant-guest-manifest-v1', 'files': {
            str(shipped): asdict(guest.file_identity(shipped))},
            'inputs': {}, 'bundle_paths': []}
        guest.save(self.root / 'manifest.json', manifest)
        manifest_digest = digest(guest.ProtectedManifest.parse(manifest).bytes())
        request = {'format': 'sealant-bootstrap-v1', 'identity': self.identity, 'boot_id': 'boot-one',
                   'manifest_digest': manifest_digest, 'operation_id': 'exchange', 'public_key': key['public']}
        def invoke(program, *args):
            self.assertEqual(program, '/usr/bin/node')
            return [node, *args]
        with patch.object(guest, 'invoke', side_effect=invoke), patch.object(guest, 'BUNDLE', self.root / 'bundle'):
            with receiver.locked():
                first = receiver.bind(request)
                replay = receiver.bind(request)
                self.assertNotEqual(first['ciphertext'], replay['ciphertext'])
                for changed in [{**request, 'operation_id': 'other'},
                                {**request, 'identity': {**self.identity, 'instance_id': 'clone'}},
                                {**request, 'boot_id': 'old'}, {**request, 'manifest_digest': '0' * 64}]:
                    with self.subTest(changed=changed['operation_id']), self.assertRaises(receiver.Refusal):
                        receiver.bind(changed)
                shipped.write_bytes(b'changed')
                with self.assertRaisesRegex(ValueError, 'protected-file-changed'):
                    receiver.bind(request)
        label = ['sealant-bootstrap-v1', self.identity['deployment_id'], self.identity['instance_id'],
                 self.identity['disk_lineage'], 'boot-one', 'exchange', manifest_digest]
        decrypt = """
const c=require('node:crypto');let raw='';process.stdin.on('data',x=>raw+=x).on('end',()=>{
const v=JSON.parse(raw);try {process.stdout.write(c.privateDecrypt({key:v.key,
padding:c.constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256',oaepLabel:Buffer.from(JSON.stringify(v.label))},
Buffer.from(v.ciphertext,'base64')))}catch{process.exitCode=2}});
"""
        def opened(reply, actual_label):
            return subprocess.run([node, '-e', decrypt], input=json.dumps({'key': key['private'],
                'ciphertext': reply['ciphertext'], 'label': actual_label}), text=True, capture_output=True)
        actual = opened(first, label)
        self.assertEqual(actual.returncode, 0)
        self.assertEqual(actual.stdout, receiver.current_control()['token'].value)
        self.assertEqual(opened(replay, label).stdout, actual.stdout)
        self.assertNotIn(actual.stdout, json.dumps(first))
        self.assertEqual(opened(first, [*label[:-1], 'wrong']).returncode, 2)
        self.assertEqual(guest.binding_for(manifest_digest, None).instance_id, self.identity['instance_id'])

    def test_unbound_publication_waits_without_spending_or_resetting_check_deadline(self):
        guest.save(self.root / 'manifest.json', {})
        guest.save(self.root / 'source-approval.json', {})
        self.assertEqual(guest.held_boot()['reason'], 'awaiting-current-boot-binding')
        self.assertEqual(guest.watchdog()['reason'], 'awaiting-current-boot-binding')
        self.assertFalse((self.root / 'boots').exists())
        guest.save(self.root / 'instance.json', {**self.identity, 'boot_id': 'boot-one'})
        self.assertFalse(guest.awaiting_binding())

    def test_receiver_units_are_static_and_keep_workspace_execution_unavailable(self):
        for name in ('bootstrap.service', 'relay.service'):
            unit = configparser.ConfigParser(interpolation=None)
            unit.read(Path(__file__).with_name(name))
            self.assertNotIn('Install', unit)
            self.assertEqual(unit['Service']['Restart'], 'on-failure')
            self.assertEqual(unit['Service']['NotifyAccess'], 'none')
        unit = configparser.ConfigParser(interpolation=None)
        unit.read(Path(__file__).with_name('workspace.service'))
        self.assertIn('guest_invocation.py', unit['Service']['ExecStart'])
        self.assertEqual(unit['Service']['Restart'], 'no')
        self.assertEqual(unit['Unit']['ConditionPathExists'], '/run/sealant-bootstrap/execution-permit.json')
        self.assertNotIn('Install', unit)

    def test_a_previous_inspection_cannot_return_to_unbound_wait_or_reset_deadline(self):
        guest.save(self.root / 'manifest.json', {})
        guest.save(self.root / 'source-approval.json', {})
        binding = guest.BootBinding('boot-one', 'instance', 'disk', 'manifest', 'approved')
        journal = guest.BootJournal(self.root, binding)
        state = guest.initial_state(binding, 10, 60)
        journal.append(state)
        self.assertFalse(guest.awaiting_binding())
        with patch.object(guest.time, 'monotonic', return_value=80):
            terminal = guest.watchdog()
            replay = guest.held_boot()
        self.assertEqual((terminal['status'], terminal['first_invocation'], terminal['deadline']), ('timed-out', 10, 70))
        self.assertEqual((replay['status'], replay['first_invocation'], replay['deadline']), ('timed-out', 10, 70))


if __name__ == '__main__':
    unittest.main()
