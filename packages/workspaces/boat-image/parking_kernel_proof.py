"""Run only inside an owned privileged container with a private cgroup namespace."""
import ctypes
import importlib.util
from dataclasses import asdict
import json
import os
from pathlib import Path
import shutil
import signal
import tempfile
import time
import unittest
from unittest.mock import patch

import guest_boot as guest
import guest_capsule as capsule
import guest_parking as parking
import guest_readiness as readiness
import guest_receiver as receiver


class ParkingKernelTests(unittest.TestCase):
    def test_actual_holder_retains_private_tmpfs_after_daemon_exit(self):
        import subprocess
        scratch = Path(tempfile.mkdtemp(prefix='boat-parking-holder.'))
        holder = None
        try:
            script = '''import ctypes,importlib.util,os,pathlib,sys
spec=importlib.util.spec_from_file_location('holder',sys.argv[1])
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
libc=ctypes.CDLL(None,use_errno=True)
pathlib.Path('/tmp/held-volume').mkdir(exist_ok=True)
assert libc.mount(b'tmpfs',b'/tmp/held-volume',b'tmpfs',0,b'size=1m')==0
m.retain_namespaces(['/bin/sh','-c','printf retained-work > /tmp/held-volume/work'],os.environ)
'''
            holder = subprocess.Popen(['unshare', '--mount', '--pid', '--fork', '--mount-proc',
                                       'python3', '-B', '-c', script, str(Path(__file__).with_name('workspace-launch.py'))], stdout=subprocess.PIPE)
            self.assertIn(b'"exit_code": 0', holder.stdout.readline())
            children = Path('/proc/' + str(holder.pid) + '/task/' + str(holder.pid) + '/children').read_text().split()
            self.assertEqual(len(children), 1)
            pid = int(children[0])
            self.assertEqual(Path('/proc/' + str(pid) + '/root/tmp/held-volume/work').read_bytes(), b'retained-work')
            self.assertEqual(Path('/proc/' + str(pid) + '/task/' + str(pid) + '/children').read_text().strip(), '')
            os.kill(pid, signal.SIGKILL)
            holder.wait(timeout=5)
            self.assertFalse(Path('/proc/' + str(pid)).exists())
            print(json.dumps({'proof': 'actual-namespace-holder-outlives-daemon', 'holderPid': pid,
                              'positiveWait': holder.returncode, 'tmpfsBytes': 'retained-work'}))
        finally:
            if holder is not None and holder.poll() is None:
                children = Path('/proc/' + str(holder.pid) + '/task/' + str(holder.pid) + '/children').read_text().split()
                for pid in children:
                    os.kill(int(pid), signal.SIGKILL)
                holder.kill()
                holder.wait()
            if holder is not None and holder.stdout is not None:
                holder.stdout.close()
            print(json.dumps({'ownedScratch': str(scratch), 'entries': list(scratch.iterdir())}))
            shutil.rmtree(scratch)

    def test_real_frozen_writer_export_kill_tmpfs_loss_hydration_and_replay(self):
        self.assertTrue(Path('/.dockerenv').is_file(), 'Requires an owned container')
        self.assertEqual(Path('/proc/self/cgroup').read_text().strip(), '0::/')
        scratch = Path(tempfile.mkdtemp(prefix='boat-parking-kernel.'))
        group = readiness.CGROUP / readiness.SLICE
        group.mkdir()
        child_group = group / 'owned'
        child_group.mkdir()
        root = scratch / 'root'
        volume = root / 'tmp'
        volume.mkdir(parents=True)
        libc = ctypes.CDLL(None, use_errno=True)
        self.assertEqual(libc.mount(b'tmpfs', os.fsencode(volume), b'tmpfs', 0, b'size=2m'), 0)
        reader, writer = os.pipe()
        pid = os.fork()
        if pid == 0:
            try:
                os.close(reader)
                (child_group / 'cgroup.procs').write_text(str(os.getpid()))
                os.chroot(root)
                os.chdir('/')
                Path('/tmp/work').write_bytes(b'edited volatile user work')
                os.write(writer, b'1')
                while True:
                    Path('/tmp/ticks').write_text(str(time.monotonic_ns()))
                    time.sleep(0.01)
            finally:
                os._exit(0)
        os.close(writer)
        reaped = False
        mounted = True
        try:
            self.assertEqual(os.read(reader, 1), b'1')
            os.close(reader)
            info = group.stat()
            record = {'phase': 'closing', 'source': {'group': '/' + readiness.SLICE,
                      'cgroup_identity': [info.st_dev, info.st_ino], 'gate': asdict(guest.identity(pid))}}
            with parking.Writers(record) as writers:
                before = (volume / 'ticks').read_bytes()
                time.sleep(0.05)
                self.assertEqual((volume / 'ticks').read_bytes(), before)
                receipt = capsule.export(writers.root, [{'path': '/tmp', 'exclude': []}], scratch / 'capsule', {'source': pid})
                self.assertEqual(writers.observed()['frozen'], '1')
                writers.close()
                self.assertEqual(writers.observed()['populated'], '0')
            self.assertEqual(os.waitpid(pid, 0)[0], pid)
            reaped = True
            self.assertEqual(libc.umount2(os.fsencode(volume), 0), 0)
            mounted = False
            self.assertFalse((volume / 'work').exists())
            capsule.hydrate(scratch / 'capsule', receipt['sha256'], {'source': pid}, scratch / 'hydrated')
            self.assertEqual((scratch / 'hydrated/0/work').read_bytes(), b'edited volatile user work')
            child_group.rmdir()
            group.rmdir()
            with parking.Writers({**record, 'phase': 'exported'}) as writers:
                self.assertTrue(writers.absent)
                writers.close()
            with self.assertRaisesRegex(receiver.Refusal, 'writer-exclusion-unconfirmed'):
                with parking.Writers(record):
                    pass
            group.mkdir()
            # The original kernel object must never be confused with a new slice at its name.
            with self.assertRaisesRegex(receiver.Refusal, 'cgroup-replaced'):
                with parking.Writers({**record, 'phase': 'exported'}):
                    pass
            print(json.dumps({'proof': 'real-cgroup-freeze-export-kill-hydrate', 'receipt': receipt,
                              'sourcePid': pid, 'positivelyReaped': True}))
        finally:
            if not reaped:
                os.kill(pid, signal.SIGKILL)
                os.waitpid(pid, 0)
            if mounted:
                libc.umount2(os.fsencode(volume), 0)
            if child_group.exists():
                child_group.rmdir()
            if group.exists():
                group.rmdir()
            print(json.dumps({'ownedScratch': str(scratch), 'entries': sorted(str(p.relative_to(scratch))
                                                                            for p in scratch.rglob('*'))}))
            shutil.rmtree(scratch)
            self.assertFalse(scratch.exists())


if __name__ == '__main__':
    unittest.main()
