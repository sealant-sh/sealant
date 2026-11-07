"""Bounded relay bridge to the exact owned daemon, never an arbitrary guest path."""
from dataclasses import asdict
import os
import select
import socket
import socketserver
import stat
import struct
import threading

import guest_boot as guest
import guest_invocation as invocation
import guest_receiver as receiver

OWNER_UID = 131072

def connect():
    with receiver.locked():
        if invocation.observe() != 'running':
            raise receiver.Refusal('control-invocation-not-running')
        expected = invocation.state()['gate']
        held = guest.HeldProcess(expected['pid'])
        descriptors = []
        connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            stable = lambda value: {key: item for key, item in value.items() if key not in ('executable_device', 'executable_inode')}
            if stable(asdict(held.identity)) != stable(expected):
                raise receiver.Refusal('control-invocation-changed')
            root = os.open('/proc/' + str(expected['pid']) + '/root', os.O_PATH | os.O_DIRECTORY)
            descriptors.append(root)
            if (os.fstat(root).st_dev, os.fstat(root).st_ino) != (expected['root_device'], expected['root_inode']):
                raise receiver.Refusal('control-root-changed')
            parent = root
            for name in ('run', 'sealant'):
                parent = os.open(name, os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
                descriptors.append(parent)
            descriptor = os.open('control.sock', os.O_PATH | os.O_NOFOLLOW, dir_fd=parent)
            descriptors.append(descriptor)
            info = os.fstat(descriptor)
            if not stat.S_ISSOCK(info.st_mode) or info.st_uid != OWNER_UID:
                raise receiver.Refusal('control-socket-owner-changed')
            connection.settimeout(2)
            connection.connect('/proc/self/fd/' + str(descriptor))
            pid, uid, _ = struct.unpack('3i', connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            if (pid, uid) != (expected['pid'], OWNER_UID):
                raise receiver.Refusal('control-peer-changed')
            held.verify()
            connection.settimeout(None)
            return connection, held
        except BaseException:
            connection.close()
            held.close()
            raise
        finally:
            for descriptor in reversed(descriptors):
                os.close(descriptor)


class Bridge(socketserver.BaseRequestHandler):
    def handle(self):
        try:
            upstream, held = connect()
            try:
                with upstream:
                    while True:
                        readable, _, _ = select.select([self.request, upstream], [], [], 30)
                        held.verify()
                        for source in readable:
                            data = source.recv(65536)
                            if not data:
                                return
                            destination = upstream if source is self.request else self.request
                            destination.settimeout(5)
                            destination.sendall(data)
                            destination.settimeout(None)
            finally:
                held.close()
        except Exception:
            pass


class Server(socketserver.ThreadingUnixStreamServer):
    daemon_threads = True
    block_on_close = False
    slots = threading.BoundedSemaphore(4)

    def process_request(self, request, address):
        # Bound threads as well as forwarding connections.
        if not self.slots.acquire(blocking=False):
            request.close()
            return
        try:
            super().process_request(request, address)
        except BaseException:
            self.slots.release()
            raise

    def process_request_thread(self, request, address):
        try:
            super().process_request_thread(request, address)
        finally:
            self.slots.release()


def server():
    path = receiver.RUNTIME / 'control.sock'
    if path.exists():
        if not stat.S_ISSOCK(path.lstat().st_mode):
            raise receiver.Refusal('unexpected-control-socket')
        path.unlink()
    return Server(str(path), Bridge)
