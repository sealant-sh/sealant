"""Capture-only restart on the original disk and boot. Never replays ordinary setup."""
from dataclasses import asdict
import os
import json
import re
import stat

import guest_boot as guest
import guest_invocation as invocation
import guest_receiver as receiver
from guest_contract import ProtectedManifest, canonical, digest

UNIT = 'sealant-recovery.service'


def path():
    return guest.ROOT / 'recovery.json'


def request_for(binding):
    return {'format': 'sealant-capture-recovery-v1', 'binding': binding}


def state():
    record = guest.private_json(path())
    receiver.fields(record, {'format', 'request', 'phase'})
    if record['format'] != 'sealant-capture-recovery-state-v1' or record['phase'] not in ('closing', 'issued'):
        raise receiver.Refusal('invalid-recovery-record')
    return record


def status():
    record = state()
    return {'format': 'sealant-capture-recovery-status-v1', 'binding': record['request']['binding'],
            'execution': observe(), 'mode': 'recovery'}


def invocation_path():
    return guest.ROOT / 'recovery-invocation.json'


def observe():
    return invocation.observe(invocation_path(), UNIT)


def source_payload(binding):
    """Use only the already authenticated original admission, still on this boot's tmpfs."""
    receiver.require_tmpfs()
    disk = receiver.disk_state()
    if binding != invocation.binding():
        raise receiver.Refusal('recovery-binding-conflict')
    manifest_path = receiver.RUNTIME / ('manifest-' + str(binding['epoch']) + '.json')
    manifest = guest.private_json(manifest_path)
    if digest(canonical(manifest)) != disk['admission']['digest']:
        raise receiver.Refusal('recovery-source-manifest-changed')
    receiver.fields(manifest, {'format', 'identity', 'boot_id', 'epoch', 'operation_id', 'files'})
    if {key: manifest[key] for key in binding} != binding:
        raise receiver.Refusal('recovery-source-binding-conflict')
    launch = next((item for item in manifest['files'] if item['name'] == 'launch'), None)
    if launch is None:
        raise receiver.Refusal('recovery-launch-unavailable')
    files = {}
    for entry in manifest['files']:
        filename = entry['name']
        if not isinstance(filename, str) or not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}', filename) or filename in files:
            raise receiver.Refusal('recovery-source-name-invalid')
        source = receiver.RUNTIME / ('epoch-' + str(binding['epoch'])) / filename
        fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, 'rb') as stream:
            info = os.fstat(stream.fileno())
            raw = stream.read(receiver.MAX_BYTES + 1)
        if (not stat.S_ISREG(info.st_mode) or (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode), info.st_nlink) != (0, 0, 0o600, 1)
                or len(raw) != entry['size'] or digest(raw) != entry['sha256']):
            raise receiver.Refusal('recovery-launch-changed')
        files[filename] = raw
    data = json.loads(files['launch'])
    receiver.fields(data, {'format', 'boot_env'})
    if (data['format'] != 'sealant-daemon-launch-v1' or not isinstance(data['boot_env'], dict)
            or data['boot_env'].get('SEALANT_WORKSPACE_SOURCE') != 'capture'):
        raise receiver.Refusal('recovery-requires-capture-source')
    return files


def stage_payload(files):
    directory = receiver.RUNTIME / 'recovery-launch'
    directory.mkdir(mode=0o700, exist_ok=True)
    info = directory.lstat()
    if (not stat.S_ISDIR(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o700
            or (info.st_uid, info.st_gid) not in ((0, 0), (131072, 131072))
            or any(item.name not in files for item in directory.iterdir())):
        raise receiver.Refusal('unsafe-recovery-staging')
    for name, raw in files.items():
        launch = directory / name
        try:
            fd = os.open(launch, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        except FileExistsError:
            fd = os.open(launch, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(fd, 'rb') as stream:
                info = os.fstat(stream.fileno())
                if (not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1
                        or (info.st_uid, info.st_gid) not in ((0, 0), (131072, 131072))
                        or stream.read(receiver.MAX_BYTES + 1) != raw):
                    raise receiver.Refusal('recovery-payload-conflict')
        else:
            with os.fdopen(fd, 'wb') as stream:
                stream.write(raw)
                stream.flush()
                os.fsync(stream.fileno())
        os.chown(launch, 131072, 131072, follow_symlinks=False)
    os.chown(directory, 131072, 131072)


def start(request):
    receiver.fields(request, {'format', 'binding'})
    expected = invocation.binding()
    if request != request_for(expected):
        raise receiver.Refusal('recovery-binding-conflict')
    if not invocation.path().exists() or invocation.state()['binding'] != expected:
        raise receiver.Refusal('recovery-original-invocation-unavailable')
    if path().exists():
        record = state()
        if record.get('request') != request:
            raise receiver.Refusal('recovery-intent-conflict')
        if record.get('phase') == 'issued':
            return status()
    else:
        if invocation.observe() == 'running':
            return {'format': 'sealant-capture-recovery-status-v1', 'binding': expected,
                    'execution': 'running', 'mode': 'original'}
        # Validate before closing the original. A cold boot cannot recreate tmpfs from this path.
        source_payload(expected)
        guest.save(path(), {'format': 'sealant-capture-recovery-state-v1', 'request': request,
                           'phase': 'closing'}, exclusive=True)
    guest.run('/usr/bin/systemctl', 'stop', invocation.UNIT, 'sealant-native-workspace.service', timeout=20)
    if guest.census()['processes']:
        raise receiver.Refusal('recovery-existing-workspace-writer')
    import guest_network as network
    import guest_readiness as readiness
    readiness.verify_permit(expected)
    network.verify(expected)
    held = guest.revalidate()[1]
    try:
        for process in held:
            process.verify()
        files = source_payload(expected)
        stage_payload(files)
        issued = {'format': 'sealant-invocation-v1', 'binding': expected, 'status': 'issued',
                  'owner': None, 'launcher': None, 'gate': None, 'exit_code': None}
        if invocation_path().exists():
            if invocation.state(invocation_path()) != issued:
                raise receiver.Refusal('recovery-intent-conflict')
        else:
            guest.save(invocation_path(), issued, exclusive=True)
        guest.save(path(), {'format': 'sealant-capture-recovery-state-v1', 'request': request, 'phase': 'issued'})
        guest.run('/usr/bin/systemctl', '--no-block', 'start', UNIT)
        return status()
    finally:
        for process in held:
            process.close()


def run():
    if os.geteuid() != 0:
        raise receiver.Refusal('outer-owner-required')
    with receiver.locked():
        record = invocation.state(invocation_path())
        if (guest.private_json(path()) != {'format': 'sealant-capture-recovery-state-v1',
                'request': request_for(invocation.binding()), 'phase': 'issued'}
                or record['status'] != 'issued' or record['binding'] != invocation.binding()):
            raise receiver.Refusal('recovery-invocation-replay-refused')
        owner = invocation.unit_identity(UNIT)
        if owner['process']['pid'] != os.getpid() or owner['systemd_invocation'] != os.environ.get('INVOCATION_ID'):
            raise receiver.Refusal('recovery-unit-mismatch')
        record = {**record, 'status': 'launching', 'owner': owner}
        guest.save(invocation_path(), record)
        if guest.census()['processes']:
            raise receiver.Refusal('recovery-existing-workspace-writer')
        manifest = ProtectedManifest.parse(guest.private_json(guest.ROOT / 'manifest.json'))
        observations = {'protected_fingerprint': guest.verify_protected(manifest, guest.BUNDLE)}
        held = [guest.HeldProcess(os.getpid())]
    def verified(launcher, gate):
        nonlocal record
        with receiver.locked():
            if invocation.state(invocation_path()) != record:
                raise receiver.Refusal('recovery-claim-lost')
            record = {**record, 'status': 'running', 'launcher': asdict(launcher.identity), 'gate': asdict(gate.identity)}
            guest.save(invocation_path(), record)
    try:
        result = guest.launch_mapped('recovery', receiver.RUNTIME / 'recovery-launch' / 'launch', manifest, held,
                                     observations, guest.ROOT / 'recovery-launch.json', record['binding'], verified=verified)
        with receiver.locked():
            guest.save(invocation_path(), {**record, 'status': 'ended', 'exit_code': result['exit_code']})
    except BaseException:
        with receiver.locked():
            guest.save(invocation_path(), {**record, 'status': 'unresolved'})
        raise
    finally:
        for process in held:
            process.close()


if __name__ == '__main__':
    os.umask(0o077)
    run()
