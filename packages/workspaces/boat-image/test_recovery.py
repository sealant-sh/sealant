from contextlib import contextmanager
import io
import json
import os
from pathlib import Path
import runpy
import shutil
import tempfile
import unittest
from unittest.mock import patch

import guest_boot as guest
import guest_invocation as invocation
import guest_network as network
import guest_readiness as readiness
import guest_receiver as receiver
import guest_recovery as recovery
from guest_contract import canonical, digest


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix='boat-recovery-'))
        self.runtime = Path(tempfile.mkdtemp(prefix='boat-recovery-', dir='/dev/shm'))
        self.addCleanup(self.cleanup)
        self.enterContext(patch.object(guest, 'ROOT', self.root))
        self.enterContext(patch.object(receiver, 'RUNTIME', self.runtime))
        self.enterContext(patch.object(guest, 'boot_id', return_value='boot'))
        self.binding = {'identity': {'deployment_id': 'deployment', 'instance_id': 'bx_original', 'disk_lineage': 'disk'},
                        'boot_id': 'boot', 'epoch': 1, 'operation_id': 'launch'}
        self.request = recovery.request_for(self.binding)
        self.source = self.runtime / 'epoch-1'
        self.source.mkdir(mode=0o700)
        self.files = {'launch': canonical({'format': 'sealant-daemon-launch-v1', 'boot_env': {
                        'SEALANT_WORKSPACE_SOURCE': 'capture', 'SEALANT_SECRET_ENV_FILE': '/run/sealant-inputs/secret-env',
                        'SEALANT_LIFECYCLE_SETUP_JSON': '["must never run"]'}}),
                      'secret-env': canonical({'capture-token': 'synthetic-only'})}
        self.install_files()
        self.original = {'format': 'sealant-invocation-v1', 'binding': self.binding, 'status': 'ended',
                         'owner': None, 'launcher': None, 'gate': None, 'exit_code': 75}
        guest.save(invocation.path(), self.original)
        guest.save(self.runtime / 'control.json', {'boot_id': 'boot', 'token': 'a' * 64})

    def install_files(self):
        for name, data in self.files.items():
            (self.source / name).write_bytes(data)
            (self.source / name).chmod(0o600)
        manifest = {'format': 'sealant-admission-stage-v1', **self.binding, 'files': [
                    {'name': name, 'size': len(data), 'sha256': digest(data)} for name, data in self.files.items()]}
        guest.save(self.runtime / 'manifest-1.json', manifest)
        guest.save(self.root / 'receiver.json', {'format': 'sealant-receiver-v1', 'identity': self.binding['identity'],
                   'admission': {'boot_id': 'boot', 'epoch': 1, 'operation_id': 'launch',
                                 'digest': digest(canonical(manifest)), 'status': 'installed'}})

    def cleanup(self):
        for path in (self.root, self.runtime):
            print(json.dumps({'ownedScratch': str(path), 'entries': sorted(str(item.relative_to(path)) for item in path.rglob('*'))}))
            shutil.rmtree(path)
            self.assertFalse(path.exists())

    @contextmanager
    def system(self, lost=False, writers=False):
        calls = []
        def run(*args, **kwargs):
            calls.append(args)
            self.assertTrue(recovery.path().exists())
            if args[1:] == ('--no-block', 'start', recovery.UNIT):
                self.assertEqual(guest.private_json(recovery.path())['phase'], 'issued')
                self.assertEqual(invocation.state(recovery.invocation_path())['status'], 'issued')
                if lost:
                    raise OSError('unknown systemd outcome')
            return ''
        with patch.object(guest, 'run', side_effect=run), patch.object(guest, 'census', return_value={'processes': [1] if writers else []}), \
                patch.object(guest, 'revalidate', return_value=(None, [], {})), patch.object(network, 'verify'), \
                patch.object(readiness, 'verify_permit'), patch.object(os, 'fchown'), patch.object(os, 'chown'):
            yield calls

    def test_recovery_closes_ordinary_replay_before_stop_and_issues_once(self):
        with self.system() as calls:
            self.assertEqual(recovery.start(self.request)['execution'], 'issued')
            self.assertEqual(recovery.start(self.request)['execution'], 'issued')
            self.assertEqual(calls, [('/usr/bin/systemctl', 'stop', invocation.UNIT, 'sealant-native-workspace.service'),
                                     ('/usr/bin/systemctl', '--no-block', 'start', recovery.UNIT)])
        self.assertEqual(invocation.state(), self.original)
        for name, data in self.files.items():
            self.assertEqual((self.runtime / 'recovery-launch' / name).read_bytes(), data)
        with self.assertRaisesRegex(receiver.Refusal, 'ordinary-invocation-closed'):
            invocation.start({'format': 'sealant-invocation-start-v1', **self.binding})
        with self.assertRaisesRegex(receiver.Refusal, 'ordinary-invocation-closed'):
            invocation.run()

    def test_lost_start_response_is_observe_only(self):
        with self.system(lost=True) as calls:
            with self.assertRaises(OSError):
                recovery.start(self.request)
            self.assertEqual(recovery.start(self.request)['execution'], 'issued')
            self.assertEqual(len(calls), 2)

    def test_pre_dispatch_crash_can_finish_exact_preparation_but_never_replay_issuance(self):
        save = guest.save
        def failed(path, value, **options):
            if path == recovery.path() and value['phase'] == 'issued':
                raise OSError('lost before dispatch')
            return save(path, value, **options)
        with self.system() as calls, patch.object(guest, 'save', side_effect=failed), self.assertRaises(OSError):
            recovery.start(self.request)
        self.assertEqual(len(calls), 1)
        self.assertEqual(guest.private_json(recovery.path())['phase'], 'closing')
        self.assertEqual(invocation.state(recovery.invocation_path())['status'], 'issued')
        with self.system() as calls:
            self.assertEqual(recovery.start(self.request)['execution'], 'issued')
            self.assertEqual(recovery.start(self.request)['execution'], 'issued')
            self.assertEqual(len(calls), 2)

    def test_changed_prepared_copy_and_extra_files_refuse_without_start(self):
        guest.save(recovery.path(), {'format': 'sealant-capture-recovery-state-v1', 'request': self.request, 'phase': 'closing'})
        directory = self.runtime / 'recovery-launch'
        directory.mkdir(mode=0o700)
        target = directory / 'launch'
        target.write_bytes(b'changed')
        target.chmod(0o600)
        with self.system() as calls, self.assertRaisesRegex(receiver.Refusal, 'payload-conflict'):
            recovery.start(self.request)
        self.assertEqual(len(calls), 1)
        target.unlink()
        (directory / 'foreign').write_bytes(b'unknown')
        with self.system() as calls, self.assertRaisesRegex(receiver.Refusal, 'unsafe-recovery-staging'):
            recovery.start(self.request)
        self.assertEqual(len(calls), 1)

    def test_active_original_is_observed_without_stop_or_recovery_intent(self):
        with patch.object(invocation, 'observe', return_value='running'), self.system() as calls:
            result = recovery.start(self.request)
            self.assertEqual((result['mode'], result['execution']), ('original', 'running'))
            self.assertFalse(recovery.path().exists())
            self.assertEqual(calls, [])

    def test_wrong_epoch_boot_disk_and_new_identity_refuse_without_mutation(self):
        for changed in ({'epoch': 2}, {'operation_id': 'fresh'}, {'boot_id': 'cold'},
                        {'identity': {**self.binding['identity'], 'instance_id': 'bx_clone'}}):
            with self.subTest(changed=changed), self.system() as calls, self.assertRaises(receiver.Refusal):
                recovery.start(recovery.request_for({**self.binding, **changed}))
            self.assertFalse(recovery.path().exists())
            self.assertEqual(calls, [])
        with patch.object(guest, 'boot_id', return_value='cold'), self.system() as calls, self.assertRaises(receiver.Refusal):
            recovery.start(self.request)
        self.assertEqual(calls, [])

    def test_missing_or_tampered_original_material_never_closes_or_starts(self):
        for mutate in ('missing', 'changed', 'symlink', 'permissions'):
            file = self.source / 'secret-env'
            file.unlink()
            if mutate == 'changed':
                file.write_bytes(b'changed')
                file.chmod(0o600)
            elif mutate == 'symlink':
                file.symlink_to(self.source / 'launch')
            elif mutate == 'permissions':
                file.write_bytes(self.files['secret-env'])
                file.chmod(0o644)
            with self.subTest(mutate=mutate), self.system() as calls, self.assertRaises((OSError, receiver.Refusal)):
                recovery.start(self.request)
            self.assertEqual(calls, [])
            self.assertFalse(recovery.path().exists())
            if file.is_symlink():
                file.unlink()
            self.install_files()

    def test_non_capture_launch_refuses_before_original_is_closed(self):
        self.files['launch'] = canonical({'format': 'sealant-daemon-launch-v1', 'boot_env': {'SEALANT_WORKSPACE_SOURCE': 'git'}})
        self.install_files()
        with self.system() as calls, self.assertRaisesRegex(receiver.Refusal, 'recovery-requires-capture-source'):
            recovery.start(self.request)
        self.assertEqual(calls, [])
        self.assertFalse(recovery.path().exists())

    def test_remaining_writer_holds_recovery_after_irreversible_close(self):
        with self.system(writers=True) as calls, self.assertRaisesRegex(receiver.Refusal, 'existing-workspace-writer'):
            recovery.start(self.request)
        self.assertEqual(len(calls), 1)
        self.assertEqual(guest.private_json(recovery.path())['phase'], 'closing')
        self.assertFalse(recovery.invocation_path().exists())
        with self.system():
            self.assertEqual(recovery.start(self.request)['execution'], 'issued')

    def test_ended_and_unresolved_recovery_never_start_again(self):
        with self.system():
            recovery.start(self.request)
        for phase in ('ended', 'unresolved'):
            guest.save(recovery.invocation_path(), {**invocation.state(recovery.invocation_path()), 'status': phase})
            with self.system() as calls:
                self.assertEqual(recovery.start(self.request)['execution'], phase)
                self.assertEqual(calls, [])
            with self.assertRaisesRegex(receiver.Refusal, 'recovery-invocation-replay-refused'):
                recovery.run()

    def test_wrapper_cannot_claim_without_the_exact_recovery_unit(self):
        with self.system():
            recovery.start(self.request)
        owner = {'systemd_invocation': 'd' * 32, 'process': {'pid': os.getpid() + 1}}
        with patch.object(invocation, 'unit_identity', return_value=owner), self.assertRaisesRegex(receiver.Refusal, 'recovery-unit-mismatch'):
            recovery.run()

    def test_mapped_entry_execs_only_the_recovery_cli(self):
        class ExecCalled(Exception):
            pass
        observed = []
        original_open = open
        def opened(path, *args, **kwargs):
            if path == '/proc/self/uid_map':
                return io.StringIO('0 131072 65536')
            if path == '/run/sealant-inputs/launch':
                return io.StringIO(self.files['launch'].decode())
            return original_open(path, *args, **kwargs)
        def execve(*args):
            observed.append(args)
            raise ExecCalled()
        stream = type('Stream', (), {'buffer': io.BytesIO(canonical({'mode': 'recovery'}) + b'\n')})()
        with patch('builtins.open', side_effect=opened), patch.object(os, 'getpid', return_value=1), \
                patch.object(os, 'execve', side_effect=execve), patch('sys.stdin', stream), self.assertRaises(ExecCalled):
            runpy.run_path(str(Path(__file__).with_name('workspace-launch.py')))
        self.assertEqual(observed[0][1], ['/usr/local/bin/sealantd', 'boot', '--recovery'])
        self.assertEqual(observed[0][2]['SEALANT_CONTROL_SOCKET'], '/run/sealant/control.sock')


if __name__ == '__main__':
    unittest.main()
