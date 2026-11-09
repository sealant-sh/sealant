"""Bounded relay bridge to the exact owned daemon, never an arbitrary guest path."""
from dataclasses import asdict
import json
import os
import select
import socket
import socketserver
import stat
import struct
import subprocess
import threading

import guest_boot as guest
import guest_invocation as invocation
import guest_receiver as receiver

# One control-peer rule, held by both ends: each peer is the daemon's mapped owner. sealantd runs as
# root in a user namespace that maps 0 to OWNER_UID, and admits a connection only when its
# SO_PEERCRED uid, read in that namespace, is its own or root. Host root is unmapped there and reads
# as the overflow uid, so the bridge connects from a short-lived child running as OWNER_UID, and
# checks the daemon by the same uid.
OWNER_UID = 131072
OWNER_GID = 131072
OWNER_GROUPS = []
CONNECT_SECONDS = 2
# Runs as OWNER_UID: connects the inherited, unconnected socket to the inherited O_PATH socket file.
OWNER_CONNECT = ('import socket,sys\n'
                 'socket.socket(fileno=int(sys.argv[1])).connect("/proc/self/fd/"+sys.argv[2])\n')
# The bridge's first line to the relay: its verdict, before any daemon byte.
STATUS_FORMAT = 'sealant-control-bridge-v1'


def python(*args):
    return guest.invoke('/usr/bin/python3', '-I', '-S', '-B', *args)


def connect_as_owner(connection, descriptor):
    """The kernel records the connecting task's credentials, so the owner child calls connect()."""
    helper = subprocess.Popen(
        python('-c', OWNER_CONNECT, str(connection.fileno()), str(descriptor)),
        pass_fds=(connection.fileno(), descriptor), env={}, stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        user=OWNER_UID, group=OWNER_GID, extra_groups=OWNER_GROUPS)
    try:
        code = helper.wait(CONNECT_SECONDS)
    except subprocess.TimeoutExpired:
        helper.kill()
        helper.wait()
        raise receiver.Refusal('control-daemon-unreachable')
    if code != 0:
        raise receiver.Refusal('control-daemon-unreachable')


def connect():
    with receiver.locked():
        import guest_recovery as recovery
        recovering = recovery.path().exists()
        if (recovery.observe() if recovering else invocation.observe()) != 'running':
            raise receiver.Refusal('control-invocation-not-running')
        record_path = recovery.invocation_path() if recovering else invocation.path()
        record = invocation.state(record_path)
        expected = record['gate']
        # Ordinary mode: Python PID1 holds the namespaces and its one sealantd child listens.
        # observe() above recorded and verified that child; the socket peer must be exactly it.
        daemon = invocation.daemon_path(record_path)
        if daemon.exists():
            observed = guest.private_json(daemon)
            if observed.get('binding') != record['binding']:
                raise receiver.Refusal('control-daemon-changed')
            expected = observed['identity']
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
            connect_as_owner(connection, descriptor)
            pid, uid, _ = struct.unpack('3i', connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            if (pid, uid) != (expected['pid'], OWNER_UID):
                raise receiver.Refusal('control-peer-changed')
            held.verify()
            return connection, held
        except BaseException:
            connection.close()
            held.close()
            raise
        finally:
            for descriptor in reversed(descriptors):
                os.close(descriptor)


def status(**fields):
    return json.dumps({'format': STATUS_FORMAT, **fields}, separators=(',', ':')).encode() + b'\n'


class Bridge(socketserver.BaseRequestHandler):
    def handle(self):
        try:
            try:
                upstream, held = connect()
            except receiver.Refusal as refusal:
                self.request.sendall(status(error=str(refusal)))
                return
            except Exception:
                self.request.sendall(status(error='control-unavailable'))
                return
            try:
                with upstream:
                    self.request.sendall(status(control='connected'))
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
