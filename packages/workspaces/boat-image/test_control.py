from contextlib import nullcontext
from dataclasses import asdict, replace
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import guest_boot as guest
import guest_control as control
import guest_invocation as invocation
import guest_receiver as receiver
import guest_recovery as recovery


class ControlTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix='boat-control-'))
        self.addCleanup(self.cleanup)
        directory = self.root / 'run' / 'sealant'
        directory.mkdir(parents=True)
        self.listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.listener.bind(str(directory / 'control.sock'))
        self.listener.listen()
        self.addCleanup(self.listener.close)
        info = self.root.stat()
        # The local test has one mapped UID. Only the process-root fixture and expected owner differ.
        self.identity = replace(guest.identity(os.getpid()), root_device=info.st_dev, root_inode=info.st_ino)
        self.expected = asdict(self.identity)
        self.enterContext(patch.object(receiver, 'locked', side_effect=nullcontext))
        self.enterContext(patch.object(invocation, 'observe', return_value='running'))
        self.enterContext(patch.object(invocation, 'state', return_value={'gate': self.expected}))
        self.enterContext(patch.object(control, 'OWNER_UID', os.getuid()))
        self.held = type('Held', (), {'identity': self.identity, 'verify': lambda self: None, 'close': lambda self: None})()
        self.enterContext(patch.object(guest, 'HeldProcess', return_value=self.held))
        original = os.open
        self.enterContext(patch.object(os, 'open', side_effect=lambda path, *args, **kwargs: original(self.root if path == '/proc/' + str(os.getpid()) + '/root' else path, *args, **kwargs)))

    def cleanup(self):
        print(json.dumps({'ownedScratch': str(self.root), 'entries': sorted(str(path.relative_to(self.root)) for path in self.root.rglob('*'))}))
        shutil.rmtree(self.root)
        self.assertFalse(self.root.exists())

    def test_pinned_socket_uses_real_linux_peer_credentials_and_transfers_bytes(self):
        stream, held = control.connect()
        with stream:
            peer, _ = self.listener.accept()
            with peer:
                stream.sendall(b'exact daemon')
                self.assertEqual(peer.recv(64), b'exact daemon')
        held.close()

    def test_capture_recovery_proxy_uses_the_recovery_gate_and_still_checks_real_peer_credentials(self):
        marker = self.root / 'recovery.json'
        marker.write_bytes(b'{}')
        def observe(path=None, unit=invocation.UNIT):
            self.assertEqual((path, unit), (recovery.invocation_path(), recovery.UNIT))
            return 'running'
        with patch.object(recovery, 'path', return_value=marker), patch.object(invocation, 'observe', side_effect=observe):
            stream, held = control.connect()
            with stream:
                peer, _ = self.listener.accept()
                with peer:
                    stream.sendall(b'recovery only')
                    self.assertEqual(peer.recv(64), b'recovery only')
            held.close()
        with patch.object(recovery, 'path', return_value=marker), patch.object(invocation, 'observe', return_value='ended'), self.assertRaises(receiver.Refusal):
            control.connect()

    def test_ordinary_holder_bridges_to_its_daemon_child_by_real_peer_credentials(self):
        # workspace-launch keeps Python PID1 as the namespace holder; its sealantd child owns the socket.
        self.listener.close()
        socket_path = self.root / 'run/sealant/control.sock'
        socket_path.unlink()
        daemon = subprocess.Popen([sys.executable, '-c', (
            'import socket,sys\n'
            's=socket.socket(socket.AF_UNIX);s.bind(sys.argv[1]);s.listen();print("listening",flush=True)\n'
            'c,_=s.accept();c.sendall(c.recv(64));c.close()\n'), str(socket_path)], stdout=subprocess.PIPE, text=True)
        self.addCleanup(daemon.wait, 10)
        self.addCleanup(daemon.kill)
        self.addCleanup(daemon.stdout.close)
        self.assertEqual(daemon.stdout.readline().strip(), 'listening')
        info = self.root.stat()
        child = replace(guest.identity(daemon.pid), root_device=info.st_dev, root_inode=info.st_ino)
        binding = {'identity': {'deployment_id': 'd', 'instance_id': 'bx_test', 'disk_lineage': 'l'},
                   'boot_id': 'boot', 'epoch': 1, 'operation_id': 'launch'}
        # Exactly what invocation.observe() records once it has verified the one daemon child.
        guest.save(self.root / 'invocation-daemon.json', {'binding': binding, 'identity': asdict(child)})
        held = {pid: type('Held', (), {'identity': identity, 'verify': lambda self: None, 'close': lambda self: None})()
                for pid, identity in ((os.getpid(), self.identity), (daemon.pid, child))}
        original = os.open
        roots = {'/proc/' + str(pid) + '/root' for pid in held}
        with patch.object(guest, 'ROOT', self.root), \
             patch.object(invocation, 'state', return_value={'gate': self.expected, 'binding': binding}), \
             patch.object(guest, 'HeldProcess', side_effect=lambda pid: held[pid]), \
             patch.object(os, 'open', side_effect=lambda path, *args, **kwargs: original(self.root if path in roots else path, *args, **kwargs)):
            stream, _ = control.connect()
            with stream:
                stream.sendall(b'daemon child')
                self.assertEqual(stream.recv(64), b'daemon child')
            # A record from another admission never names the peer.
            guest.save(self.root / 'invocation-daemon.json', {'binding': {**binding, 'epoch': 2}, 'identity': asdict(child)})
            with self.assertRaisesRegex(receiver.Refusal, 'control-daemon-changed'):
                control.connect()

    def test_replaced_or_symlinked_socket_and_parent_refuse(self):
        socket_path = self.root / 'run/sealant/control.sock'
        socket_path.rename(socket_path.with_name('other.sock'))
        socket_path.symlink_to('other.sock')
        with self.assertRaisesRegex(receiver.Refusal, 'control-socket-owner-changed'):
            control.connect()
        socket_path.unlink()
        socket_path.with_name('other.sock').rename(socket_path)
        (self.root / 'run/sealant').rename(self.root / 'run/other')
        (self.root / 'run/sealant').symlink_to('other')
        with self.assertRaises(OSError):
            control.connect()

    def test_wrong_owner_process_root_and_terminal_invocation_refuse(self):
        with patch.object(control, 'OWNER_UID', os.getuid() + 1), self.assertRaises(receiver.Refusal):
            control.connect()
        with patch.object(invocation, 'observe', return_value='ended'), self.assertRaises(receiver.Refusal):
            control.connect()
        with patch.object(invocation, 'state', return_value={'gate': {**self.expected, 'root_inode': -1}}), self.assertRaises(receiver.Refusal):
            control.connect()
        # Real SO_PEERCRED still names this listener's process, not a caller's fabricated PID.
        changed = replace(self.identity, pid=os.getpid() + 100000)
        held = type('Held', (), {'identity': changed, 'verify': lambda self: None, 'close': lambda self: None})()
        original = os.open
        with patch.object(invocation, 'state', return_value={'gate': asdict(changed)}), \
             patch.object(guest, 'HeldProcess', return_value=held), \
             patch.object(os, 'open', side_effect=lambda path, *args, **kwargs: original(self.root if str(path).startswith('/proc/') and str(path).endswith('/root') else path, *args, **kwargs)), \
             self.assertRaisesRegex(receiver.Refusal, 'control-peer-changed'):
            control.connect()


if __name__ == '__main__':
    unittest.main()
