from dataclasses import asdict, replace
import json
import mmap
import os
from pathlib import Path
import shutil
import subprocess
import sys
import unittest
from unittest.mock import patch

import guest_boot as guest

from guest_contract import (
    BootBinding, ExecutableMapping, FileIdentity, ProcessIdentity, ProtectedManifest, Status,
    approved_profile, canonical, digest, initial_state, mapping_failures,
    receipt_failures, transition,
)
from guest_boot import BootJournal, HeldProcess, census, executable_mappings, file_identity, identity, mapped_gates, run_checks, verify_protected, watchdog_state


class ContractTests(unittest.TestCase):
    def setUp(self):
        self.path = "/var/lib/sealant/guest/bundle/usr/bin/python3"
        self.file = FileIdentity("a" * 64, 7, 141618, 0, 0, 0o755)
        self.process = ProcessIdentity(42, 900, 7, 2, 3, 4, 5, "0::/system.slice/held")
        self.mapping = ExecutableMapping(self.path, self.file.sha256, 7, 141618, 7, 141618)
        self.binding = BootBinding("boot-clone", "instance-clone", "source/snapshot", "c" * 64, "approved")

    def test_exact_identity_is_accepted(self):
        self.assertEqual(mapping_failures({self.path: self.file}, [self.mapping], self.process, self.process), [])

    def test_independent_review_changed_inode_is_refused(self):
        failures = mapping_failures({self.path: self.file}, [replace(self.mapping, mapped_inode=141619)], self.process, self.process)
        self.assertEqual(failures, ["mapping-file-identity-mismatch:" + self.path])

    def test_independent_review_unmanifested_mapping_is_refused(self):
        unknown = replace(self.mapping, path=str(Path(self.path).parent / "unmanifested-executable.so"))
        self.assertEqual(mapping_failures({self.path: self.file}, [unknown], self.process, self.process),
                         ["mapping-not-in-manifest:" + unknown.path])

    def test_device_alias_deleted_and_process_identity_fail_closed(self):
        for changed in (replace(self.mapping, mapped_device=8), replace(self.mapping, observed_inode=12),
                        replace(self.mapping, sha256="b" * 64), replace(self.mapping, deleted=True)):
            self.assertTrue(mapping_failures({self.path: self.file}, [changed], self.process, self.process))
        for key in asdict(self.process):
            value = getattr(self.process, key)
            after = replace(self.process, **{key: value + 1 if isinstance(value, int) else value + "/other"})
            self.assertIn("process-identity-changed", mapping_failures({self.path: self.file}, [self.mapping], self.process, after))

    def test_stale_receipt_and_missing_binding_cannot_authorize(self):
        self.assertEqual(receipt_failures(asdict(self.binding), self.binding), [])
        for key in asdict(self.binding):
            self.assertEqual(receipt_failures({**asdict(self.binding), key: "source"}, self.binding), ["stale-boot-receipt"])

    def test_stability_reset_timeout_and_compatibility_keep_admission_held(self):
        state = initial_state(self.binding, 1, 10)
        self.assertEqual(state.status, Status.HELD)
        state = transition(state, 2, "a", (), 3)
        self.assertEqual(state.status, Status.CHECKING)
        state = transition(state, 3, "a", (), 3)
        state = transition(state, 4, "b", (), 3)
        self.assertEqual(state.stable, 1)
        state = transition(state, 5, None, ("process-disappeared",), 3)
        self.assertEqual((state.status, state.stable), (Status.INCOMPATIBLE, 0))
        for moment in (6, 7, 8):
            state = transition(state, moment, "a", (), 3)
        self.assertEqual((state.status, state.admission), (Status.COMPATIBLE, "held"))
        state = transition(state, 11, "a", (), 3)
        self.assertEqual((state.status, state.admission), (Status.TIMED_OUT, "held"))
        self.assertEqual(transition(state, 12, "a", (), 3), state)

    def scratch(self):
        root = Path(subprocess.check_output(['mktemp', '-d', '-t', 'boat-native-guest-test.XXXXXX'], text=True).strip())
        def cleanup():
            print(json.dumps({'owned_test_scratch': str(root), 'entries': sorted(str(p.relative_to(root)) for p in root.rglob('*'))}))
            shutil.rmtree(root)
        self.addCleanup(cleanup)
        return root

    def test_real_mapping_identity_and_deleted_mapping(self):
        root = self.scratch()
        library = root / 'library.so'
        library.write_bytes(b'\0' * 4096)
        before = identity(os.getpid())
        with library.open('rb') as stream, mmap.mmap(stream.fileno(), 4096, prot=mmap.PROT_READ | mmap.PROT_EXEC):
            with patch('guest_boot.BUNDLE', root):
                mappings = executable_mappings(os.getpid())
            self.assertEqual(len(mappings), 1)
            self.assertEqual(mappings[0].sha256, file_identity(library).sha256)
            self.assertEqual(mappings[0].mapped_inode, file_identity(library).inode)
            print(json.dumps({'local_executable_mapping': asdict(mappings[0])}))
            failures = mapping_failures({str(library): file_identity(library)}, mappings, before, identity(os.getpid()))
            if mappings[0].mapped_device == mappings[0].observed_device:
                self.assertEqual(failures, [])
            else:
                self.assertEqual(failures, ['mapping-file-identity-mismatch:' + str(library)])
            print(json.dumps({'owned_mapping_before_delete': str(library)}))
            library.unlink()
            library.write_bytes(b'\0' * 4096)
            with patch('guest_boot.BUNDLE', root), self.assertRaisesRegex(ValueError, 'mapping-deleted'):
                executable_mappings(os.getpid())

    def test_cache_unknown_file_and_changed_packaged_file_hold(self):
        root = self.scratch()
        bundle = root / 'bundle'
        bundle.mkdir()
        program = bundle / 'python'
        program.write_bytes(b'program')
        manifest = ProtectedManifest('sealant-guest-manifest-v1', {str(program): file_identity(program)}, {}, (str(program),))
        verify_protected(manifest, bundle)
        cache = bundle / 'poison.pyc'
        cache.write_bytes(b'executable cache')
        with self.assertRaisesRegex(ValueError, 'bundle-closure-changed'):
            verify_protected(manifest, bundle)
        print(json.dumps({'owned_cache_before_delete': str(cache)}))
        cache.unlink()
        program.write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError, 'protected-file-changed'):
            verify_protected(manifest, bundle)

    def test_process_loss_is_observed_through_pidfd(self):
        child = subprocess.Popen(['sleep', '30'])
        held = HeldProcess(child.pid)
        try:
            child.terminate()
            child.wait(timeout=3)
            with self.assertRaisesRegex(ValueError, 'held-process-lost'):
                held.verify()
        finally:
            if child.poll() is None:
                child.kill()
                child.wait()
            held.close()

    def test_real_outer_process_is_not_a_workspace_writer(self):
        result = subprocess.run(['unshare', '--user', '--map-root-user', '--pid', '--fork', '--mount-proc',
                                 sys.executable, '-B', '-c',
                                 'import os; from guest_boot import census; assert os.getpid() not in '
                                 '[item["identity"]["pid"] for item in census()["processes"]]'],
                                cwd=Path(__file__).parent, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_gate_uses_actual_root_identity_instead_of_proc_symlink_text(self):
        root = self.scratch()
        info = root.stat()
        gate = replace(self.process, pid=43, root_device=info.st_dev, root_inode=info.st_ino,
                       mount_namespace=30, user_namespace=40, pid_namespace=50)
        candidates = [{'identity':asdict(self.process), 'root':'/'}, {'identity':asdict(gate), 'root':'/'}]
        self.assertEqual(mapped_gates(candidates, info, self.process), [candidates[1]])
        for key in ('root_inode','root_device','mount_namespace','user_namespace','pid_namespace'):
            value = getattr(self.process, key) if 'namespace' in key else getattr(gate, key)+1
            self.assertEqual(mapped_gates([{'identity':asdict(replace(gate, **{key:value})), 'root':str(root)}],
                                         info, self.process), [])

    def test_durable_history_retains_exceptions_and_bounds_timeout(self):
        root = self.scratch()
        journal = BootJournal(root, self.binding)
        state = initial_state(self.binding, 10, 4)
        journal.append(state)
        moments = [10.0]
        def clock():
            return moments[0]
        def sleep(seconds):
            moments[0] += seconds
        def inspect():
            raise ProcessLookupError('lost-process')
        ended = run_checks(state, journal, inspect, {'intervalSeconds': 1, 'stableObservations': 3}, clock, sleep)
        self.assertEqual((ended.status, ended.admission, clock()), (Status.TIMED_OUT, 'held', 14))
        records = [json.loads(path.read_text()) for path in sorted(journal.events.glob('*.json'))]
        self.assertEqual(records[0]['state']['status'], 'held')
        self.assertEqual(records[-1]['state']['status'], 'timed-out')
        self.assertTrue(any(record['state']['reasons'] == ['ProcessLookupError:lost-process'] for record in records))
        reopened = BootJournal(root, self.binding)
        reopened.append(ended)
        self.assertEqual(len(list(reopened.events.glob('*.json'))), len(records) + 1)
        self.assertEqual(json.loads((root / 'held-state.json').read_text())['state']['admission'], 'held')

    def test_three_stable_real_journal_observations_never_admit(self):
        root = self.scratch()
        journal = BootJournal(root, self.binding)
        state = initial_state(self.binding, 0, 10)
        journal.append(state)
        moments = [0]
        def clock():
            return moments[0]
        def sleep(seconds):
            moments[0] += seconds
        ended = run_checks(state, journal, lambda: ('approved', [], {'checks': 'passed'}),
                           {'intervalSeconds': 2, 'stableObservations': 3}, clock, sleep)
        self.assertEqual((ended.status, ended.stable, ended.admission, clock()), (Status.COMPATIBLE, 3, 'held', 4))
        self.assertTrue(all(json.loads(path.read_text())['state']['admission'] == 'held' for path in journal.events.glob('*.json')))

    def test_late_owner_binding_resets_stability_without_resetting_deadline(self):
        root = self.scratch()
        journal = BootJournal(root, self.binding)
        unbound = replace(self.binding, instance_id='unbound', disk_lineage='unbound')
        state = initial_state(unbound, 0, 10)
        journal.append(state)
        moments = [0]
        def clock():
            return moments[0]
        def sleep(seconds):
            moments[0] += seconds
        ended = run_checks(state, journal, lambda: ('approved', [], {}),
                           {'intervalSeconds': 2, 'stableObservations': 3}, clock, sleep,
                           lambda: unbound if clock() < 4 else self.binding)
        self.assertEqual((ended.binding, ended.first_invocation, ended.deadline, clock()), (self.binding, 0, 10, 8))
        self.assertEqual((ended.status, ended.stable, ended.admission), (Status.COMPATIBLE, 3, 'held'))

    def test_watchdog_holds_missing_stale_and_crashed_boots(self):
        state = initial_state(self.binding, 1, 4)
        for current in (None, replace(state, binding=replace(self.binding, boot_id='source'))):
            held = watchdog_state(current, self.binding.boot_id, 5)
            self.assertEqual((held.status, held.admission, held.binding.instance_id), (Status.TIMED_OUT, 'held', 'unbound'))
        ended = watchdog_state(replace(state, status=Status.CHECKING), self.binding.boot_id, 5)
        self.assertEqual((ended.status, ended.first_invocation, ended.deadline, ended.admission), (Status.TIMED_OUT, 1, 5, 'held'))
        self.assertIn('watchdog-held-deadline', ended.reasons)
        self.assertEqual(watchdog_state(ended, self.binding.boot_id, 99), ended)

    def test_durable_event_preserves_deadline_after_latest_state_write_fails(self):
        root = self.scratch()
        save = guest.save

        def crash_before_latest(path, value, exclusive=False):
            if path.name == 'held-state.json':
                raise OSError('injected latest-state write failure')
            return save(path, value, exclusive)

        with patch.object(guest, 'ROOT', root), patch.object(guest, 'boot_id', lambda: 'local-boot'), \
             patch.object(guest.time, 'monotonic', lambda: 10), patch.object(guest, 'save', crash_before_latest):
            with self.assertRaisesRegex(OSError, 'injected'):
                guest.held_boot()
        self.assertFalse((root / 'held-state.json').exists())
        with patch.object(guest, 'ROOT', root), patch.object(guest, 'boot_id', lambda: 'local-boot'), \
             patch.object(guest.time, 'monotonic', lambda: 100):
            actual = guest.held_boot()
        self.assertEqual((actual['first_invocation'], actual['deadline'], actual['status'], actual['admission']),
                         (10, 70, Status.TIMED_OUT, 'held'))

    def test_effective_held_service_policy_overrides_unit_text(self):
        original_read_text, original_stat = Path.read_text, Path.stat

        def read_text(path, *args, **kwargs):
            if str(path) == '/proc/self/uid_map':
                return '0 0 4294967295\n'
            return original_read_text(path, *args, **kwargs)

        def matching_namespace(path, *args, **kwargs):
            if str(path) == '/proc/1/ns/user':
                return original_stat(Path('/proc/self/ns/user'), *args, **kwargs)
            return original_stat(path, *args, **kwargs)

        base = Path(__file__).with_name('held.service').read_text()
        effective = {'NotifyAccess': 'none', 'FragmentPath': '/etc/systemd/system/sealant-held.service',
                     'DropInPaths': '', 'ExecStart': '{ path=' + guest.invoke('/usr/bin/python3')[0] +
                     ' ; argv[]=' + ' '.join(guest.invoke('/usr/bin/python3', '-I', '-S', '-B',
                                                        str(guest.ROOT / 'guest_boot.py'), 'boot')) +
                     ' ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }'}

        def fake_run(program, *args, **kwargs):
            if args == ('cat', 'sealant-held.service'):
                return base + '\n[Service]\nNotifyAccess=all\n'
            if args[:2] == ('show', 'sealant-held.service'):
                return ''.join(key + '=' + value + '\n' for key, value in effective.items())
            if args == ('show', 'sealant-workspace.service', '-p', 'MainPID', '--value'):
                return '0\n'
            raise AssertionError(args)

        with patch.object(guest, 'run', fake_run), patch.object(guest.os, 'getuid', lambda: 0), \
             patch.object(Path, 'read_text', read_text), patch.object(Path, 'stat', matching_namespace):
            self.assertEqual(guest.semantic_checks()['notify_access'], 'none')
            for changed in ({'NotifyAccess': 'all'},
                            {'DropInPaths': '/etc/systemd/system/sealant-held.service.d/override.conf'},
                            {'FragmentPath': '/run/systemd/system/sealant-held.service'},
                            {'ExecStart': effective['ExecStart'].replace('guest_boot.py boot', 'guest_boot.py admit')}):
                with self.subTest(changed=changed), patch.dict(effective, changed):
                    with self.assertRaisesRegex(ValueError, 'held-service-policy-mismatch'):
                        guest.semantic_checks()

    def test_failed_file_observation_survives_in_journal_without_weakening_guard(self):
        root = self.scratch()
        root.chmod(0o700)
        bundle = root / 'bundle'
        bundle.mkdir()
        program = bundle / 'program'
        program.write_bytes(b'unchanged protected bytes')
        expected = file_identity(program)
        manifest = ProtectedManifest('sealant-guest-manifest-v1', {str(program): expected}, {}, (str(program),))
        original_digest = guest.digest
        moments = [10]

        def change_mode_after_read(data):
            info = program.stat()
            program.chmod((info.st_mode & 0o777) ^ 0o004)
            return original_digest(data)

        def sleep(seconds):
            moments[0] += seconds

        journal = BootJournal(root, self.binding)
        with patch.object(guest, 'ROOT', root), patch.object(guest, 'BUNDLE', bundle), \
             patch.object(guest, 'digest', change_mode_after_read):
            ended = run_checks(initial_state(self.binding, 10, 4), journal,
                               lambda: guest.check(manifest, {}, None, []),
                               {'intervalSeconds': 2, 'stableObservations': 3}, lambda: moments[0], sleep)
        self.assertEqual((ended.status, ended.admission), (Status.TIMED_OUT, 'held'))
        records = [json.loads(path.read_text()) for path in journal.paths()]
        failures = [record['observation'] for record in records if record['observation'] is not None]
        self.assertEqual(len(failures), 3)
        for observation in failures:
            file = observation['file_failure']
            self.assertEqual((file['path'], file['sha256'], file['expected_sha256']),
                             (str(program), expected.sha256, expected.sha256))
            self.assertEqual(set(file['before']), {'dev', 'ino', 'mtime_ns', 'ctime_ns', 'uid', 'gid', 'mode', 'size', 'nlink'})
            self.assertNotEqual(file['before']['mode'], file['after']['mode'])
            self.assertGreaterEqual(file['read_finished_monotonic'], file['read_started_monotonic'])
            self.assertEqual(observation['check']['binding'], asdict(self.binding))
        self.assertEqual([observation['check']['index'] for observation in failures], [0, 2, 4])

    def test_authoritative_journal_beats_stale_cache_and_refuses_gaps(self):
        root = self.scratch()
        journal = BootJournal(root, self.binding)
        compatible = replace(initial_state(self.binding, 0, 60), status=Status.COMPATIBLE)
        journal.append(compatible)
        cache = (root / 'held-state.json').read_bytes()
        incompatible = replace(compatible, status=Status.INCOMPATIBLE, reasons=('mapping-deleted',))
        journal.append(incompatible)
        (root / 'held-state.json').write_bytes(cache)
        self.assertEqual(BootJournal(root, self.binding).current(), incompatible)
        first = journal.paths()[0]
        print(json.dumps({'owned_journal_event_before_delete': str(first)}))
        first.unlink()
        with self.assertRaisesRegex(ValueError, 'held-journal-sequence-gap'):
            BootJournal(root, self.binding)


if __name__ == "__main__":
    unittest.main()
