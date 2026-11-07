from contextlib import nullcontext
from dataclasses import asdict, replace
import json
import os
from pathlib import Path
import shutil
import socket
import tempfile
import unittest
from unittest.mock import patch

import guest_boot as guest
import guest_control as control
import guest_invocation as invocation
import guest_receiver as receiver


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
