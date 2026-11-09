"""Required Docker proof that real sealantd admits the control bridge. No skips or provider access.

sealantd authorizes a control connection by the SO_PEERCRED uid it reads in its own user namespace:
its own uid, root, or an allowlist. The guest runs it as root in a namespace mapping 0 to 131072, so
the kernel's translation of the bridge's uid, not any Python bookkeeping, decides. This runs the
pinned daemon under that mapping in the packaged guest image and asks it.
"""
import json
import os
from pathlib import Path
import subprocess
import unittest
import uuid

DRIVER = r'''
import json, os, select, socket, struct, sys, time
import guest_control as control

root = '/proof'
os.makedirs(root + '/run/sealant', mode=0o755)
os.makedirs(root + '/workspace', mode=0o755)
for path in (root + '/run/sealant', root + '/run', root + '/workspace'):
    os.chown(path, control.OWNER_UID, control.OWNER_GID)
log = open(root + '/sealantd.log', 'wb')
ready, go = os.pipe(), os.pipe()
pid = os.fork()
if pid == 0:
    # The guest's mapping: root in the daemon's namespace is OWNER_UID outside it.
    os.unshare(os.CLONE_NEWUSER)
    os.write(ready[1], b'1')
    os.read(go[0], 1)
    os.setresgid(0, 0, 0)
    os.setresuid(0, 0, 0)
    os.dup2(log.fileno(), 2)
    os.execv('/opt/sealantd', ['/opt/sealantd', '--socket', root + '/run/sealant/control.sock',
                               '--workspace', root + '/workspace', '--log-level', 'info'])
os.read(ready[0], 1)
for name in ('uid_map', 'gid_map'):
    with open('/proc/%d/%s' % (pid, name), 'w') as handle:
        handle.write('0 %d 65536\n' % control.OWNER_UID)
os.write(go[1], b'1')
path = root + '/run/sealant/control.sock'
for _ in range(200):
    if os.path.exists(path):
        break
    time.sleep(0.05)
with open('/proc/%d/uid_map' % pid) as handle:
    mapping = handle.read().split()


def rejections():
    return open(root + '/sealantd.log', 'rb').read().count(b'unauthorized peer')


def admitted(connection):
    """sealantd drops a refused peer at once; an admitted one is held, waiting for a request."""
    readable, _, _ = select.select([connection], [], [], 2)
    return not readable or connection.recv(1) != b''


def daemon(connection):
    peer, uid, _ = struct.unpack('3i', connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
    return {'daemonPid': peer == pid, 'daemonUid': uid}


result = {'mapping': mapping, 'socketOwner': os.stat(path).st_uid}
before = rejections()
host_root = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
host_root.connect(path)
result['hostRoot'] = {'admitted': admitted(host_root), **daemon(host_root)}
host_root.close()
time.sleep(0.2)
result['hostRoot']['rejectionLogged'] = rejections() > before
before = rejections()
descriptor = os.open(path, os.O_PATH | os.O_NOFOLLOW)
owner = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
control.connect_as_owner(owner, descriptor)
os.close(descriptor)
result['owner'] = {'admitted': admitted(owner), **daemon(owner)}
owner.close()
time.sleep(0.2)
result['owner']['rejectionLogged'] = rejections() > before
os.kill(pid, 9)
os.waitpid(pid, 0)
print(json.dumps(result))
'''


class ControlDaemonProof(unittest.TestCase):
    def docker(self, *args):
        result = subprocess.run(['docker', *args], capture_output=True, text=True, timeout=60)
        if result.returncode:
            raise AssertionError('owned Docker command failed: ' + result.stderr[-1200:])
        return result.stdout.strip()

    def setUp(self):
        binary = Path(os.environ['SEALANTD_BIN']).resolve()
        image = Path(os.environ['SEALANT_BOAT_GUEST_TEST_IMAGE_FILE']).read_text().strip()
        self.name = 'sealant-control-daemon-proof-' + uuid.uuid4().hex[:12]
        self.addCleanup(self.cleanup)
        self.docker('run', '-d', '--name', self.name, '--privileged',
                    '-v', str(binary) + ':/opt/sealantd:ro', image)

    def cleanup(self):
        if subprocess.run(['docker', 'container', 'inspect', self.name], capture_output=True).returncode == 0:
            self.docker('rm', '-f', self.name)
        print(json.dumps({'ownedContainer': self.name, 'removed': True}))

    def test_real_sealantd_admits_the_owner_bridge_and_drops_host_root(self):
        result = json.loads(self.docker('exec', self.name, 'python3', '-B', '-c', DRIVER))
        print(json.dumps(result))
        self.assertEqual(result['mapping'], ['0', '131072', '65536'])
        self.assertEqual(result['socketOwner'], 131072)
        # What the bridge did before: connect as host root, unmapped in the daemon's namespace.
        self.assertEqual(result['hostRoot'], {'admitted': False, 'daemonPid': True, 'daemonUid': 131072,
                                              'rejectionLogged': True})
        # The one rule: the bridge connects as the daemon's mapped owner, and checks it by that uid.
        self.assertEqual(result['owner'], {'admitted': True, 'daemonPid': True, 'daemonUid': 131072,
                                           'rejectionLogged': False})


if __name__ == '__main__':
    unittest.main()
