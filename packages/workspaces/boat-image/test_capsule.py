import ctypes
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import stat
import tempfile
import signal
import time
import unittest

import guest_capsule as capsule
from guest_contract import canonical, digest


class CapsuleTests(unittest.TestCase):
    def setUp(self):
        self.scratch = Path(tempfile.mkdtemp(prefix='boat-capsule-test.'))
        self.addCleanup(self.cleanup)
        self.root = self.scratch / 'root'
        self.volume = self.root / 'tmp'
        self.volume.mkdir(parents=True)
        self.destination = self.scratch / 'capsule'
        self.restored = self.scratch / 'restored'
        self.binding = {'boot_id': 'source', 'identity': {'instance_id': 'source', 'disk_lineage': 'disk'}, 'epoch': 1}
        self.volumes = [{'path': '/tmp', 'mount_id': 2, 'device': '0:2', 'exclude': []}]
        self.descriptor = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY)
        self.addCleanup(os.close, self.descriptor)

    def cleanup(self):
        print(json.dumps({'ownedScratch': str(self.scratch), 'entries': sorted(str(p.relative_to(self.scratch))
                                                                          for p in self.scratch.rglob('*'))}))
        shutil.rmtree(self.scratch)
        self.assertFalse(self.scratch.exists())

    def export(self, **options):
        return capsule.export(self.descriptor, self.volumes, self.destination, self.binding, **options)

    def hydrate(self, receipt):
        return capsule.hydrate(self.destination, receipt['sha256'], self.binding, self.restored)

    def test_deadline_interrupts_a_blocked_export_and_restores_the_signal_handler(self):
        previous = signal.getsignal(signal.SIGALRM)
        with self.assertRaisesRegex(capsule.CapsuleRefusal, 'capsule-deadline'):
            with capsule.deadline(0.01):
                time.sleep(10)
        self.assertEqual(signal.getsignal(signal.SIGALRM), previous)
        self.assertEqual(signal.getitimer(signal.ITIMER_REAL), (0.0, 0.0))

    def test_real_bytes_metadata_links_xattrs_and_empty_directories_survive_namespace_teardown(self):
        directory = self.volume / 'nested'
        directory.mkdir(mode=0o711)
        (directory / 'empty').mkdir()
        file = directory / 'work'
        file.write_bytes(bytes(range(256)) * 400)
        file.chmod(0o640)
        os.setxattr(file, 'user.sealant-proof', b'changed\x00metadata')
        os.link(file, self.volume / 'alias')
        (directory / 'link').symlink_to('../alias')
        os.mkfifo(directory / 'fifo', 0o620)
        server = socket.socket(socket.AF_UNIX)
        server.bind(str(directory / 'socket'))
        self.addCleanup(server.close)
        os.utime(file, ns=(1234567890123456789, 1234567890123456789))
        receipt = self.export()
        shutil.rmtree(self.volume)
        mounts = self.hydrate(receipt)
        self.assertEqual(mounts, [{'path': '/tmp', 'source': str(self.restored / '0')}])
        root = self.restored / '0'
        self.assertEqual((root / 'nested/work').read_bytes(), bytes(range(256)) * 400)
        self.assertEqual((root / 'nested/work').stat().st_ino, (root / 'alias').stat().st_ino)
        self.assertEqual(stat.S_IMODE((root / 'nested/work').stat().st_mode), 0o640)
        self.assertEqual((root / 'nested/work').stat().st_mtime_ns, 1234567890123456789)
        self.assertEqual(os.getxattr(root / 'alias', 'user.sealant-proof'), b'changed\x00metadata')
        self.assertEqual(os.readlink(root / 'nested/link'), '../alias')
        self.assertTrue(stat.S_ISFIFO((root / 'nested/fifo').stat().st_mode))
        self.assertTrue((root / 'nested/empty').is_dir())
        self.assertFalse((root / 'nested/socket').exists())

    def test_pins_directory_descriptors_and_never_reads_an_outside_symlink(self):
        outside = self.scratch / 'private'
        outside.write_bytes(b'outside bytes must not be copied')
        (self.volume / 'link').symlink_to(outside)
        receipt = self.export()
        self.hydrate(receipt)
        self.assertEqual(os.readlink(self.restored / '0/link'), str(outside))
        manifest = json.loads((self.destination / 'manifest.json').read_bytes())
        self.assertEqual(manifest['bytes'], 0)
        self.assertEqual(list((self.destination / 'objects').iterdir()), [])

    def test_mount_path_symlink_refuses(self):
        outside = self.scratch / 'outside'
        outside.mkdir()
        self.volume.rmdir()
        self.volume.symlink_to(outside)
        with self.assertRaises(OSError):
            self.export()
        self.assertFalse((self.destination / 'manifest.json').exists())

    def test_nested_mount_and_launch_secrets_are_excluded(self):
        (self.volume / 'inputs').mkdir()
        (self.volume / 'inputs/secret-env').write_bytes(b'synthetic secret')
        (self.volume / 'work').write_bytes(b'work')
        self.volumes[0]['exclude'] = ['/tmp/inputs']
        receipt = self.export()
        self.hydrate(receipt)
        self.assertFalse((self.restored / '0/inputs').exists())
        self.assertEqual((self.restored / '0/work').read_bytes(), b'work')
        self.assertEqual(receipt['bytes'], 4)

    def test_lost_or_repeated_export_cannot_overwrite_the_original(self):
        (self.volume / 'work').write_bytes(b'first')
        receipt = self.export()
        (self.volume / 'work').write_bytes(b'changed')
        with self.assertRaises(FileExistsError):
            self.export()
        self.hydrate(receipt)
        self.assertEqual((self.restored / '0/work').read_bytes(), b'first')
        with self.assertRaises(FileExistsError):
            self.hydrate(receipt)

    def test_digest_binding_and_object_corruptions_refuse_before_hydration(self):
        file = self.volume / 'work'
        file.write_bytes(b'work')
        receipt = self.export()
        with self.assertRaisesRegex(capsule.CapsuleRefusal, 'digest-mismatch'):
            self.hydrate({**receipt, 'sha256': '0' * 64})
        with self.assertRaisesRegex(capsule.CapsuleRefusal, 'binding-conflict'):
            capsule.hydrate(self.destination, receipt['sha256'], {**self.binding, 'epoch': 2}, self.restored)
        (self.destination / 'objects' / hashlib.sha256(b'work').hexdigest()).write_bytes(b'lost')
        with self.assertRaisesRegex(capsule.CapsuleRefusal, 'object-changed'):
            self.hydrate(receipt)
        self.assertFalse(self.restored.exists())

    def test_external_hardlinks_refuse_instead_of_breaking_their_identity(self):
        (self.volume / 'work').write_bytes(b'work')
        os.link(self.volume / 'work', self.root / 'outside')
        with self.assertRaisesRegex(capsule.CapsuleRefusal, 'external-hardlink'):
            self.export()
        self.assertFalse((self.destination / 'manifest.json').exists())

    def test_entry_and_byte_budgets_never_commit_a_partial_capsule(self):
        (self.volume / 'work').write_bytes(b'work')
        with self.assertRaisesRegex(capsule.CapsuleRefusal, 'byte-limit'):
            self.export(max_bytes=3)
        self.assertFalse((self.destination / 'manifest.json').exists())
        shutil.rmtree(self.destination)
        with self.assertRaisesRegex(capsule.CapsuleRefusal, 'entry-limit'):
            self.export(max_entries=1)
        self.assertFalse((self.destination / 'manifest.json').exists())

    def test_malformed_committed_tree_cannot_escape_private_hydration(self):
        (self.volume / 'work').write_bytes(b'work')
        self.export()
        original = json.loads((self.destination / 'manifest.json').read_bytes())
        for path in ('../outside', '/absolute', 'double//path', 'dots/./path'):
            manifest = json.loads(json.dumps(original))
            manifest['volumes'][0]['entries'][-1]['path'] = path
            raw = canonical(manifest)
            (self.destination / 'manifest.json').write_bytes(raw)
            with self.subTest(path=path), self.assertRaises(capsule.CapsuleRefusal):
                capsule.hydrate(self.destination, digest(raw), self.binding, self.restored)
            self.assertFalse(self.restored.exists())

    def test_mount_plan_keeps_user_tmpfs_and_refuses_unknown_writable_storage(self):
        root = '1 0 8:1 / / rw - ext4 /dev/root rw\n'
        document = root + '\n'.join([
            '2 1 0:2 / /run rw - tmpfs tmpfs rw',
            '3 1 0:3 / /dev rw - tmpfs tmpfs rw',
            '4 3 0:4 / /dev/shm rw - tmpfs tmpfs rw',
            '5 1 0:5 / /proc rw - proc proc rw',
            '6 2 8:1 /inputs /run/sealant-inputs ro - ext4 /dev/root rw',
            '7 1 0:7 / /tmp rw - tmpfs tmpfs rw',
            '8 7 0:8 / /tmp/with\\040space rw - tmpfs tmpfs rw'])
        planned = capsule.plan(document)
        self.assertEqual([mount['path'] for mount in planned], ['/dev/shm', '/run', '/tmp', '/tmp/with space'])
        self.assertIn('/run/sealant-inputs', planned[1]['exclude'])
        self.assertIn('/tmp/with space', planned[2]['exclude'])
        with self.assertRaisesRegex(capsule.CapsuleRefusal, 'unsupported-writable-mount'):
            capsule.plan(root + '2 1 0:2 / /work rw - fuse.remote remote rw')
        with self.assertRaisesRegex(capsule.CapsuleRefusal, 'ambiguous-root'):
            capsule.plan(document + '\n' + root)
        restored = root + '2 1 8:1 /resume-1/0 /tmp rw - ext4 /dev/root rw'
        self.assertEqual(capsule.plan(restored), [])
        self.assertEqual([mount['path'] for mount in capsule.plan(restored, ['/tmp'])], ['/tmp'])
        with self.assertRaisesRegex(capsule.CapsuleRefusal, 'retained-volume-missing'):
            capsule.plan(root, ['/tmp'])

    def test_actual_tmpfs_loss_and_hydration(self):
        libc = ctypes.CDLL(None, use_errno=True)
        if libc.mount(b'tmpfs', os.fsencode(self.volume), b'tmpfs', 0, b'size=2m') != 0:
            self.fail('Run guest capsule tests in an isolated user/mount namespace with mount support')
        try:
            (self.volume / 'work').write_bytes(b'volatile edited work')
            receipt = self.export()
        finally:
            self.assertEqual(libc.umount2(os.fsencode(self.volume), 0), 0)
        self.assertFalse((self.volume / 'work').exists())
        self.hydrate(receipt)
        self.assertEqual((self.restored / '0/work').read_bytes(), b'volatile edited work')

    def test_immutable_pack_reconstructs_after_original_objects_are_lost(self):
        (self.volume / 'work').write_bytes(b'preserved in one immutable file')
        receipt = self.export()
        shutil.rmtree(self.destination / 'objects')
        (self.destination / 'manifest.json').unlink()
        restored_capsule = self.scratch / 'unpacked'
        manifest = capsule.unpack(self.destination / 'capsule.pack', receipt['archive_sha256'], self.binding, restored_capsule)
        self.assertEqual(manifest['bytes'], len(b'preserved in one immutable file'))
        capsule.hydrate(restored_capsule, receipt['sha256'], self.binding, self.restored)
        self.assertEqual((self.restored / '0/work').read_bytes(), b'preserved in one immutable file')

    def test_malformed_pack_and_wrong_digest_never_hydrate(self):
        (self.volume / 'work').write_bytes(b'work')
        receipt = self.export()
        for index, data in enumerate((b'bad magic', (self.destination / 'capsule.pack').read_bytes()[:-1],
                                      (self.destination / 'capsule.pack').read_bytes() + b'extra')):
            file = self.scratch / ('bad-' + str(index))
            file.write_bytes(data)
            with self.subTest(index=index), self.assertRaises(capsule.CapsuleRefusal):
                capsule.unpack(file, receipt['archive_sha256'], self.binding, self.scratch / ('refused-' + str(index)))
        with self.assertRaisesRegex(capsule.CapsuleRefusal, 'pack-mismatch'):
            capsule.unpack(self.destination / 'capsule.pack', '0' * 64, self.binding, self.scratch / 'wrong-hash')
        self.assertFalse(self.restored.exists())


if __name__ == '__main__':
    unittest.main()
