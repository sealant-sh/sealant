"""Durable copies of a closed workspace's volatile mounts. Never grants admission."""
import base64
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import stat
import struct
import signal
import threading

from guest_contract import canonical, digest

MAX_BYTES = 16 * 1024 * 1024 * 1024
MAX_ENTRIES = 200000
EXCLUDED = ('/proc', '/sys', '/dev', '/run/sealant', '/run/sealant-inputs',
            '/run/sealant-runtime', '/run/sealant-entry.py', '/run/sealant-operation')


class CapsuleRefusal(ValueError):
    pass


@contextmanager
def deadline(seconds=60):
    if threading.current_thread() is not threading.main_thread():
        raise CapsuleRefusal('capsule-deadline-owner-required')
    def expired(*_):
        raise CapsuleRefusal('capsule-deadline')
    previous = signal.signal(signal.SIGALRM, expired)
    previous_timer = signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, *previous_timer)
        signal.signal(signal.SIGALRM, previous)


def clean_path(value):
    if (not isinstance(value, str) or not value.startswith('/') or '\x00' in value
            or value != str(PurePosixPath(value)) or '..' in value.split('/')):
        raise CapsuleRefusal('invalid-volume-path')
    return value


def beneath(path, parent):
    return path == parent or path.startswith(parent.rstrip('/') + '/')


def unescape(value):
    for code, character in (('040', ' '), ('011', '\t'), ('012', '\n'), ('134', '\\')):
        value = value.replace('\\' + code, character)
    return value


def plan(document, retained_paths=()):
    mounts = []
    for line in document.splitlines():
        before, after = line.split(' - ', 1)
        fields, details = before.split(), after.split()
        mounts.append({'id': int(fields[0]), 'device': fields[2], 'path': clean_path(unescape(fields[4])),
                       'writable': 'rw' in fields[5].split(','), 'type': details[0]})
    roots = [mount for mount in mounts if mount['path'] == '/']
    if len(roots) != 1:
        raise CapsuleRefusal('ambiguous-root-mount')
    result = []
    for mount in mounts:
        path = mount['path']
        if any(beneath(path, excluded) for excluded in EXCLUDED) and not beneath(path, '/dev/shm'):
            continue
        if mount['writable'] and (mount['type'] in ('tmpfs', 'ramfs') or path in retained_paths):
            exclusions = {entry['path'] for entry in mounts if entry['path'] != path and beneath(entry['path'], path)}
            exclusions.update(excluded for excluded in EXCLUDED if excluded != path and beneath(excluded, path))
            result.append({'path': path, 'mount_id': mount['id'], 'device': mount['device'],
                           'exclude': sorted(exclusions)})
        elif mount['writable'] and mount['device'] != roots[0]['device']:
            raise CapsuleRefusal('unsupported-writable-mount')
    paths = [entry['path'] for entry in result]
    if len(set(paths)) != len(paths) or '/' in paths:
        raise CapsuleRefusal('ambiguous-volatile-mount')
    if not set(retained_paths) <= set(paths):
        raise CapsuleRefusal('retained-volume-missing')
    return sorted(result, key=lambda entry: entry['path'])


@contextmanager
def opened(path, flags, directory=None, mode=0o600):
    descriptor = os.open(path, flags | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK, mode, dir_fd=directory)
    try:
        yield descriptor
    finally:
        os.close(descriptor)


def private_directory(path):
    path.mkdir(mode=0o700)
    return path


def require_private_directory(path):
    info = Path(path).lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise CapsuleRefusal('unsafe-capsule-directory')


def receipt(destination, manifest=None):
    raw = (Path(destination) / 'manifest.json').read_bytes()
    manifest = json.loads(raw) if manifest is None else manifest
    archive = Path(destination) / 'capsule.pack'
    sha = hashlib.sha256()
    with opened(archive, os.O_RDONLY) as file:
        info = os.fstat(file)
        if not stat.S_ISREG(info.st_mode):
            raise CapsuleRefusal('invalid-capsule-pack')
        while chunk := os.read(file, 1024 * 1024):
            sha.update(chunk)
    return {'sha256': digest(raw), 'archive_sha256': sha.hexdigest(),
            'bytes': manifest['bytes'], 'entries': manifest['entries'], 'stored_bytes': info.st_size}


def object_sizes(manifest):
    return {entry['sha256']: entry['size'] for volume in manifest['volumes']
            for entry in volume['entries'] if entry['type'] == 'file'}


def write_all(descriptor, data):
    offset = 0
    while offset < len(data):
        written = os.write(descriptor, data[offset:])
        if written == 0:
            raise CapsuleRefusal('capsule-write-incomplete')
        offset += written


def pack(destination, manifest):
    """One bounded file can be verified by immutable provider snapshot ID before source removal."""
    raw = canonical(manifest)
    with opened(destination / 'capsule.pack', os.O_WRONLY | os.O_CREAT | os.O_EXCL) as output:
        write_all(output, b'SLNTCAP1' + struct.pack('!Q', len(raw)) + raw)
        for sha, size in sorted(object_sizes(manifest).items()):
            with opened(destination / 'objects' / sha, os.O_RDONLY) as source:
                actual, read = hashlib.sha256(), 0
                while chunk := os.read(source, 1024 * 1024):
                    actual.update(chunk)
                    read += len(chunk)
                    if read > size:
                        raise CapsuleRefusal('capsule-object-changed')
                    write_all(output, chunk)
                if read != size or actual.hexdigest() != sha:
                    raise CapsuleRefusal('capsule-object-changed')
        os.fsync(output)


def unpack(source, expected, binding, destination):
    """Reconstruct only a verified capsule's declared objects, into fresh private storage."""
    destination = Path(destination)
    private_directory(destination)
    objects = private_directory(destination / 'objects')
    sha = hashlib.sha256()
    with opened(source, os.O_RDONLY) as file:
        def exact(size):
            result = bytearray()
            while len(result) < size:
                part = os.read(file, min(size - len(result), 1024 * 1024))
                if not part:
                    raise CapsuleRefusal('short-capsule-pack')
                sha.update(part)
                result.extend(part)
            return bytes(result)
        if exact(8) != b'SLNTCAP1':
            raise CapsuleRefusal('invalid-capsule-pack')
        length = struct.unpack('!Q', exact(8))[0]
        if length > 64 * 1024 * 1024:
            raise CapsuleRefusal('capsule-limit')
        raw = exact(length)
        manifest = json.loads(raw)
        sizes = object_sizes(manifest)
        if len(sizes) > MAX_ENTRIES or any(type(size) is not int or size < 0 for size in sizes.values()) or sum(sizes.values()) > MAX_BYTES:
            raise CapsuleRefusal('capsule-limit')
        for name, size in sorted(sizes.items()):
            if not isinstance(name, str) or len(name) != 64 or any(c not in '0123456789abcdef' for c in name):
                raise CapsuleRefusal('invalid-capsule-object')
            with opened(objects / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL) as output:
                remaining = size
                while remaining:
                    data = exact(min(remaining, 1024 * 1024))
                    write_all(output, data)
                    remaining -= len(data)
                os.fsync(output)
        if os.read(file, 1) or sha.hexdigest() != expected:
            raise CapsuleRefusal('capsule-pack-mismatch')
    with opened(destination / 'manifest.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL) as output:
        write_all(output, raw)
        os.fsync(output)
    manifest = verify(destination, digest(raw), binding)
    sync_directory(objects)
    sync_directory(destination)
    sync_directory(destination.parent)
    return manifest


def sync_directory(path):
    with opened(path, os.O_RDONLY | os.O_DIRECTORY) as descriptor:
        os.fsync(descriptor)


def attributes(path, descriptor=None):
    return {name: base64.b64encode(os.getxattr(descriptor if descriptor is not None else path, name,
                                             **({} if descriptor is not None else {'follow_symlinks': False}))).decode()
            for name in sorted(os.listxattr(descriptor if descriptor is not None else path,
                                           **({} if descriptor is not None else {'follow_symlinks': False})))}


def identity(info):
    return (info.st_dev, info.st_ino, info.st_uid, info.st_gid, info.st_mode, info.st_size, info.st_nlink)


def relative(value):
    if (not isinstance(value, str) or '\x00' in value or value.startswith('/') or '..' in value.split('/')
            or value != ('' if value == '' else str(PurePosixPath(value)))):
        raise CapsuleRefusal('invalid-entry-path')
    return value


def export(root_descriptor, volumes, destination, binding, max_bytes=MAX_BYTES, max_entries=MAX_ENTRIES):
    """Caller must exclude all writers and pin the namespace until this function has returned."""
    destination = Path(destination)
    private_directory(destination)
    objects = private_directory(destination / 'objects')
    total, count = 0, 0
    result, links = [], {}
    for index, volume in enumerate(volumes):
        target = clean_path(volume['path'])
        # All path components are opened without symlink traversal from the pinned process root.
        descriptor = os.dup(root_descriptor)
        try:
            for component in PurePosixPath(target).parts[1:]:
                child = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                                dir_fd=descriptor)
                os.close(descriptor)
                descriptor = child
            entries = []
            for directory, directories, files, current in os.fwalk('.', dir_fd=descriptor, follow_symlinks=False):
                prefix = str(Path(directory))
                prefix = '' if prefix == '.' else prefix
                names = ([''] if prefix == '' else []) + sorted(directories + files)
                for name in names:
                    path = relative('/'.join(part for part in (prefix, name) if part))
                    absolute = target.rstrip('/') + ('/' + path if path else '')
                    if any(beneath(absolute, excluded) for excluded in volume['exclude']):
                        if name in directories:
                            directories.remove(name)
                        continue
                    info = os.stat(name or '.', dir_fd=current, follow_symlinks=False)
                    count += 1
                    if count > max_entries:
                        raise CapsuleRefusal('capsule-entry-limit')
                    entry = {'path': path, 'uid': info.st_uid, 'gid': info.st_gid,
                             'mode': stat.S_IMODE(info.st_mode), 'mtime_ns': info.st_mtime_ns}
                    full = Path('/proc/self/fd') / str(current) / (name or '.')
                    if stat.S_ISDIR(info.st_mode):
                        entry.update(type='directory', xattrs=attributes(full))
                    elif stat.S_ISLNK(info.st_mode):
                        entry.update(type='symlink', target=os.readlink(name, dir_fd=current), xattrs=attributes(full))
                    elif stat.S_ISREG(info.st_mode):
                        key = (info.st_dev, info.st_ino)
                        total += info.st_size
                        if total > max_bytes:
                            raise CapsuleRefusal('capsule-byte-limit')
                        with opened(name, os.O_RDONLY, current) as file:
                            if identity(os.fstat(file)) != identity(info):
                                raise CapsuleRefusal('capsule-file-changed')
                            sha = hashlib.sha256()
                            temporary = objects / ('file-' + str(count))
                            with opened(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL) as output:
                                read = 0
                                while chunk := os.read(file, 1024 * 1024):
                                    read += len(chunk)
                                    if read > info.st_size:
                                        raise CapsuleRefusal('capsule-file-changed')
                                    sha.update(chunk)
                                    offset = 0
                                    while offset < len(chunk):
                                        offset += os.write(output, chunk[offset:])
                                os.fsync(output)
                            xattrs = attributes(None, file)
                            if read != info.st_size or identity(os.fstat(file)) != identity(info):
                                raise CapsuleRefusal('capsule-file-changed')
                        content = sha.hexdigest()
                        if (objects / content).exists():
                            temporary.unlink()
                        else:
                            temporary.rename(objects / content)
                        entry.update(type='file', sha256=content, size=info.st_size, xattrs=xattrs)
                        group = links.setdefault(key, {'expected': info.st_nlink, 'members': []})
                        group['members'].append([index, path])
                    elif stat.S_ISFIFO(info.st_mode):
                        entry.update(type='fifo', xattrs=attributes(full))
                    elif stat.S_ISSOCK(info.st_mode):
                        entry.update(type='socket', xattrs={})
                    else:
                        raise CapsuleRefusal('unsupported-volatile-entry')
                    entries.append(entry)
            result.append({'path': target, 'entries': sorted(entries, key=lambda entry: entry['path'])})
        finally:
            os.close(descriptor)
    if any(len(group['members']) != group['expected'] for group in links.values()):
        raise CapsuleRefusal('capsule-external-hardlink')
    manifest = {'format': 'sealant-volatile-capsule-v1', 'binding': binding, 'volumes': result,
                'hardlinks': [group['members'] for group in links.values() if len(group['members']) > 1],
                'bytes': total, 'entries': count}
    data = canonical(manifest)
    pack(destination, manifest)
    with opened(destination / 'manifest.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL) as file:
        offset = 0
        while offset < len(data):
            offset += os.write(file, data[offset:])
        os.fsync(file)
    sync_directory(objects)
    sync_directory(destination)
    sync_directory(destination.parent)
    return receipt(destination, manifest)


def verify(capsule, expected, binding, max_bytes=MAX_BYTES, max_entries=MAX_ENTRIES):
    capsule = Path(capsule)
    require_private_directory(capsule)
    require_private_directory(capsule / 'objects')
    with opened(capsule / 'manifest.json', os.O_RDONLY) as file:
        info = os.fstat(file)
        if not stat.S_ISREG(info.st_mode) or info.st_size > 64 * 1024 * 1024:
            raise CapsuleRefusal('invalid-capsule-manifest')
        data = os.read(file, info.st_size + 1)
    if digest(data) != expected:
        raise CapsuleRefusal('capsule-digest-mismatch')
    manifest = json.loads(data)
    if not isinstance(manifest, dict) or manifest.get('format') != 'sealant-volatile-capsule-v1' or manifest.get('binding') != binding:
        raise CapsuleRefusal('capsule-binding-conflict')
    if (set(manifest) != {'format', 'binding', 'volumes', 'hardlinks', 'bytes', 'entries'}
            or not isinstance(manifest['volumes'], list) or not isinstance(manifest['hardlinks'], list)
            or type(manifest['bytes']) is not int or type(manifest['entries']) is not int):
        raise CapsuleRefusal('invalid-capsule-manifest')
    seen, objects, entries_by_id, total, count = set(), {}, {}, 0, 0
    for index, volume in enumerate(manifest['volumes']):
        if not isinstance(volume, dict) or set(volume) != {'path', 'entries'} or not isinstance(volume['entries'], list):
            raise CapsuleRefusal('invalid-capsule-volume')
        target = clean_path(volume['path'])
        if target in seen or target == '/':
            raise CapsuleRefusal('invalid-capsule-volume')
        seen.add(target)
        names = {}
        for entry in volume['entries']:
            if not isinstance(entry, dict) or not {'path', 'type', 'uid', 'gid', 'mode', 'mtime_ns', 'xattrs'} <= set(entry):
                raise CapsuleRefusal('invalid-capsule-entry')
            path = relative(entry['path'])
            parent = str(PurePosixPath(path).parent)
            if path in names or (path and names.get('' if parent == '.' else parent) != 'directory'):
                raise CapsuleRefusal('invalid-capsule-tree')
            names[path] = entry['type']
            entries_by_id[(index, path)] = entry
            if entry['type'] not in ('directory', 'file', 'symlink', 'fifo', 'socket'):
                raise CapsuleRefusal('invalid-capsule-entry')
            count += 1
            if count > max_entries:
                raise CapsuleRefusal('capsule-limit')
            if (type(entry['uid']) is not int or not 0 <= entry['uid'] < 2**32
                    or type(entry['gid']) is not int or not 0 <= entry['gid'] < 2**32
                    or type(entry['mode']) is not int or not 0 <= entry['mode'] <= 0o7777
                    or type(entry['mtime_ns']) is not int):
                raise CapsuleRefusal('invalid-capsule-metadata')
            if (not isinstance(entry['xattrs'], dict) or any(not isinstance(name, str) or not name or '\x00' in name
                    or not isinstance(value, str) for name, value in entry['xattrs'].items())):
                raise CapsuleRefusal('invalid-capsule-metadata')
            if entry['type'] == 'symlink' and (not isinstance(entry.get('target'), str) or '\x00' in entry['target']):
                raise CapsuleRefusal('invalid-capsule-metadata')
            if entry['type'] == 'file':
                sha = entry['sha256']
                if not isinstance(sha, str) or len(sha) != 64 or any(c not in '0123456789abcdef' for c in sha):
                    raise CapsuleRefusal('invalid-capsule-object')
                if type(entry['size']) is not int or entry['size'] < 0:
                    raise CapsuleRefusal('invalid-capsule-object')
                total += entry['size']
                if total > max_bytes or count > max_entries:
                    raise CapsuleRefusal('capsule-limit')
                if sha in objects and objects[sha] != entry['size']:
                    raise CapsuleRefusal('capsule-object-size-conflict')
                if sha not in objects:
                    with opened(capsule / 'objects' / sha, os.O_RDONLY) as file:
                        info = os.fstat(file)
                        if not stat.S_ISREG(info.st_mode) or info.st_size != entry['size']:
                            raise CapsuleRefusal('capsule-object-changed')
                        actual = hashlib.sha256()
                        while chunk := os.read(file, 1024 * 1024):
                            actual.update(chunk)
                        if actual.hexdigest() != sha:
                            raise CapsuleRefusal('capsule-object-changed')
                    objects[sha] = entry['size']
            for value in entry['xattrs'].values():
                base64.b64decode(value, validate=True)
        if names.get('') != 'directory':
            raise CapsuleRefusal('capsule-root-missing')
    if total != manifest['bytes'] or count != manifest['entries'] or count > max_entries:
        raise CapsuleRefusal('capsule-count-mismatch')
    linked = set()
    for group in manifest['hardlinks']:
        if not isinstance(group, list) or len(group) < 2:
            raise CapsuleRefusal('invalid-capsule-hardlinks')
        first = None
        for member in group:
            if (not isinstance(member, list) or len(member) != 2 or type(member[0]) is not int
                    or not isinstance(member[1], str)):
                raise CapsuleRefusal('invalid-capsule-hardlinks')
            key = tuple(member)
            entry = entries_by_id.get(key)
            if key in linked or entry is None or entry['type'] != 'file':
                raise CapsuleRefusal('invalid-capsule-hardlinks')
            metadata = {name: value for name, value in entry.items() if name != 'path'}
            if first is not None and first != metadata:
                raise CapsuleRefusal('capsule-hardlink-conflict')
            first = metadata
            linked.add(key)
    if {path.name for path in (capsule / 'objects').iterdir()} != set(objects):
        raise CapsuleRefusal('capsule-unexpected-object')
    return manifest


def hydrate(capsule, expected, binding, destination):
    """Restore into a fresh private backing directory; caller separately owns bind mounts and admission."""
    capsule, destination = Path(capsule), Path(destination)
    manifest = verify(capsule, expected, binding)
    private_directory(destination)
    paths = {}
    for index, volume in enumerate(manifest['volumes']):
        root = private_directory(destination / str(index))
        for entry in volume['entries']:
            path = root / entry['path']
            paths[(index, entry['path'])] = path
            if entry['type'] == 'directory' and entry['path']:
                path.mkdir(mode=0o700)
            elif entry['type'] == 'file':
                with opened(capsule / 'objects' / entry['sha256'], os.O_RDONLY) as source, \
                        opened(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL) as output:
                    actual, size = hashlib.sha256(), 0
                    while chunk := os.read(source, 1024 * 1024):
                        size += len(chunk)
                        if size > entry['size']:
                            raise CapsuleRefusal('capsule-object-changed')
                        actual.update(chunk)
                        offset = 0
                        while offset < len(chunk):
                            offset += os.write(output, chunk[offset:])
                    if size != entry['size'] or actual.hexdigest() != entry['sha256']:
                        raise CapsuleRefusal('capsule-object-changed')
                    os.fsync(output)
            elif entry['type'] == 'symlink':
                path.symlink_to(entry['target'])
            elif entry['type'] == 'fifo':
                os.mkfifo(path, 0o600)
        sync_directory(root)
    for group in manifest['hardlinks']:
        first, *others = group
        source = paths[tuple(first)]
        for member in others:
            path = paths[tuple(member)]
            path.unlink()
            os.link(source, path, follow_symlinks=False)
    for index, volume in enumerate(manifest['volumes']):
        for entry in reversed(volume['entries']):
            if entry['type'] == 'socket':
                continue
            path = paths[(index, entry['path'])]
            os.chown(path, entry['uid'], entry['gid'], follow_symlinks=False)
            if entry['type'] != 'symlink':
                os.chmod(path, entry['mode'], follow_symlinks=False)
            for name, value in entry['xattrs'].items():
                os.setxattr(path, name, base64.b64decode(value, validate=True), follow_symlinks=False)
            os.utime(path, ns=(entry['mtime_ns'], entry['mtime_ns']), follow_symlinks=False)
            if entry['type'] in ('file', 'directory'):
                with opened(path, os.O_RDONLY | (os.O_DIRECTORY if entry['type'] == 'directory' else 0)) as file:
                    os.fsync(file)
    sync_directory(destination)
    sync_directory(destination.parent)
    return [{'path': volume['path'], 'source': str(destination / str(index))}
            for index, volume in enumerate(manifest['volumes'])]
