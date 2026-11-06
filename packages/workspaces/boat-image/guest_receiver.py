"""Private bootstrap and admission staging. This module never starts a workspace."""
import base64
import fcntl
import hmac
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
from pathlib import Path
import re
import secrets
import socket
import stat
import subprocess
from contextlib import contextmanager
from dataclasses import dataclass, field

import guest_boot as guest
from guest_contract import ProtectedManifest, canonical, digest

MAX_BODY = 4 * 1024 * 1024
MAX_FILES = 16
MAX_BYTES = 2 * 1024 * 1024
RUNTIME = Path('/run/sealant-bootstrap')
IDENTITY_KEYS = {'deployment_id', 'instance_id', 'disk_lineage'}


class Refusal(ValueError):
    pass


def fields(value, keys):
    if not isinstance(value, dict) or set(value) != set(keys):
        raise Refusal('invalid-request')


def name(value):
    if not isinstance(value, str) or not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}', value):
        raise Refusal('invalid-identity')
    return value


def private_directory(path):
    path.mkdir(mode=0o700, exist_ok=True)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)) != (0, 0, 0o700):
        raise Refusal('unsafe-private-directory')


@contextmanager
def locked():
    descriptor = os.open(guest.ROOT / 'guest.lock', os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077:
            raise Refusal('unsafe-guest-lock')
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        yield
    finally:
        os.close(descriptor)


def require_tmpfs():
    path = RUNTIME.resolve(strict=True)
    mounts = []
    for line in Path('/proc/self/mountinfo').read_text().splitlines():
        before, after = line.split(' - ', 1)
        mount = Path(before.split()[4].replace('\\040', ' '))
        if path.is_relative_to(mount):
            mounts.append((len(mount.parts), after.split()[0]))
    if not mounts or max(mounts)[1] != 'tmpfs':
        raise Refusal('private-staging-requires-tmpfs')


@dataclass(frozen=True)
class Bearer:
    value: str = field(repr=False)

    def __repr__(self):
        return '<redacted>'


def current_control():
    value = guest.private_json(RUNTIME / 'control.json')
    if not isinstance(value, dict) or not {'boot_id', 'token'} <= value.keys():
        raise Refusal('invalid-control-record')
    if not isinstance(value['token'], str) or not re.fullmatch(r'[a-f0-9]{64}', value['token']):
        raise Refusal('invalid-control-record')
    if value['boot_id'] != guest.boot_id():
        raise Refusal('stale-control-boot')
    return {**value, 'token': Bearer(value['token'])}


def disk_state():
    state = guest.private_json(guest.ROOT / 'receiver.json')
    fields(state, {'format', 'identity', 'admission'})
    fields(state['identity'], IDENTITY_KEYS)
    if state['format'] != 'sealant-receiver-v1':
        raise Refusal('invalid-disk-record')
    for value in state['identity'].values():
        name(value)
    admission = state['admission']
    if admission is not None:
        fields(admission, {'epoch', 'operation_id', 'boot_id', 'digest', 'status'})
        if (type(admission['epoch']) is not int or not 1 <= admission['epoch'] <= 9007199254740991
                or admission['status'] not in ('prepared', 'installed')
                or not isinstance(admission['digest'], str) or not re.fullmatch(r'[a-f0-9]{64}', admission['digest'])):
            raise Refusal('invalid-disk-record')
        name(admission['operation_id'])
        name(admission['boot_id'])
    return state


def bind(request):
    """Called only through the authenticated provider command with public inputs."""
    fields(request, {'format', 'identity', 'boot_id', 'manifest_digest', 'operation_id', 'public_key'})
    fields(request['identity'], IDENTITY_KEYS)
    identity = {key: name(value) for key, value in request['identity'].items()}
    name(request['operation_id'])
    if request['format'] != 'sealant-bootstrap-v1' or request['boot_id'] != guest.boot_id():
        raise Refusal('stale-bootstrap-boot')
    manifest = ProtectedManifest.parse(guest.private_json(guest.ROOT / 'manifest.json'))
    if request['manifest_digest'] != digest(manifest.bytes()):
        raise Refusal('bootstrap-manifest-mismatch')
    guest.verify_protected(manifest, guest.BUNDLE)
    if not isinstance(request['public_key'], str) or len(request['public_key']) > 4096:
        raise Refusal('invalid-public-key')
    # Validate the public key before persisting a binding or generating credentials.
    encrypted = encrypt(request, '0' * 64)
    del encrypted
    private_directory(RUNTIME)
    require_tmpfs()
    state_path = guest.ROOT / 'receiver.json'
    if state_path.exists():
        state = disk_state()
        if state['identity'] != identity:
            raise Refusal('disk-already-bound')
    else:
        guest.save(state_path, {'format': 'sealant-receiver-v1', 'identity': identity, 'admission': None})
    control_path = RUNTIME / 'control.json'
    fingerprint = digest(canonical(request))
    if control_path.exists():
        control = current_control()
        if control.get('request_digest') != fingerprint:
            raise Refusal('bootstrap-exchange-conflict')
    else:
        control = {'boot_id': guest.boot_id(), 'request_digest': fingerprint,
                   'operation_id': request['operation_id'], 'token': secrets.token_hex(32)}
        guest.save(control_path, control)
        control = current_control()
    guest.save(guest.ROOT / 'instance.json', {**identity, 'boot_id': guest.boot_id()})
    token = RUNTIME / 'relay.token'
    # JSON is not used here because the relay requires exactly 64 hexadecimal bytes.
    descriptor = os.open(token, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'w') as stream:
        stream.write(control['token'].value)
        stream.flush()
        os.fsync(stream.fileno())
    return {'format': 'sealant-bootstrap-reply-v1', 'identity': identity, 'boot_id': guest.boot_id(),
            'operation_id': request['operation_id'], 'ciphertext': encrypt(request, control['token'].value),
            'admission': 'held'}


def encrypt(request, token):
    result = subprocess.run(guest.invoke('/usr/bin/node', str(guest.ROOT / 'bootstrap-crypto.mjs')),
                            input=canonical({'request': request, 'token': token}),
                            capture_output=True, timeout=10, env=guest.ENV)
    if result.returncode or len(result.stdout) > 1024:
        raise Refusal('invalid-public-key')
    return result.stdout.decode().strip()


def parse_stage(value):
    fields(value, {'format', 'identity', 'boot_id', 'epoch', 'operation_id', 'files'})
    fields(value['identity'], IDENTITY_KEYS)
    for item in value['identity'].values():
        name(item)
    name(value['operation_id'])
    if (value['format'] != 'sealant-admission-stage-v1' or type(value['epoch']) is not int
            or not 1 <= value['epoch'] <= 9007199254740991):
        raise Refusal('invalid-epoch')
    if not isinstance(value['files'], list) or not 1 <= len(value['files']) <= MAX_FILES:
        raise Refusal('invalid-files')
    files, descriptors, total = {}, [], 0
    for entry in value['files']:
        fields(entry, {'name', 'size', 'sha256', 'data'})
        filename = entry['name']
        if (not isinstance(filename, str) or not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}', filename)
                or filename in files or type(entry['size']) is not int or entry['size'] < 0
                or not isinstance(entry['data'], str) or not isinstance(entry['sha256'], str)):
            raise Refusal('invalid-file')
        try:
            data = base64.b64decode(entry['data'], validate=True)
        except (ValueError, UnicodeEncodeError):
            raise Refusal('invalid-file-encoding') from None
        total += len(data)
        if len(data) != entry['size'] or total > MAX_BYTES or digest(data) != entry['sha256']:
            raise Refusal('file-digest-or-size')
        files[filename] = data
        descriptors.append({key: entry[key] for key in ('name', 'size', 'sha256')})
    manifest = {**value, 'files': sorted(descriptors, key=lambda entry: entry['name'])}
    return manifest, files


def status():
    control = current_control()
    state = disk_state()
    admission = state['admission']
    return {'format': 'sealant-receiver-status-v1', 'identity': state['identity'],
            'boot_id': control['boot_id'], 'admission': 'held', 'execution': 'unavailable',
            'epoch': admission['epoch'] if admission else None,
            'operation_id': admission['operation_id'] if admission else None,
            'stage': ('previous-boot' if admission['boot_id'] != control['boot_id'] else admission['status']) if admission else 'empty'}


def stage(value):
    manifest, files = parse_stage(value)
    require_tmpfs()
    current_control()
    state = disk_state()
    if manifest['boot_id'] != guest.boot_id() or manifest['identity'] != state['identity']:
        raise Refusal('stale-admission-binding')
    fingerprint = digest(canonical(manifest))
    admission = state['admission']
    if admission is not None and (admission['digest'] != fingerprint or admission['boot_id'] != guest.boot_id()):
        raise Refusal('disk-admission-conflict')
    # No new logical ID or boot can erase an accepted epoch. Canonical close/recovery is a later layer.
    held = guest.revalidate()[1]
    try:
        if admission is None:
            admission = {'epoch': manifest['epoch'], 'operation_id': manifest['operation_id'],
                         'boot_id': guest.boot_id(), 'digest': fingerprint, 'status': 'prepared'}
            state = {**state, 'admission': admission}
            guest.save(guest.ROOT / 'receiver.json', state)
        directory = RUNTIME / ('epoch-' + str(manifest['epoch']))
        private_directory(directory)
        if any(path.name not in files and path.name not in {'.pending-' + key for key in files}
               for path in directory.iterdir()):
            raise Refusal('unexpected-staged-file')
        for filename, data in files.items():
            path = directory / filename
            if path.exists() or path.is_symlink():
                descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
                with os.fdopen(descriptor, 'rb') as stream:
                    info = os.fstat(stream.fileno())
                    if (not stat.S_ISREG(info.st_mode) or (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode), info.st_nlink) != (0, 0, 0o600, 1)
                            or stream.read(MAX_BYTES + 1) != data):
                        raise Refusal('staged-file-conflict')
            else:
                temporary = directory / ('.pending-' + filename)
                if temporary.exists() or temporary.is_symlink():
                    temporary.unlink()
                descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                with os.fdopen(descriptor, 'wb') as stream:
                    stream.write(data)
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(temporary, path)
        for process in held:
            process.verify()
        guest.save(guest.ROOT / 'receiver.json', {**state, 'admission': {**admission, 'status': 'installed'}})
        return status()
    finally:
        for process in held:
            process.close()


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.0'

    def log_message(self, *_):
        pass

    def handle_request(self):
        self.connection.settimeout(5)
        try:
            with locked():
                control = current_control()
                headers = self.headers.get_all('Authorization', [])
                if len(headers) != 1 or not hmac.compare_digest(headers[0], 'Bearer ' + control['token'].value):
                    self.reply(401, {'error': 'unauthorized'})
                    return
                if self.command == 'GET' and self.path == '/sealant/bootstrap/status':
                    self.reply(200, status())
                    return
                if self.command != 'POST' or self.path != '/sealant/bootstrap/stage':
                    self.reply(404, {'error': 'unknown-route'})
                    return
                lengths = self.headers.get_all('Content-Length', [])
                if (self.headers.get('Transfer-Encoding') is not None or len(lengths) != 1
                        or not lengths[0].isdecimal() or not 0 < int(lengths[0]) <= MAX_BODY
                        or self.headers.get('Content-Type') != 'application/json'):
                    raise Refusal('invalid-body')
                raw = self.rfile.read(int(lengths[0]))
                if len(raw) != int(lengths[0]):
                    raise Refusal('incomplete-body')
                self.reply(200, stage(json.loads(raw)))
        except Refusal as error:
            self.reply(409, {'error': str(error)})
        except (ValueError, KeyError, TypeError, RecursionError):
            self.reply(400, {'error': 'invalid-request'})
        except Exception:
            self.reply(503, {'error': 'receiver-unavailable'})

    def reply(self, code, value):
        raw = canonical(value)
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    do_GET = handle_request
    do_POST = handle_request


class UnixServer(HTTPServer):
    address_family = socket.AF_UNIX

    def server_bind(self):
        self.socket.bind(self.server_address)
        self.server_name = 'sealant-bootstrap'
        self.server_port = 0


def serve():
    if os.geteuid() != 0 or Path('/proc/self/uid_map').read_text().split() != ['0', '0', '4294967295']:
        raise Refusal('outer-owner-required')
    os.umask(0o077)
    private_directory(RUNTIME)
    with locked():
        current_control()
    path = RUNTIME / 'receiver.sock'
    if path.exists():
        if not stat.S_ISSOCK(path.lstat().st_mode):
            raise Refusal('unexpected-receiver-socket')
        path.unlink()
    with UnixServer(str(path), Handler) as server:
        server.serve_forever()


if __name__ == '__main__':
    serve()
