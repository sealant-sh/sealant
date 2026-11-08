from contextlib import contextmanager
from dataclasses import asdict
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import guest_boot as guest
import guest_receiver as receiver
import guest_invocation as invocation
import guest_network as network
import guest_readiness as readiness
from guest_contract import canonical, digest


class InvocationTests(unittest.TestCase):
    def test_namespace_holder_is_running_only_with_its_exact_daemon_and_survives_its_exit(self):
        import sys
        shutil.copyfile(shutil.which('sleep'), self.root / 'sealantd')
        (self.root / 'sealantd').chmod(0o700)
        holder = subprocess.Popen([sys.executable, '-c',
            'import subprocess,sys,os,time; p=subprocess.Popen(["sleep","60"],executable=sys.argv[1]); '
            'deadline=time.monotonic()+2\n'
            'while os.stat("/proc/"+str(p.pid)+"/exe").st_ino != os.stat(sys.argv[1]).st_ino:\n'
            ' if time.monotonic()>deadline: raise RuntimeError("child did not exec")\n'
            ' time.sleep(0.001)\n'
            'print(p.pid,flush=True); p.wait(); input()',
            str(self.root / 'sealantd')], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
        try:
            pid = int(holder.stdout.readline())
            owner = {'systemd_invocation': 'd' * 32, 'process': asdict(guest.identity(os.getpid()))}
            guest.save(invocation.path(), {'format': 'sealant-invocation-v1', 'binding': self.binding,
                       'status': 'running', 'owner': owner, 'launcher': asdict(guest.identity(os.getpid())),
                       'gate': asdict(guest.identity(holder.pid)), 'exit_code': None})
            with patch.object(network, 'verify'), patch.object(invocation, 'unit_identity', return_value=owner):
                self.assertEqual(invocation.observe(), 'running')
                os.kill(pid, 15)
                import time
                for _ in range(100):
                    if not Path('/proc/' + str(pid)).exists():
                        break
                    time.sleep(0.01)
                self.assertEqual(invocation.observe(), 'ended')
                self.assertIsNone(holder.poll())
        finally:
            holder.kill()
            holder.wait()
            holder.stdin.close()
            holder.stdout.close()

    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix='boat-invocation-'))
        self.runtime = Path(tempfile.mkdtemp(prefix='boat-invocation-', dir='/dev/shm'))
        self.addCleanup(self.cleanup)
        self.enterContext(patch.object(guest, 'ROOT', self.root))
        self.enterContext(patch.object(receiver, 'RUNTIME', self.runtime))
        self.enterContext(patch.object(guest, 'boot_id', return_value='boot'))
        self.identity = {'deployment_id': 'deployment', 'instance_id': 'bx_instance', 'disk_lineage': 'disk'}
        self.binding = {'identity': self.identity, 'boot_id': 'boot', 'epoch': 1, 'operation_id': 'launch'}
        self.request = {'format': 'sealant-invocation-start-v1', **self.binding}
        guest.save(self.root / 'receiver.json', {'format': 'sealant-receiver-v1', 'identity': self.identity,
                   'admission': {'epoch': 1, 'operation_id': 'launch', 'boot_id': 'boot', 'digest': 'a' * 64, 'status': 'installed'}})
        guest.save(self.runtime / 'control.json', {'boot_id': 'boot', 'token': 'a' * 64})

    def cleanup(self):
        for path in (self.root, self.runtime):
            print(json.dumps({'ownedScratch': str(path), 'entries': sorted(str(item.relative_to(path)) for item in path.rglob('*'))}))
            shutil.rmtree(path)
            self.assertFalse(path.exists())

    def permit(self):
        guest.save(self.runtime / 'execution-permit.json', {'format': 'sealant-execution-permit-v2',
                   'binding': self.binding, 'resource_receipt': 'b' * 64, 'tunnel_receipt': 'c' * 64, 'limits': readiness.LIMITS})

    @contextmanager
    def starting(self, fail=False):
        def run(*args, **kwargs):
            self.assertEqual(args, ('/usr/bin/systemctl', '--no-block', 'start', invocation.UNIT))
            self.assertEqual(invocation.state()['status'], 'issued')
            if fail:
                raise OSError('lost reply')
            return ''
        with patch.object(readiness, 'verify_permit'), patch.object(network, 'verify'), patch.object(guest, 'revalidate', return_value=(None, [], {})), patch.object(guest, 'run', side_effect=run) as systemd:
            yield systemd

    def test_no_producer_no_admission(self):
        with self.starting() as systemd, self.assertRaisesRegex(receiver.Refusal, 'isolation-permit-unavailable'):
            invocation.start(self.request)
        systemd.assert_not_called()
        self.assertFalse(invocation.path().exists())

    def test_permit_cannot_bypass_missing_network_setup(self):
        self.permit()
        with self.assertRaises(FileNotFoundError):
            invocation.start(self.request)
        self.assertFalse(invocation.path().exists())

    def test_boolean_and_unbounded_epochs_refuse_before_intent(self):
        self.permit()
        with self.starting() as systemd:
            for value in (True, 0, -1, 1.5, 9007199254740992):
                with self.subTest(epoch=value), self.assertRaises(receiver.Refusal):
                    invocation.start({**self.request, 'epoch': value})
            systemd.assert_not_called()
        self.assertFalse(invocation.path().exists())

    def test_lost_start_reply_never_reissues_systemd_start(self):
        self.permit()
        with self.starting(fail=True) as systemd:
            with self.assertRaises(OSError):
                invocation.start(self.request)
            self.assertEqual(invocation.start(self.request)['execution'], 'issued')
            self.assertEqual(systemd.call_count, 1)

    def test_new_ids_new_boot_and_terminal_barriers_cannot_replay(self):
        self.permit()
        with self.starting():
            invocation.start(self.request)
        for phase in ('issued', 'ended', 'unresolved'):
            guest.save(invocation.path(), {**invocation.state(), 'status': phase})
            with self.starting() as systemd:
                self.assertEqual(invocation.start(self.request)['execution'], phase)
                for update in ({'epoch': 2}, {'operation_id': 'fresh'}, {'boot_id': 'fresh'},
                               {'identity': {**self.identity, 'instance_id': 'clone'}}):
                    with self.subTest(phase=phase, update=update), self.assertRaises(receiver.Refusal):
                        invocation.start({**self.request, **update})
                systemd.assert_not_called()

    def test_same_running_invocation_adopts_real_processes_and_exit_fences_replay(self):
        shutil.copyfile(shutil.which('sleep'), self.root / 'sealantd')
        (self.root / 'sealantd').chmod(0o700)
        child = subprocess.Popen(['sleep', '60'], executable=str(self.root / 'sealantd'))
        try:
            # Popen has completed exec; pin its actual start/root/ns/cgroup and daemon bytes.
            process = guest.HeldProcess(child.pid)
            process.close()
            owner = {'systemd_invocation': 'd' * 32, 'process': asdict(guest.identity(os.getpid()))}
            record = {'format': 'sealant-invocation-v1', 'binding': self.binding, 'status': 'running',
                      'owner': owner, 'launcher': asdict(guest.identity(os.getpid())),
                      'gate': asdict(guest.identity(child.pid)), 'exit_code': None}
            guest.save(invocation.path(), record)
            with patch.object(network, 'verify'), patch.object(invocation, 'unit_identity', return_value=owner):
                self.assertEqual(invocation.observe(), 'running')
                self.assertEqual(invocation.observe(), 'running')
                child.terminate()
                child.wait()
                self.assertEqual(invocation.observe(), 'unresolved')
                self.assertEqual(invocation.observe(), 'unresolved')
            with self.starting() as systemd:
                self.assertEqual(invocation.start(self.request)['execution'], 'unresolved')
                systemd.assert_not_called()
        finally:
            if child.poll() is None:
                child.kill()
                child.wait()

    def test_changed_systemd_invocation_refuses_even_same_pid(self):
        owner = {'systemd_invocation': 'd' * 32, 'process': asdict(guest.identity(os.getpid()))}
        guest.save(invocation.path(), {'format': 'sealant-invocation-v1', 'binding': self.binding,
                   'status': 'launching', 'owner': owner, 'launcher': None, 'gate': None, 'exit_code': None})
        with patch.object(network, 'verify'), patch.object(invocation, 'unit_identity', return_value={**owner, 'systemd_invocation': 'e' * 32}):
            self.assertEqual(invocation.observe(), 'unresolved')

    def test_wrapper_cannot_replay_even_under_a_fresh_service_invocation(self):
        for phase in ('launching', 'running', 'ended', 'unresolved'):
            guest.save(invocation.path(), {'format': 'sealant-invocation-v1', 'binding': self.binding,
                       'status': phase, 'owner': None, 'launcher': None, 'gate': None, 'exit_code': None})
            with self.subTest(phase=phase), self.assertRaisesRegex(receiver.Refusal, 'invocation-replay-refused'):
                invocation.run()

    def test_payload_validates_original_manifest_then_uses_mapped_private_tmpfs(self):
        source = self.runtime / 'epoch-1'
        source.mkdir(mode=0o700)
        data = canonical({'format': 'sealant-daemon-launch-v1', 'boot_env': {'SEALANT_RUN_ID': 'test'}})
        with open(source / 'launch', 'wb') as stream:
            stream.write(data)
        (source / 'launch').chmod(0o600)
        manifest = {'format': 'sealant-admission-stage-v1', **self.binding,
                    'files': [{'name': 'launch', 'size': len(data), 'sha256': digest(data)}]}
        guest.save(self.runtime / 'manifest-1.json', manifest)
        state = receiver.disk_state()
        guest.save(self.root / 'receiver.json', {**state, 'admission': {**state['admission'], 'digest': digest(canonical(manifest))}})
        # UID mapping outside this test namespace is intentionally unavailable. Assert the exact requested map.
        with patch.object(os, 'chown') as chown, patch.object(os, 'fchown') as fchown:
            copied = invocation.payload({'binding': self.binding})
            self.assertEqual((copied / 'launch').read_bytes(), data)
            chown.assert_called_once_with(copied, 131072, 131072)
            fchown.assert_called_once()
            self.assertEqual(fchown.call_args.args[1:], (131072, 131072))
        self.assertEqual((source / 'launch').stat().st_uid, 0)


if __name__ == '__main__':
    unittest.main()
