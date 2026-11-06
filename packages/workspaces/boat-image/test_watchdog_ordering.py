import configparser
import json
from pathlib import Path
import shutil
import subprocess
import unittest
from unittest.mock import patch

import guest_boot as guest


class WatchdogOrderingTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(subprocess.check_output(
            ['mktemp', '-d', '-t', 'boat-watchdog-ordering-test.XXXXXX'], text=True).strip())
        self.addCleanup(self.cleanup)

    def cleanup(self):
        print(json.dumps({'owned_test_scratch': str(self.root),
                          'entries': sorted(str(p.relative_to(self.root)) for p in self.root.rglob('*'))}))
        shutil.rmtree(self.root)

    def test_shipped_watchdog_waits_for_held_oneshot_completion(self):
        units = {}
        for name in ('held.service', 'watchdog.service', 'watchdog.timer'):
            unit = configparser.ConfigParser(interpolation=None)
            unit.read(Path(__file__).with_name(name))
            units[name] = unit
        held, watchdog, timer = (units[name] for name in units)
        self.assertEqual(held['Service']['Type'], 'oneshot')
        self.assertEqual(held['Service']['Restart'], 'no')
        self.assertEqual(held['Service']['TimeoutStartSec'], '70')
        self.assertEqual(set(watchdog['Unit']['After'].split()),
                         {'local-fs.target', 'sealant-held.service'})
        self.assertNotIn('Requires', watchdog['Unit'])
        self.assertTrue(held['Service']['ExecStart'].endswith('guest_boot.py boot'))
        self.assertTrue(watchdog['Service']['ExecStart'].endswith('guest_boot.py watchdog'))
        self.assertEqual(timer['Timer']['OnBootSec'], '5')
        self.assertEqual(timer['Timer']['OnUnitActiveSec'], '5')
        policy = json.loads(Path(__file__).with_name('boot-policy.json').read_text())
        self.assertEqual(policy['retry'],
                         {'deadlineSeconds': 60, 'intervalSeconds': 2, 'stableObservations': 3})

    def test_watchdog_before_first_held_write_permanently_refuses(self):
        with patch.object(guest, 'ROOT', self.root), patch.object(guest, 'boot_id', return_value='cold'):
            with patch.object(guest.time, 'monotonic', return_value=10):
                first = guest.watchdog()
            with patch.object(guest.time, 'monotonic', return_value=12):
                later = guest.held_boot()
        self.assertEqual(first['reasons'], ('watchdog-missing-current-boot-inspection',))
        for state in (first, later):
            self.assertEqual((state['status'], state['admission'], state['first_invocation'], state['deadline']),
                             ('timed-out', 'held', 10, 10))

    def test_completed_failed_held_preserves_original_deadline(self):
        with patch.object(guest, 'ROOT', self.root), patch.object(guest, 'boot_id', return_value='cold'):
            with patch.object(guest.time, 'monotonic', return_value=12):
                held = guest.held_boot()
            with patch.object(guest.time, 'monotonic', return_value=20):
                early = guest.watchdog()
            with patch.object(guest.time, 'monotonic', return_value=82):
                terminal = guest.watchdog()
        self.assertEqual(held['status'], 'incompatible')
        self.assertEqual(early, held)
        self.assertEqual(terminal['status'], 'timed-out')
        self.assertIn('watchdog-held-deadline', terminal['reasons'])
        for state in (held, early, terminal):
            self.assertEqual((state['first_invocation'], state['deadline'], state['admission']), (12, 72, 'held'))

    def test_stale_journal_cannot_replace_missing_current_invocation(self):
        with patch.object(guest, 'ROOT', self.root), patch.object(guest, 'boot_id', return_value='source'), \
             patch.object(guest.time, 'monotonic', return_value=1):
            guest.held_boot()
        with patch.object(guest, 'ROOT', self.root), patch.object(guest, 'boot_id', return_value='cold'), \
             patch.object(guest.time, 'monotonic', return_value=80):
            state = guest.watchdog()
        self.assertEqual(state['binding']['boot_id'], 'cold')
        self.assertEqual((state['status'], state['admission'], state['first_invocation'], state['deadline']),
                         ('timed-out', 'held', 80, 80))
        self.assertEqual(state['reasons'], ('watchdog-missing-current-boot-inspection',))

    def test_passing_inspection_after_original_deadline_cannot_become_compatible(self):
        binding = guest.BootBinding('cold', 'instance', 'disk', 'manifest', 'approved')
        state = guest.initial_state(binding, 12, 60)
        journal = guest.BootJournal(self.root, binding)
        journal.append(state)
        moments = iter((71, 73))
        ended = guest.run_checks(state, journal, lambda: ('approved', [], {}),
                                {'intervalSeconds': 2, 'stableObservations': 3},
                                clock=lambda: next(moments))
        self.assertEqual((ended.status, ended.admission, ended.first_invocation, ended.deadline),
                         ('timed-out', 'held', 12, 72))


if __name__ == '__main__':
    unittest.main()
