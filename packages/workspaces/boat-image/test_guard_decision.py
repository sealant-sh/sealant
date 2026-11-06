from dataclasses import replace
import json
import os
from pathlib import Path
import shutil
import subprocess
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import guest_boot as guest
from guest_contract import BootBinding, initial_state


class DecisionTests(unittest.TestCase):
    def scratch(self):
        root = Path(subprocess.check_output(['mktemp', '-d', '-t', 'boat-guard-decision.XXXXXX'], text=True).strip())
        def cleanup():
            print(json.dumps({'listed_before_delete': str(root), 'entries': sorted(str(p.relative_to(root)) for p in root.rglob('*'))}))
            shutil.rmtree(root)
        self.addCleanup(cleanup)
        return root

    def test_timestamp_only_change_is_accepted_during_real_read(self):
        path = self.scratch() / 'code'
        path.write_bytes(b'shipped code')
        original = guest.digest
        def changed(raw):
            info = path.stat()
            os.utime(path, ns=(info.st_atime_ns, info.st_mtime_ns + 1000000000))
            return original(raw)
        with patch.object(guest, 'digest', changed):
            actual = guest.file_identity(path, original(path.read_bytes()))
        self.assertEqual(actual.sha256, original(b'shipped code'))

    def test_every_retained_during_read_field_is_still_required(self):
        path = self.scratch() / 'code'
        path.write_bytes(b'shipped code')
        before = SimpleNamespace(**{key: getattr(path.stat(), key) for key in (
            'st_dev', 'st_ino', 'st_uid', 'st_gid', 'st_mode', 'st_size', 'st_nlink', 'st_mtime_ns', 'st_ctime_ns')})
        for key in ('st_dev', 'st_ino', 'st_uid', 'st_gid', 'st_mode', 'st_size', 'st_nlink'):
            with self.subTest(key=key):
                after = SimpleNamespace(**{**vars(before), key: getattr(before, key) + 1})
                with patch.object(guest.os, 'fstat', side_effect=[before, after]):
                    with self.assertRaises(guest.FileObservationError):
                        guest.file_identity(path)

    def test_only_shipped_bundle_mappings_are_inspected(self):
        root = self.scratch()
        bundle = root / 'bundle'
        bundle.mkdir()
        code = bundle / 'code'
        code.write_bytes(b'shipped code')
        info = code.stat()
        maps = ('1-2 r-xp 0 00:00 1 /base/lib.so (deleted)\n'
                '2-3 r-xp 0 00:00 0 [anon]\n'
                f'3-4 r-xp 0 {os.major(info.st_dev):x}:{os.minor(info.st_dev):x} {info.st_ino} {code}\n')
        original = Path.read_text
        def read(path, *args, **kwargs):
            return maps if str(path) == f'/proc/{os.getpid()}/maps' else original(path, *args, **kwargs)
        with patch.object(guest, 'BUNDLE', bundle), patch.object(Path, 'read_text', read):
            result = guest.executable_mappings(os.getpid(), expected_files={str(code): guest.file_identity(code)})
            self.assertEqual([row.path for row in result], [str(code)])
            maps = maps.replace(str(code) + '\n', str(code) + ' (deleted)\n')
            with self.assertRaisesRegex(guest.DeletedMappingError, 'mapping-deleted'):
                guest.executable_mappings(os.getpid())

    def test_ownership_is_unit_scoped_and_never_pid_one(self):
        proc = self.scratch()
        for pid, group in ((1, 'sealant-held.service'), (42, 'sealant-held.service'),
                           (43, 'sealant-native-build.service/child'), (44, 'unrelated.service'),
                           (45, 'pretend-sealant-held.service')):
            path = proc / str(pid)
            path.mkdir()
            (path / 'cgroup').write_text('0::/system.slice/' + group)
        with patch.object(guest.os, 'getpid', return_value=42):
            self.assertEqual(guest.owned_units(proc), {42: 'sealant-held.service', 43: 'sealant-native-build.service'})

    def test_old_boot_binding_is_unbound_until_fresh_binding_arrives(self):
        root = self.scratch()
        path = root / 'instance.json'
        path.write_text(json.dumps({'boot_id': 'source', 'instance_id': 'source-vm', 'disk_lineage': 'source-disk'}))
        path.chmod(0o600)
        with patch.object(guest, 'ROOT', root), patch.object(guest, 'boot_id', return_value='clone'):
            self.assertEqual(guest.binding_for('manifest', None).instance_id, 'unbound')
            path.write_text(json.dumps({'boot_id': 'clone', 'instance_id': 'clone-vm', 'disk_lineage': 'source/snapshot'}))
            binding = guest.binding_for('manifest', None)
            self.assertEqual((binding.instance_id, binding.disk_lineage), ('clone-vm', 'source/snapshot'))

    def test_restart_requires_stable_files_and_is_fenced_before_dispatch(self):
        root = self.scratch()
        binding = BootBinding('boot', 'vm', 'disk', 'manifest', 'profile')
        journal = guest.BootJournal(root, binding)
        state = initial_state(binding, 10, 10)
        moments = [10.0]
        calls = []
        def restart(unit):
            self.assertIn(unit, journal.restart_units())
            calls.append(unit)
        candidate = {'restart_unit': 'sealant-held.service', 'protected_fingerprint': 'same-files'}
        ended = guest.run_checks(state, journal, lambda: (None, ['mapping-deleted:owned'], dict(candidate)),
            {'intervalSeconds': 1, 'stableObservations': 3}, lambda: moments[0],
            lambda value: moments.__setitem__(0, moments[0] + value), restart=restart)
        self.assertEqual(calls, ['sealant-held.service'])
        self.assertEqual(ended.status.value, 'timed-out')
        self.assertEqual(ended.deadline, 20)
        self.assertEqual(journal.restart_units(), {'sealant-held.service'})
        self.assertTrue(any((json.loads(path.read_bytes()).get('observation') or {}).get('mapping_restart') for path in journal.paths()))


    def test_expected_hash_still_refuses(self):
        path = self.scratch() / 'code'
        path.write_bytes(b'wrong code')
        with self.assertRaisesRegex(ValueError, 'protected-file-changed'):
            guest.file_identity(path, '0' * 64)

    def test_restart_fence_survives_latest_state_write_failure(self):
        root = self.scratch()
        binding = BootBinding('boot', 'vm', 'disk', 'manifest', 'profile')
        journal = guest.BootJournal(root, binding)
        state = initial_state(binding, 10, 60)
        original = guest.save
        def interrupted(path, value, exclusive=False):
            if path.name == 'held-state.json':
                raise OSError('latest write lost')
            return original(path, value, exclusive)
        with patch.object(guest, 'save', interrupted), self.assertRaises(OSError):
            journal.append(state, {'mapping_restart': 'sealant-held.service'})
        recovered = guest.BootJournal(root, binding)
        self.assertEqual(recovered.restart_units(), {'sealant-held.service'})
        self.assertEqual(recovered.current().deadline, 70)

    def test_unsettled_files_do_not_restart(self):
        root = self.scratch()
        binding = BootBinding('boot', 'vm', 'disk', 'manifest', 'profile')
        journal = guest.BootJournal(root, binding)
        moments = [10.0]
        calls = []
        def inspect():
            return None, ['mapping-deleted:owned'], {'restart_unit': 'sealant-held.service',
                'protected_fingerprint': str(moments[0])}
        guest.run_checks(initial_state(binding, 10, 5), journal, inspect,
            {'intervalSeconds': 1, 'stableObservations': 3}, lambda: moments[0],
            lambda value: moments.__setitem__(0, moments[0] + value), restart=calls.append)
        self.assertEqual(calls, [])

    def test_current_unit_reexecs_bundled_code(self):
        with patch.object(guest, 'owned_units', return_value={os.getpid(): 'sealant-held.service'}), \
             patch.object(guest.os, 'execve', side_effect=RuntimeError('exec intercepted')) as execute:
            with self.assertRaisesRegex(RuntimeError, 'exec intercepted'):
                guest.restart_owned('sealant-held.service')
        executable, argv, environment = execute.call_args.args
        self.assertEqual(executable, str(guest.BUNDLE / 'lib64/ld-linux-x86-64.so.2'))
        self.assertEqual(argv, guest.invoke('/usr/bin/python3', '-I', '-S', '-B', str(guest.ROOT / 'guest_boot.py'), 'boot'))
        self.assertEqual(environment, guest.ENV)


if __name__ == '__main__':
    unittest.main()
