from dataclasses import asdict
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import guest_boot as guest
from guest_contract import approved_profile, canonical, digest


class OwnedPolicyTests(unittest.TestCase):
    def policy(self):
        return {'format': 'sealant-boot-policy-v2', 'profile': 'sealant-shipped-guest-v1',
                'retry': {'deadlineSeconds': 60, 'intervalSeconds': 2, 'stableObservations': 3},
                'admission': 'unavailable-pending-authenticated-receiver'}

    def approval(self, policy, manifest):
        return {'format': 'sealant-source-profile-approval-v2', 'profile': policy['profile'],
                'policy_digest': digest(canonical(policy)), 'manifest_digest': manifest,
                'semantic_checks': 'passed-with-shipped-assets'}

    def test_startup_never_reads_base_image_hashes(self):
        policy = self.policy()
        manifest = SimpleNamespace(bytes=lambda: b'exact manifest')
        approval = self.approval(policy, digest(manifest.bytes()))
        with patch.object(guest, 'ROOT', SimpleNamespace(stat=lambda: SimpleNamespace(st_uid=0, st_mode=0o40700))), \
             patch.object(guest, 'verify_protected', return_value='verified shipped files') as protected, \
             patch.object(guest, 'file_identity', side_effect=AssertionError('base-image file read')), \
             patch.object(guest, 'owned_units', return_value={}), \
             patch.object(guest, 'semantic_checks', return_value={'checked': True}), \
             patch.object(guest, 'census', return_value={'processes': []}), \
             patch.object(guest.sys, 'path', []):
            profile, reasons, observation = guest.check(manifest, policy, approval, [])
        self.assertEqual(reasons, [])
        self.assertEqual(profile, policy['profile'])
        self.assertNotIn('provider_files', observation)
        protected.assert_called_once_with(manifest, guest.BUNDLE)

    def test_exact_manifest_policy_and_semantics_still_required(self):
        policy = self.policy()
        approval = self.approval(policy, 'c' * 64)
        self.assertEqual(approved_profile(policy, approval, 'c' * 64), policy['profile'])
        self.assertIsNone(approved_profile(policy, None, 'c' * 64))
        for key in approval:
            with self.subTest(key=key):
                self.assertIsNone(approved_profile(policy, {**approval, key: 'wrong'}, 'c' * 64))
        self.assertIsNone(approved_profile(policy, approval, 'd' * 64))
        self.assertIsNone(approved_profile({**policy, 'profile': 'other'}, approval, 'c' * 64))

    def test_production_policy_has_no_base_image_sets(self):
        policy = json.loads(Path(__file__).with_name('boot-policy.json').read_bytes())
        self.assertEqual(policy, self.policy())


if __name__ == '__main__':
    unittest.main()
