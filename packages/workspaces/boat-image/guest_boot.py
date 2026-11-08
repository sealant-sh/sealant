import sys
from pathlib import Path

sys.dont_write_bytecode = True

from dataclasses import asdict, replace
import fcntl
import json
import os
import select
import stat
import subprocess
import time

from guest_contract import (
    BootBinding, BootState, ExecutableMapping, FileIdentity, ProcessIdentity,
    ProtectedManifest, Status, approved_profile, canonical, digest, initial_state,
    mapping_failures, receipt_failures, transition,
)

ROOT = Path('/var/lib/sealant/guest')
BUNDLE = ROOT / 'bundle'
MAPPED_ROOT = Path('/var/lib/sealant/workspace-root')
ENV = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'}
LIBRARIES = ':'.join(str(BUNDLE / path) for path in (
    'lib/x86_64-linux-gnu', 'usr/lib/x86_64-linux-gnu', 'usr/lib/x86_64-linux-gnu/systemd'))
NS_GET_PARENT = 0xB702
OWNED_UNITS = frozenset(('sealant-held.service', 'sealant-held-watchdog.service',
                         'sealant-workspace.service', 'sealant-native-build.service',
                         'sealant-native-probe.service', 'sealant-native-workspace.service', 'sealant-recovery.service',
                         'sealant-native-recovery.service', 'sealant-bootstrap.service',
                         'sealant-control-relay.service'))


def save(path, value, exclusive=False):
    temporary = path if exclusive else path.with_name(path.name + '.next')
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW |
                         (os.O_EXCL if exclusive else os.O_TRUNC), 0o600)
    with os.fdopen(descriptor, 'wb') as stream:
        stream.write(canonical(value) + b'\n')
        stream.flush()
        os.fsync(stream.fileno())
    if not exclusive:
        os.replace(temporary, path)
    descriptor = os.open(path.parent, os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def private_json(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor) as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077:
            raise ValueError('unsafe-private-record:' + str(path))
        return json.load(stream)


def boot_id():
    return Path('/proc/sys/kernel/random/boot_id').read_text().strip()


def identity(pid):
    root = Path('/proc') / str(pid)
    info = (root / 'root').stat()
    executable = (root / 'exe').stat()
    return ProcessIdentity(
        int(pid), int((root / 'stat').read_text().rsplit(')', 1)[1].split()[19]),
        info.st_dev, info.st_ino, (root / 'ns/mnt').stat().st_ino,
        (root / 'ns/user').stat().st_ino, (root / 'ns/pid').stat().st_ino,
        (root / 'cgroup').read_text().strip(), executable.st_dev, executable.st_ino)


class FileObservationError(ValueError):
    def __init__(self, path, observation):
        super().__init__('file-changed-during-check:' + str(path))
        self.observation = observation


class DeletedMappingError(ValueError):
    pass


def stat_record(info):
    return {name: getattr(info, 'st_' + name) for name in
            ('dev', 'ino', 'mtime_ns', 'ctime_ns', 'uid', 'gid', 'mode', 'size', 'nlink')}


def file_identity(path, expected_sha256=None):
    started = time.monotonic()
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, 'rb') as stream:
        before = os.fstat(stream.fileno())
        sha256 = digest(stream.read())
        after = os.fstat(stream.fileno())
        fields = ('st_dev', 'st_ino', 'st_uid', 'st_gid', 'st_mode', 'st_size', 'st_nlink')
        if not stat.S_ISREG(before.st_mode) or any(getattr(before, name) != getattr(after, name) for name in fields):
            raise FileObservationError(path, {
                'path': str(path), 'before': stat_record(before), 'after': stat_record(after),
                'sha256': sha256, 'expected_sha256': expected_sha256,
                'read_started_monotonic': started, 'read_finished_monotonic': time.monotonic()})
        if expected_sha256 is not None and sha256 != expected_sha256:
            raise ValueError('protected-file-changed:' + str(path))
        return FileIdentity(sha256, before.st_dev, before.st_ino, before.st_uid, before.st_gid, stat.S_IMODE(before.st_mode))


def executable_mappings(pid, path_map=None, expected_files=None):
    root = Path('/proc') / str(pid)
    result = []
    for line in (root / 'maps').read_text().splitlines():
        fields = line.split(None, 5)
        if 'x' not in fields[1]:
            continue
        if len(fields) != 6 or not fields[5].startswith('/'):
            continue
        path = fields[5]
        deleted = path.endswith(' (deleted)')
        path = path.removesuffix(' (deleted)')
        expected_path = path_map(path) if path_map else path
        if not Path(expected_path).is_relative_to(BUNDLE):
            continue
        if deleted:
            raise DeletedMappingError('mapping-deleted:' + path)
        actual_path = root / 'root' / path.lstrip('/')
        expected = (expected_files or {}).get(expected_path)
        observed = file_identity(actual_path, expected.sha256 if expected else None)
        canonical_path = path_map(path) if path_map else str(actual_path.resolve(strict=True))
        major, minor = (int(part, 16) for part in fields[3].split(':'))
        result.append(ExecutableMapping(canonical_path, observed.sha256, os.makedev(major, minor),
                                        int(fields[4]), observed.device, observed.inode))
    return result


def owned_units(proc=Path('/proc')):
    result = {}
    for path in proc.iterdir():
        if not path.name.isdecimal() or int(path.name) == 1:
            continue
        try:
            units = {part for line in (path / 'cgroup').read_text().splitlines()
                     for part in line.split(':', 2)[2].split('/') if part in OWNED_UNITS}
            if len(units) > 1:
                raise ValueError('owned-unit-ambiguous')
            if units:
                result[int(path.name)] = units.pop()
        except (FileNotFoundError, ProcessLookupError):
            continue
    return result


class HeldProcess:
    def __init__(self, pid):
        self.fd = os.pidfd_open(int(pid))
        try:
            self.identity = identity(pid)
            self.verify()
        except BaseException:
            os.close(self.fd)
            raise

    def verify(self):
        if select.select([self.fd], [], [], 0)[0] or identity(self.identity.pid) != self.identity:
            raise ValueError('held-process-lost')

    def close(self):
        os.close(self.fd)


def lineage(pid):
    descriptor = os.open(f'/proc/{pid}/ns/user', os.O_RDONLY)
    result = []
    try:
        while True:
            result.append(os.fstat(descriptor).st_ino)
            try:
                parent = fcntl.ioctl(descriptor, NS_GET_PARENT)
            except PermissionError:
                break
            os.close(descriptor)
            descriptor = parent
    finally:
        os.close(descriptor)
    return result


def census():
    processes = {}
    candidates = {}
    workspace_namespaces = set()
    outer_namespace = Path('/proc/self/ns/user').stat().st_ino
    for path in Path('/proc').iterdir():
        if not path.name.isdecimal():
            continue
        owned = False
        try:
            cgroup = (path / 'cgroup').read_text().strip()
            root = os.readlink(path / 'root')
            uid_map = (path / 'uid_map').read_text()
            namespace = (path / 'ns/user').stat().st_ino
            mapped = namespace != outer_namespace and any(
                int(parts[1]) < 196608 and int(parts[1]) + int(parts[2]) > 131072
                for parts in (line.split() for line in uid_map.splitlines()))
            owned = 'sealant-native-' in cgroup or root == str(MAPPED_ROOT) or root.startswith(str(MAPPED_ROOT) + '/') or mapped
            if owned or namespace != outer_namespace:
                record = {'identity': asdict(identity(path.name)), 'uid_map': uid_map,
                          'user_namespace_lineage': lineage(path.name), 'root': root,
                          'command': (path / 'comm').read_text().strip()}
                candidates[int(path.name)] = record
                if owned:
                    processes[int(path.name)] = record
                    workspace_namespaces.update(value for value in record['user_namespace_lineage'] if value != outer_namespace)
        except (FileNotFoundError, ProcessLookupError):
            if owned:
                raise ValueError('workspace-process-disappeared-during-census')
    for pid, record in candidates.items():
        if workspace_namespaces.intersection(record['user_namespace_lineage']):
            processes[pid] = record
    groups = []
    for path in Path('/sys/fs/cgroup').rglob('cgroup.procs'):
        if 'sealant-native-' in str(path):
            pids = [int(value) for value in path.read_text().split()]
            groups.append({'path': str(path.parent), 'pids': pids})
            if any(pid not in processes for pid in pids):
                raise ValueError('cgroup-process-missing-from-census')
    return {'processes': list(processes.values()), 'cgroups': groups}


def invoke(program, *args):
    return [str(BUNDLE / 'lib64/ld-linux-x86-64.so.2'), '--inhibit-cache', '--library-path', LIBRARIES,
            str(BUNDLE / program.lstrip('/')), *args]


def run(program, *args, timeout=10):
    result = subprocess.run(invoke(program, *args), env=ENV, text=True, capture_output=True, timeout=timeout)
    if result.returncode:
        raise ValueError('semantic-command-failed:' + program + ':' + result.stderr[:1024])
    return result.stdout


def semantic_checks():
    outer = Path('/proc/self')
    if os.getuid() != 0 or (outer / 'uid_map').read_text().split() != ['0', '0', '4294967295']:
        raise ValueError('not-outer-owner')
    if not Path('/sys/fs/cgroup/cgroup.controllers').is_file() or Path('/etc/ld.so.preload').exists():
        raise ValueError('incompatible-kernel-or-preload')
    if (outer / 'ns/user').stat().st_ino != Path('/proc/1/ns/user').stat().st_ino:
        raise ValueError('outer-user-namespace-mismatch')
    effective = run('/usr/bin/systemctl', 'show', 'sealant-held.service',
                    '-p', 'NotifyAccess', '-p', 'FragmentPath', '-p', 'DropInPaths', '-p', 'ExecStart')
    properties = dict(line.split('=', 1) for line in effective.splitlines())
    expected = invoke('/usr/bin/python3', '-I', '-S', '-B', str(ROOT / 'guest_boot.py'), 'boot')
    command = properties.get('ExecStart', '')
    if (set(properties) != {'NotifyAccess', 'FragmentPath', 'DropInPaths', 'ExecStart'} or
            properties['NotifyAccess'] != 'none' or properties['DropInPaths'] != '' or
            properties['FragmentPath'] != '/etc/systemd/system/sealant-held.service' or
            command.count('{ path=') != 1 or command.split(' ; ')[:3] !=
            ['{ path=' + expected[0], 'argv[]=' + ' '.join(expected), 'ignore_errors=no']):
        raise ValueError('held-service-policy-mismatch')
    if run('/usr/bin/systemctl', 'show', 'sealant-workspace.service', '-p', 'MainPID', '--value').strip() != '0':
        raise ValueError('ordinary-workspace-running')
    return {'outer_uid': 0, 'cgroup_v2': True, 'outer_user_namespace': True,
            'ordinary_main_pid': 0, 'notify_access': properties['NotifyAccess'],
            'fragment_path': properties['FragmentPath'], 'drop_in_paths': properties['DropInPaths'],
            'exec_start': command}


def verify_protected(manifest, bundle):
    actual_bundle = sorted(str(path) for path in bundle.rglob('*') if path.is_file() or path.is_symlink())
    if actual_bundle != sorted(manifest.bundle_paths):
        raise ValueError('bundle-closure-changed')
    if any('__pycache__' in path or path.endswith(('.pyc', '.pyo')) for path in actual_bundle):
        raise ValueError('bytecode-cache-forbidden')
    observed = {}
    for path, expected in manifest.files.items():
        actual = file_identity(Path(path), expected.sha256)
        if (actual.sha256, actual.uid, actual.gid, actual.mode) != (expected.sha256, expected.uid, expected.gid, expected.mode):
            raise ValueError('protected-file-changed:' + path)
        observed[path] = asdict(actual)
    return digest(canonical(observed))

def check(manifest, policy, approval, held):
    reasons = []
    observations = {}
    try:
        root_info = ROOT.stat()
        if (root_info.st_uid, stat.S_IMODE(root_info.st_mode)) != (0, 0o700):
            raise ValueError('unsafe-protected-root')
        fingerprint = verify_protected(manifest, BUNDLE)
        profile = approved_profile(policy, approval, digest(manifest.bytes()))
        if profile is None:
            reasons.append('unapproved-shipped-guest-profile')
        observations['protected_fingerprint'] = fingerprint
        units = owned_units()
        processes = {process.identity.pid: process for process in held}
        extra = []
        observations['owned_mappings'] = {}
        try:
            for pid in sorted(set(units) | set(processes)):
                process = processes.get(pid)
                if process is None:
                    process = HeldProcess(pid)
                    extra.append(process)
                try:
                    def alias(path):
                        prefix = '/run/sealant-runtime/'
                        return str(BUNDLE / path[len(prefix):]) if path.startswith(prefix) else path
                    own = executable_mappings(pid, alias, manifest.files)
                except DeletedMappingError:
                    if pid in units and not reasons:
                        observations['restart_unit'] = units[pid]
                    raise
                if pid == os.getpid() and str(BUNDLE / 'usr/bin/python3') not in {mapping.path for mapping in own}:
                    raise ValueError('owned-interpreter-mapping-missing')
                observations['owned_mappings'][str(pid)] = [asdict(mapping) for mapping in own]
                if own:
                    reasons.extend(mapping_failures(manifest.files, own, process.identity, identity(pid)))
                process.verify()
        finally:
            for process in extra:
                process.close()
        if any(not str(path).startswith(str(BUNDLE) + '/') and str(path) != str(ROOT) for path in sys.path):
            raise ValueError('interpreter-import-path-escaped')
        observations['semantics'] = semantic_checks()
        observations['census'] = census()
        if observations['census']['processes']:
            reasons.append('existing-workspace-writer')
        for process in held:
            process.verify()
        return profile, reasons, observations
    except Exception as error:
        if isinstance(error, FileObservationError):
            observations['file_failure'] = error.observation
        return None, [*reasons, type(error).__name__ + ':' + str(error)], observations


class BootJournal:
    def __init__(self, root, binding):
        self.root = root
        self.events = root / 'boots' / binding.boot_id
        self.events.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.boot_id = binding.boot_id
        self.sequence = len(self.paths())
        for path in (self.events.parent, self.root):
            descriptor = os.open(path, os.O_DIRECTORY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)

    def paths(self):
        paths = sorted(self.events.glob('*.json'))
        if [path.name for path in paths] != [f'{index:08d}.json' for index in range(len(paths))]:
            raise ValueError('held-journal-sequence-gap')
        return paths

    def current(self):
        previous = None
        for path in self.paths():
            state = state_from_record(private_json(path)['state'])
            if state.binding.boot_id != self.boot_id or (previous is not None and
                    (state.first_invocation, state.deadline) != (previous.first_invocation, previous.deadline)):
                raise ValueError('held-journal-binding-or-deadline-changed')
            previous = state
        return previous

    def append(self, state, observation=None):
        record = {'state': state.record(), 'at_monotonic': time.monotonic(), 'observation': observation}
        save(self.events / f'{self.sequence:08d}.json', record, exclusive=True)
        self.sequence += 1
        save(self.root / 'held-state.json', record)

    def restart_units(self):
        return {record['observation']['mapping_restart'] for path in self.paths()
                if isinstance((record := private_json(path)).get('observation'), dict)
                and record['observation'].get('mapping_restart') in OWNED_UNITS}


def binding_for(manifest_digest, approval):
    instance = private_json(ROOT / 'instance.json') if (ROOT / 'instance.json').exists() else {}
    if instance.get("boot_id") != boot_id():
        instance = {}
    return BootBinding(boot_id(), instance.get('instance_id', 'unbound'), instance.get('disk_lineage', 'unbound'),
                       manifest_digest, approval['profile'] if approval else 'unapproved')


def state_from_record(record):
    return BootState(BootBinding(**record['binding']), Status(record['status']), record['first_invocation'],
                     record['deadline'], record['stable'], record['observed_profile'], tuple(record['reasons']))


def run_checks(state, journal, inspect, retry, clock=time.monotonic, sleep=time.sleep, current_binding=None, restart=None):
    settled = None
    stable_files = 0
    while state.status != Status.TIMED_OUT:
        if current_binding is not None:
            binding = current_binding()
            if binding != state.binding:
                state = replace(state, binding=binding, stable=0, observed_profile=None)
        state = replace(state, status=Status.CHECKING)
        check_index = journal.sequence
        journal.append(state)
        started = clock()
        try:
            profile, reasons, observation = inspect()
        except Exception as error:
            profile, reasons, observation = None, [type(error).__name__ + ':' + str(error)], {}
        finished = clock()
        observation['check'] = {'index': check_index, 'binding': asdict(state.binding),
                                'started_monotonic': started, 'finished_monotonic': finished}
        state = transition(state, finished, profile, reasons, retry['stableObservations'])
        journal.append(state, observation)
        if state.status in (Status.COMPATIBLE, Status.TIMED_OUT):
            return state
        candidate = (observation.get('restart_unit'), observation.get('protected_fingerprint'))
        stable_files = stable_files + 1 if candidate == settled else 1
        settled = candidate
        unit, fingerprint = candidate
        if (restart is not None and unit in OWNED_UNITS and fingerprint is not None
                and stable_files >= retry['stableObservations'] and unit not in journal.restart_units()):
            journal.append(state, {'mapping_restart': unit, 'protected_fingerprint': fingerprint})
            restart(unit)
            stable_files = 0
        sleep(min(retry['intervalSeconds'], max(0, state.deadline - clock())))
    return state


def awaiting_binding():
    # Publications contain no runtime identity. Begin the bounded inspection only after delivery.
    if not (ROOT / 'manifest.json').exists() or not (ROOT / 'source-approval.json').exists():
        return False
    events = ROOT / 'boots' / boot_id()
    if events.exists() and any(events.glob('*.json')):
        return False
    return binding_for('unavailable', None).instance_id == 'unbound'


def held_boot():
    if awaiting_binding():
        return {'status': 'held', 'admission': 'held', 'reason': 'awaiting-current-boot-binding'}
    started = time.monotonic()
    binding = BootBinding(boot_id(), 'unbound', 'unbound', 'unavailable', 'unapproved')
    journal = BootJournal(ROOT, binding)
    state = initial_state(binding, started, 60)
    previous = journal.current()
    if previous is not None:
        state = replace(state, first_invocation=previous.first_invocation, deadline=previous.deadline)
        if previous.status == Status.TIMED_OUT or started >= state.deadline:
            state = replace(state, status=Status.TIMED_OUT, reasons=('compatibility-deadline',))
            journal.append(state)
            return state.record()
    journal.append(state, {'first_held_invocation': state.first_invocation, 'ordinary_admission': 'unavailable'})
    held = []
    try:
        manifest = ProtectedManifest.parse(private_json(ROOT / 'manifest.json'))
        approval = private_json(ROOT / 'source-approval.json') if (ROOT / 'source-approval.json').exists() else None
        binding = binding_for(digest(manifest.bytes()), approval)
        state = replace(state, binding=binding)
        journal.append(state)
        policy = json.loads((ROOT / 'boot-policy.json').read_text())
        held = [HeldProcess(os.getpid())]
        def inspect():
            profile, reasons, observation = check(manifest, policy, approval, held)
            if binding_for(digest(manifest.bytes()), approval).instance_id == 'unbound':
                reasons.append('future-core-binding-missing')
            return profile, reasons, observation
        return run_checks(state, journal, inspect, policy['retry'],
                          current_binding=lambda: binding_for(digest(manifest.bytes()), approval),
                          restart=restart_owned).record()
    except Exception as error:
        state = replace(state, status=Status.INCOMPATIBLE, stable=0, reasons=(type(error).__name__ + ':' + str(error),))
        journal.append(state)
        return state.record()
    finally:
        for process in held:
            process.close()


def restart_owned(unit):
    if unit not in OWNED_UNITS:
        raise ValueError('restart-unit-not-owned')
    if unit in ('sealant-workspace.service', 'sealant-native-workspace.service', 'sealant-recovery.service', 'sealant-native-recovery.service'):
        raise ValueError('ordinary-invocation-restart-requires-canonical-recovery')
    if owned_units().get(os.getpid()) == unit:
        os.execve(str(BUNDLE / 'lib64/ld-linux-x86-64.so.2'),
                  invoke('/usr/bin/python3', '-I', '-S', '-B', str(ROOT / 'guest_boot.py'), 'boot'), ENV)
    run('/usr/bin/systemctl', '--no-block', 'try-restart', unit, timeout=5)


def watchdog_state(current, actual_boot, now):
    if current is None or current.binding.boot_id != actual_boot:
        binding = BootBinding(actual_boot, 'unbound', 'unbound', 'unavailable', 'unapproved')
        return replace(initial_state(binding, now, 0), status=Status.TIMED_OUT,
                       reasons=('watchdog-missing-current-boot-inspection',))
    if current.status not in (Status.COMPATIBLE, Status.TIMED_OUT) and now >= current.deadline:
        return replace(current, status=Status.TIMED_OUT, stable=0,
                       reasons=(*current.reasons, 'watchdog-held-deadline'))
    return current


def watchdog():
    if awaiting_binding():
        return {'status': 'held', 'admission': 'held', 'reason': 'awaiting-current-boot-binding'}
    binding = BootBinding(boot_id(), 'unbound', 'unbound', 'unavailable', 'unapproved')
    journal = BootJournal(ROOT, binding)
    current = journal.current()
    state = watchdog_state(current, boot_id(), time.monotonic())
    if state != current:
        journal.append(state)
    return state.record()


def revalidate():
    manifest = ProtectedManifest.parse(private_json(ROOT / 'manifest.json'))
    approval = private_json(ROOT / 'source-approval.json')
    policy = json.loads((ROOT / 'boot-policy.json').read_text())
    binding = binding_for(digest(manifest.bytes()), approval)
    journal = BootJournal(ROOT, binding)
    current = journal.current()
    if current is None or current.status != Status.COMPATIBLE or receipt_failures(asdict(current.binding), binding):
        raise ValueError('no-current-compatible-boot')
    held = [HeldProcess(os.getpid())]
    try:
        profile, reasons, observations = check(manifest, policy, approval, held)
        if reasons or profile != binding.approved_profile:
            journal.append(replace(current, status=Status.INCOMPATIBLE, stable=0, reasons=tuple(reasons)), observations)
            raise ValueError('immediate-revalidation-failed:' + ','.join(reasons))
        return manifest, held, observations
    except BaseException:
        for process in held:
            process.close()
        raise


def owner_operation(mode, operation_path):
    if mode not in ('build', 'probe'):
        raise ValueError('ordinary-admission-unavailable')
    operation = private_json(operation_path)
    if operation.get('mode') != mode or operation.get('boot_id') != boot_id():
        raise ValueError('stale-owner-operation')
    script = Path(operation['script'])
    if not script.is_relative_to(ROOT) or file_identity(script).sha256 != operation['sha256']:
        raise ValueError('owner-script-mismatch')
    if script.stat().st_uid != 0 or stat.S_IMODE(script.stat().st_mode) != 0o644:
        raise ValueError('unsafe-owner-script')
    receipt = ROOT / ('operation-' + digest(canonical(operation)) + '.json')
    if receipt.exists():
        raise ValueError('owner-operation-already-issued')
    manifest, held, observations = revalidate()
    try:
        save(receipt, {'operation': operation, 'status': 'issued', 'identities': [asdict(p.identity) for p in held],
                       'revalidation': observations}, exclusive=True)
        for item in held:
            item.verify()
        return launch_mapped(mode, script, manifest, held, observations, receipt, operation)
    finally:
        for item in held:
            item.close()


def mapped_gates(candidates, root, owner):
    return [item for item in candidates
            if (item['identity']['root_device'], item['identity']['root_inode']) == (root.st_dev, root.st_ino)
            and all(item['identity'][namespace] != getattr(owner, namespace)
                    for namespace in ('pid_namespace', 'mount_namespace', 'user_namespace'))]


def mapped_argv(mode, script):
    if mode in ('workspace', 'recovery'):
        import guest_network as network
    resume_mounts = []
    if mode == 'workspace' and (ROOT / 'resume.json').exists():
        import guest_resume
        resume_mounts = ['--bind=' + entry['source'] + ':' + entry['path'] for entry in guest_resume.mounts()]
    argv = invoke('/usr/bin/systemd-nspawn', '--quiet', '--settings=no', '--register=no', '--keep-unit',
                  '--machine=sealant-native', '--directory=' + str(MAPPED_ROOT), '--private-users=131072:65536',
                  '--private-users-ownership=chown', '--notify-ready=no', '--console=pipe', '--link-journal=no',
                  '--bind-ro=' + str(BUNDLE) + ':/run/sealant-runtime',
                  '--bind-ro=' + str(ROOT / 'workspace-launch.py') + ':/run/sealant-entry.py',
                  '--bind-ro=' + str(script) + ':/run/sealant-operation',
                  *(['--private-network'] if mode == 'probe' else []),
                  *(['--bind-ro=' + str(script.parent) + ':/run/sealant-inputs',
                     '--bind-ro=' + str(ROOT / 'sealantd') + ':/usr/local/bin/sealantd',
                     '--resolv-conf=off',
                     '--bind-ro=' + str(network.resolver_path()) + ':/etc/resolv.conf'] if mode in ('workspace', 'recovery') else []),
                  *resume_mounts,
                  '/run/sealant-runtime/lib64/ld-linux-x86-64.so.2', '--inhibit-cache', '--library-path',
                  '/run/sealant-runtime/lib/x86_64-linux-gnu:/run/sealant-runtime/usr/lib/x86_64-linux-gnu',
                  '/run/sealant-runtime/usr/bin/python3', '-I', '-S', '-B', '/run/sealant-entry.py')
    # Join while still outer root. nspawn cannot setns into an outer-owned network after UID mapping.
    return invoke('/usr/bin/nsenter', '--net=' + str(network.NAMESPACE), '--', *argv) if mode in ('workspace', 'recovery') else argv


def launch_mapped(mode, script, manifest, held, observations, receipt, operation, verified=None):
    network = None
    if mode in ('workspace', 'recovery'):
        import guest_network as network
        network.verify(operation)
    argv = mapped_argv(mode, script)
    process = subprocess.Popen(invoke('/usr/bin/systemd-run', '--quiet', '--wait', '--pipe', '--collect',
                               '--unit=sealant-native-' + mode, '--service-type=exec', '-p', 'KillMode=control-group',
                               '-p', 'Restart=no', '-p', 'Delegate=no', '-p', 'NotifyAccess=none',
                               *(['-p', 'BindsTo=sealant-' + mode + '.service', '-p', 'Slice=sealant-workspace.slice'] if mode in ('workspace', 'recovery') else ['-p', 'RuntimeMaxSec=600']), *argv), env=ENV, stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    launcher = None
    gate = None
    mappings = []
    gate_mappings = []
    candidates = []
    try:
        limit = time.monotonic() + 15
        while time.monotonic() < limit:
            if not select.select([process.stdout], [], [], max(0, limit - time.monotonic()))[0]:
                raise ValueError('mapped-gate-ready-timeout')
            line = process.stdout.readline()
            if line.strip() == b'sealant-native-gate-ready':
                break
            if not line:
                raise ValueError('mapped-gate-ended-before-verification')
            sys.stdout.buffer.write(line)
        else:
            raise ValueError('mapped-gate-ready-timeout')
        value = run('/usr/bin/systemctl', 'show', 'sealant-native-' + mode, '-p', 'MainPID', '--value').strip()
        launcher = HeldProcess(int(value))
        mappings = executable_mappings(int(value), expected_files=manifest.files)
        failures = mapping_failures(manifest.files, mappings, launcher.identity, identity(int(value)))
        if str(BUNDLE / 'usr/bin/systemd-nspawn') not in {mapping.path for mapping in mappings}:
            failures.append('owned-launcher-mapping-missing')
        candidates = census()['processes']
        gates = mapped_gates(candidates, MAPPED_ROOT.stat(), held[0].identity)
        if len(gates) != 1:
            raise ValueError('mapped-gate-identity-ambiguous')
        gate = HeldProcess(gates[0]['identity']['pid'])
        def alias(path):
            prefix = '/run/sealant-runtime/'
            return str(BUNDLE / path[len(prefix):]) if path.startswith(prefix) else path
        gate_mappings = executable_mappings(gate.identity.pid, alias, manifest.files)
        failures.extend(mapping_failures(manifest.files, gate_mappings, gate.identity, identity(gate.identity.pid)))
        if str(BUNDLE / 'usr/bin/python3') not in {mapping.path for mapping in gate_mappings}:
            failures.append('owned-gate-interpreter-mapping-missing')
        if network is not None:
            network.verify(operation, gate.identity.pid)
        if failures:
            raise ValueError(','.join(failures))
        if launcher is None:
            raise ValueError('launcher-verification-timeout')
        for item in [*held, launcher, gate]:
            item.verify()
        save(receipt, {'operation': operation, 'status': 'verified-launcher', 'launcher': asdict(launcher.identity),
                       'mappings': [asdict(mapping) for mapping in mappings], 'gate': asdict(gate.identity),
                       'gate_mappings': [asdict(mapping) for mapping in gate_mappings], 'revalidation': observations})
        if verified is not None:
            verified(launcher, gate)
        process.stdin.write(canonical({'mode': mode}) + b'\n')
        process.stdin.flush()
        process.stdin.close()
        process.stdin = None
        if mode in ('workspace', 'recovery'):
            while chunk := process.stdout.read(65536):
                sys.stdout.buffer.write(chunk)
                sys.stdout.buffer.flush()
            process.wait()
        else:
            output, _ = process.communicate(timeout=610)
            sys.stdout.buffer.write(output)
            sys.stdout.buffer.flush()
        result = process.returncode
        save(receipt, {'operation': operation, 'status': 'ended', 'exit_code': result,
                       'launcher': asdict(launcher.identity), 'gate': asdict(gate.identity),
                       'gate_mappings': [asdict(mapping) for mapping in gate_mappings],
                       'mappings': [asdict(mapping) for mapping in mappings], 'revalidation': observations})
        return {'exit_code': result, 'receipt': str(receipt)}
    except BaseException as error:
        save(receipt, {'operation': operation, 'status': 'held-launch-failure',
                       'reason': type(error).__name__ + ':' + str(error), 'census': candidates,
                       'mappings': [asdict(mapping) for mapping in mappings],
                       'gate_mappings': [asdict(mapping) for mapping in gate_mappings],
                       'revalidation': observations})
        raise
    finally:
        if process.poll() is None:
            run('/usr/bin/systemctl', 'stop', 'sealant-native-' + mode, timeout=15)
            process.wait(timeout=20)
        if launcher:
            launcher.close()
        if gate:
            gate.close()
def main():
    os.umask(0o077)
    if os.geteuid() != 0 or Path('/proc/self/uid_map').read_text().split() != ['0', '0', '4294967295']:
        raise ValueError('outer-owner-required')
    action = sys.argv[1]
    with open(ROOT / 'guest.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if action == 'boot':
            result = held_boot()
        elif action == 'watchdog':
            result = watchdog()
        elif action == 'resume':
            import guest_resume
            if len(sys.argv) != 3 or len(sys.argv[2]) > 8192:
                raise ValueError('invalid-resume-request')
            import guest_capsule
            with guest_capsule.deadline():
                result = guest_resume.rebind(json.loads(sys.argv[2]))
        elif action == 'bind':
            from guest_receiver import bind
            if len(sys.argv) != 3 or len(sys.argv[2]) > 8192:
                raise ValueError('invalid-bootstrap-request')
            result = bind(json.loads(sys.argv[2]))
            result['boot'] = held_boot()
            run('/usr/bin/systemctl', 'start', 'sealant-bootstrap.service', 'sealant-control-relay.service', timeout=15)
        elif action in ('build', 'probe'):
            result = owner_operation(action, Path(sys.argv[2]))
        else:
            raise ValueError('ordinary-admission-unavailable')
    print(json.dumps(result, sort_keys=True))
    if action in ("build", "probe") and result["exit_code"] != 0:
        raise SystemExit(result["exit_code"])


if __name__ == '__main__':
    main()
