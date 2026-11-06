import sys
from pathlib import Path

sys.dont_write_bytecode = True
if len(sys.argv) > 1 and sys.argv[1] == "bundle":
    sys.path.insert(0, str(Path(__file__).resolve().parent))

from dataclasses import asdict
import json
import os
import re
import shutil
import subprocess
import sysconfig
import time
import zipfile

from guest_contract import ProtectedManifest, canonical, digest, initial_state
from guest_boot import (
    BUNDLE, ROOT, MAPPED_ROOT, BootJournal, HeldProcess, binding_for, boot_id,
    check, file_identity, invoke, launch_mapped, private_json, save,
)


def copy_dependency(source, destination):
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
    shutil.copyfile(source, destination)
    os.chmod(destination, Path(source).stat().st_mode & 0o777)
    if destination.stat().st_ino == Path(source).stat().st_ino and destination.stat().st_dev == Path(source).stat().st_dev:
        raise ValueError('shared-protected-inode')


def dependencies(program):
    result = subprocess.run(['/usr/bin/ldd', str(program)], check=True, text=True, capture_output=True)
    if 'not found' in result.stdout:
        raise ValueError('missing-library:' + str(program))
    return [Path(match.group(1)) for line in result.stdout.splitlines()
            if (match := re.search(r'(?:=>\s+)?(/[^\s]+)', line))]


def build_bundle():
    BUNDLE.mkdir(mode=0o755)
    sources = {}
    binaries = [Path('/usr/bin/python3'), Path('/usr/bin/systemd-nspawn'),
                Path('/usr/bin/systemd-run'), Path('/usr/bin/systemctl'), Path('/usr/bin/node')]
    stdlib = Path(sysconfig.get_path('stdlib'))
    for program in [*binaries, *sorted((stdlib / 'lib-dynload').glob('*.so'))]:
        target = BUNDLE / str(program).lstrip('/')
        source_program = ROOT / 'native-node' if program == Path('/usr/bin/node') else program
        copy_dependency(source_program, target)
        sources[str(source_program)] = asdict(file_identity(source_program.resolve()))
        for source in dependencies(source_program):
            destination = BUNDLE / str(source).lstrip('/')
            if not destination.exists():
                copy_dependency(source, destination)
                sources[str(source)] = asdict(file_identity(source.resolve()))
    archive = BUNDLE / f'usr/lib/python{sys.version_info.major}{sys.version_info.minor}.zip'
    archive.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_STORED) as output:
        for name in ('guest_boot.py', 'guest_contract.py', 'guest_receiver.py'):
            source = ROOT / name
            output.writestr(name, source.read_bytes())
            sources[str(source)] = {'sha256': digest(source.read_bytes()), 'mode': source.stat().st_mode & 0o777}
        for source in sorted(stdlib.rglob('*.py')):
            relative = source.relative_to(stdlib)
            if any(part in ('__pycache__', 'site-packages', 'dist-packages', 'test', 'tests') for part in relative.parts):
                continue
            info = zipfile.ZipInfo(str(relative), (2026, 1, 1, 0, 0, 0))
            info.external_attr = 0o644 << 16
            output.writestr(info, source.read_bytes())
            sources[str(source)] = {'sha256': digest(source.read_bytes()), 'mode': source.stat().st_mode & 0o777}
    os.chmod(archive, 0o644)
    save(ROOT / 'bundle-inputs.json', {'format': 'sealant-bundle-inputs-v1', 'source_files': sources,
                                     'stdlib': str(stdlib), 'cache_policy': 'source-only-zip-no-bytecode'})


def manifest():
    files = [path for path in BUNDLE.rglob('*') if path.is_file()]
    files += [ROOT / name for name in ('guest_boot.py', 'guest_contract.py', 'build_guest.py',
                                      'workspace-launch.py', 'guest_receiver.py', 'bootstrap-crypto.mjs',
                                      'boot-policy.json', 'bundle-inputs.json',
                                      'project-install.sh', 'native-inputs.json')]
    files += [Path('/etc/systemd/system') / name for name in (
        'sealant-held.service', 'sealant-held-watchdog.service', 'sealant-held-watchdog.timer', 'sealant-workspace.service',
        'sealant-bootstrap.service', 'sealant-control-relay.service')]
    files += [Path('/usr/local/lib/sealant/control-relay.cjs')]
    value = ProtectedManifest('sealant-guest-manifest-v1', {str(path): file_identity(path) for path in files},
                              private_json(ROOT / 'native-inputs.json'),
                              tuple(sorted(str(path) for path in BUNDLE.rglob('*') if path.is_file())))
    save(ROOT / 'manifest.json', json.loads(value.bytes()))
    return value


def approve_source():
    value = ProtectedManifest.parse(private_json(ROOT / 'manifest.json'))
    policy = json.loads((ROOT / 'boot-policy.json').read_text())
    approval = {'format': 'sealant-source-profile-approval-v2', 'profile': policy['profile'],
                'policy_digest': digest(canonical(policy)), 'manifest_digest': digest(value.bytes()),
                'semantic_checks': 'passed-with-shipped-assets', 'source_boot_id': boot_id()}
    held = [HeldProcess(os.getpid())]
    try:
        profile, reasons, observations = check(value, policy, approval, held)
        if reasons or profile != approval['profile']:
            save(ROOT / 'source-failure.json', {'reasons': reasons, 'observation': observations})
            raise ValueError('source-profile-not-compatible:' + ','.join(reasons))
        script = ROOT / 'source-semantics.sh'
        script.write_text('set -eu\n'
                          'test "$(id -u)" = 0\n'
                          'test "$(cat /proc/self/uid_map | xargs)" = "0 131072 65536"\n'
                          'test ! -S /run/systemd/private\n'
                          'test ! -S /run/dbus/system_bus_socket\n'
                          'test -f /sys/fs/cgroup/cgroup.controllers\n'
                          'cat /proc/self/uid_map /proc/self/gid_map /proc/self/cgroup\n'
                          'readlink /proc/self/ns/mnt /proc/self/ns/pid /proc/self/ns/user\n')
        script.chmod(0o644)
        receipt = ROOT / 'source-semantics.json'
        result = launch_mapped('probe', script, value, held, observations, receipt, {'source_semantics': True})
        if result['exit_code'] != 0:
            raise ValueError('shipped-mapped-launcher-semantic-failure')
        save(ROOT / 'source-semantic-observations.json', observations)
        approval['semantic_receipt_digest'] = digest(receipt.read_bytes())
        save(ROOT / 'source-approval.json', approval, exclusive=True)
        return approval
    finally:
        for process in held:
            process.close()


def main():
    os.umask(0o077)
    if os.geteuid() != 0:
        raise ValueError('outer-owner-required')
    action = sys.argv[1]
    if action == 'bundle':
        os.umask(0o022)
        build_bundle()
        os.umask(0o077)
        value = manifest()
        state = initial_state(binding_for(digest(value.bytes()), None), time.monotonic(), 60)
        BootJournal(ROOT, state.binding).append(state, {'construction': 'held-before-source-inspection'})
        print(json.dumps({'manifest_digest': digest(value.bytes()), 'files': len(value.files)}))
    elif action == 'approve-source':
        print(json.dumps(approve_source(), sort_keys=True))
    else:
        raise ValueError('unsupported-construction-action')


if __name__ == '__main__':
    main()
