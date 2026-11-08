"""One ordinary sealantd boot per accepted disk. Ambiguity never authorizes setup replay."""
from dataclasses import asdict
import json
import os
from pathlib import Path
import re
import stat

import guest_boot as guest
import guest_receiver as receiver
from guest_contract import ProtectedManifest, canonical, digest

UNIT = 'sealant-workspace.service'


def path():
    return guest.ROOT / 'invocation.json'


def state(record_path=None):
    value = guest.private_json(path() if record_path is None else record_path)
    receiver.fields(value, {'format', 'binding', 'status', 'owner', 'launcher', 'gate', 'exit_code'})
    if value['format'] != 'sealant-invocation-v1' or value['status'] not in ('issued', 'launching', 'running', 'ended', 'unresolved'):
        raise receiver.Refusal('invalid-invocation-record')
    return value


def binding():
    disk = receiver.disk_state()
    admission = disk['admission']
    if admission is None or admission['status'] != 'installed' or admission['boot_id'] != guest.boot_id():
        raise receiver.Refusal('invocation-stage-unavailable')
    return {'identity': disk['identity'], 'boot_id': guest.boot_id(), 'epoch': admission['epoch'],
            'operation_id': admission['operation_id']}


def observe(record_path=None, unit=UNIT):
    record_path = path() if record_path is None else record_path
    if not record_path.exists():
        return 'unavailable'
    record = state(record_path)
    if record['status'] in ('ended', 'unresolved'):
        return record['status']
    if record['binding']['boot_id'] != guest.boot_id():
        guest.save(record_path, {**record, 'status': 'unresolved'})
        return 'unresolved'
    if record['status'] == 'issued':
        # Intent may still be queued in systemd. Never issue it a second time.
        return 'issued'
    try:
        import guest_network
        guest_network.verify(record['binding'], record['gate']['pid'] if record['status'] == 'running' else None)
        current = unit_identity(unit)
        if current != record['owner']:
            raise ValueError('invocation-owner-changed')
        if record['status'] == 'launching':
            return 'issued'
        held = []
        try:
            for key in ('launcher', 'gate'):
                expected = record[key]
                process = guest.HeldProcess(expected['pid'])
                held.append(process)
                actual = asdict(process.identity)
                if key == 'gate':
                    # PID1 execs the fixed daemon after the verified gate handshake.
                    executable = Path('/proc') / str(expected['pid']) / 'exe'
                    shipped = guest.ROOT / 'sealantd'
                    if actual == expected:
                        current_executable = executable.stat()
                        shipped_executable = shipped.stat()
                        if (current_executable.st_dev, current_executable.st_ino) != (shipped_executable.st_dev, shipped_executable.st_ino):
                            return 'issued'
                    if os.readlink(executable).endswith(' (deleted)'):
                        raise ValueError('invocation-deleted-daemon')
                    expected_file = guest.file_identity(shipped)
                    with executable.open('rb') as stream:
                        before = os.fstat(stream.fileno())
                        measured = digest(stream.read())
                        after = os.fstat(stream.fileno())
                    fields = ('st_dev', 'st_ino', 'st_uid', 'st_gid', 'st_mode', 'st_size', 'st_nlink')
                    if (any(getattr(before, field) != getattr(after, field) for field in fields) or
                            (before.st_dev, before.st_ino, measured) != (expected_file.device, expected_file.inode, expected_file.sha256)):
                        raise ValueError('invocation-daemon-mismatch')
                    for field in ('executable_device', 'executable_inode'):
                        actual.pop(field)
                        expected = {name: value for name, value in expected.items() if name != field}
                if actual != expected:
                    raise ValueError('invocation-process-changed')
                process.verify()
        finally:
            for process in held:
                process.close()
        return 'running'
    except (OSError, ValueError, KeyError, TypeError):
        guest.save(record_path, {**record, 'status': 'unresolved'})
        return 'unresolved'


def unit_identity(unit=UNIT):
    raw = guest.run('/usr/bin/systemctl', 'show', unit, '-p', 'InvocationID', '-p', 'MainPID')
    properties = dict(line.split('=', 1) for line in raw.splitlines())
    invocation = properties.get('InvocationID', '')
    if not re.fullmatch(r'[a-f0-9]{32}', invocation):
        raise ValueError('missing-systemd-invocation')
    return {'systemd_invocation': invocation, 'process': asdict(guest.identity(int(properties['MainPID'])))}


def start(request):
    if (guest.ROOT / 'recovery.json').exists():
        raise receiver.Refusal('ordinary-invocation-closed')
    receiver.fields(request, {'format', 'identity', 'boot_id', 'epoch', 'operation_id'})
    receiver.fields(request['identity'], receiver.IDENTITY_KEYS)
    if type(request['epoch']) is not int or not 1 <= request['epoch'] <= 9007199254740991:
        raise receiver.Refusal('invalid-invocation-epoch')
    for value in [*request['identity'].values(), request['boot_id'], request['operation_id']]:
        receiver.name(value)
    expected = binding()
    if request != {'format': 'sealant-invocation-start-v1', **expected}:
        raise receiver.Refusal('invocation-binding-conflict')
    if path().exists():
        if state()['binding'] != expected:
            raise receiver.Refusal('disk-invocation-conflict')
        return receiver.status()
    # Only the authenticated isolation owner may install the current-epoch permit.
    permit = guest.private_json(receiver.RUNTIME / 'execution-permit.json') if (receiver.RUNTIME / 'execution-permit.json').exists() else None
    if not isinstance(permit, dict) or permit.get('binding') != expected or permit.get('format') != 'sealant-execution-permit-v2':
        raise receiver.Refusal('isolation-permit-unavailable')
    receiver.fields(permit, {'format', 'binding', 'resource_receipt', 'tunnel_receipt', 'limits'})
    if any(not isinstance(permit[key], str) or not re.fullmatch('[a-f0-9]{64}', permit[key]) for key in ('resource_receipt', 'tunnel_receipt')):
        raise receiver.Refusal('invalid-isolation-permit')
    import guest_network
    import guest_readiness
    guest_readiness.verify_permit(expected)
    guest_network.verify(expected)
    manifest, held, _ = guest.revalidate()
    try:
        for process in held:
            process.verify()
        guest.save(path(), {'format': 'sealant-invocation-v1', 'binding': expected, 'status': 'issued',
                           'owner': None, 'launcher': None, 'gate': None, 'exit_code': None}, exclusive=True)
        guest.run('/usr/bin/systemctl', '--no-block', 'start', UNIT)
        return receiver.status()
    finally:
        for process in held:
            process.close()


def payload(record):
    epoch = str(record['binding']['epoch'])
    manifest = guest.private_json(receiver.RUNTIME / ('manifest-' + epoch + '.json'))
    disk = receiver.disk_state()
    if digest(canonical(manifest)) != disk['admission']['digest']:
        raise receiver.Refusal('staged-manifest-changed')
    directory = receiver.RUNTIME / ('epoch-' + epoch)
    destination = receiver.RUNTIME / ('launch-' + epoch)
    destination.mkdir(mode=0o700)
    for entry in manifest['files']:
        source = directory / entry['name']
        descriptor = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(descriptor, 'rb') as stream:
            info = os.fstat(stream.fileno())
            data = stream.read(receiver.MAX_BYTES + 1)
        if (not stat.S_ISREG(info.st_mode) or (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode), info.st_nlink) != (0, 0, 0o600, 1)
                or len(data) != entry['size'] or digest(data) != entry['sha256']):
            raise receiver.Refusal('staged-file-changed')
        fd = os.open(destination / entry['name'], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
            os.fchown(stream.fileno(), 131072, 131072)
    os.chown(destination, 131072, 131072)
    launch = json.loads((destination / 'launch').read_bytes())
    receiver.fields(launch, {'format', 'boot_env'})
    if launch['format'] != 'sealant-daemon-launch-v1' or not isinstance(launch['boot_env'], dict) or not all(
            isinstance(key, str) and re.fullmatch('[A-Za-z_][A-Za-z0-9_]*', key) and isinstance(value, str)
            and '\x00' not in value for key, value in launch['boot_env'].items()):
        raise receiver.Refusal('invalid-daemon-launch')
    return destination


def run():
    if os.geteuid() != 0:
        raise receiver.Refusal('outer-owner-required')
    held = []
    with receiver.locked():
        if (guest.ROOT / 'recovery.json').exists():
            raise receiver.Refusal('ordinary-invocation-closed')
        record = state()
        if record['status'] != 'issued' or record['binding'] != binding():
            raise receiver.Refusal('invocation-replay-refused')
        owner = unit_identity()
        if owner['process']['pid'] != os.getpid() or owner['systemd_invocation'] != os.environ.get('INVOCATION_ID'):
            raise receiver.Refusal('invocation-unit-mismatch')
        # Claim before copying payload or invoking anything inside the workspace.
        record = {**record, 'status': 'launching', 'owner': owner}
        guest.save(path(), record)
        try:
            receiver.require_tmpfs()
            manifest = ProtectedManifest.parse(guest.private_json(guest.ROOT / 'manifest.json'))
            observations = {'protected_fingerprint': guest.verify_protected(manifest, guest.BUNDLE)}
            if guest.census()['processes']:
                raise receiver.Refusal('existing-workspace-writer')
            directory = payload(record)
            held = [guest.HeldProcess(os.getpid())]
        except BaseException:
            guest.save(path(), {**record, 'status': 'unresolved'})
            raise
    def verified(launcher, gate):
        nonlocal record
        with receiver.locked():
            if state() != record:
                raise receiver.Refusal('invocation-claim-lost')
            record = {**record, 'status': 'running', 'launcher': asdict(launcher.identity), 'gate': asdict(gate.identity)}
            guest.save(path(), record)
    try:
        result = guest.launch_mapped('workspace', directory / 'launch', manifest, held, observations,
                                     guest.ROOT / 'invocation-launch.json', record['binding'], verified=verified)
        with receiver.locked():
            guest.save(path(), {**record, 'status': 'ended', 'exit_code': result['exit_code']})
    except BaseException:
        with receiver.locked():
            guest.save(path(), {**record, 'status': 'unresolved'})
        raise
    finally:
        for process in held:
            process.close()


if __name__ == '__main__':
    os.umask(0o077)
    run()
