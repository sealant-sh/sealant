"""Exclude workspace writers, export volatile data, then close their exact cgroup."""
from dataclasses import asdict
import os
from pathlib import Path
import re
import time

import guest_boot as guest
import guest_capsule as capsule
import guest_invocation as invocation
import guest_readiness as readiness
import guest_receiver as receiver
from guest_contract import digest


def path():
    return guest.ROOT / 'parking.json'


def request_for(binding, operation_id):
    return {'format': 'sealant-parking-close-v1', 'binding': binding, 'operation_id': operation_id}


def state():
    record = guest.private_json(path())
    receiver.fields(record, {'format', 'request', 'phase', 'source', 'volumes', 'capsule'})
    if record['format'] != 'sealant-parking-state-v1' or record['phase'] not in ('closing', 'exported', 'closed'):
        raise receiver.Refusal('invalid-parking-record')
    receiver.fields(record['source'], {'group', 'cgroup_identity', 'gate'})
    return record


def directory(request):
    return guest.ROOT / 'capsules' / request['operation_id']


def status():
    record = state()
    return {'format': 'sealant-parking-status-v1', 'request': record['request'], 'phase': record['phase'],
            'capsule': record['capsule'], 'writers': 'closed' if record['phase'] == 'closed' else 'held'}


class Writers:
    """An outer receiver keeps the slice and namespace descriptors while all descendants are frozen."""
    def __init__(self, record):
        self.record = record
        self.process = None
        self.root = None
        self.group = None
        self.events = None
        self.absent = False

    def __enter__(self):
        source = self.record['source']
        group = source['group']
        if (not group.startswith('/') or '..' in Path(group).parts or Path(group).name != readiness.SLICE
                or guest.identity(os.getpid()).cgroup.rstrip('/') == '0::' + group
                or guest.identity(os.getpid()).cgroup.startswith('0::' + group + '/')):
            raise receiver.Refusal('parking-cgroup-owner-conflict')
        try:
            try:
                self.group = os.open(readiness.CGROUP / group.lstrip('/'), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            except FileNotFoundError:
                if self.record['phase'] != 'exported' or guest.census()['processes']:
                    raise receiver.Refusal('parking-writer-exclusion-unconfirmed')
                self.absent = True
                return self
            info = os.fstat(self.group)
            if [info.st_dev, info.st_ino] != source['cgroup_identity']:
                raise receiver.Refusal('parking-cgroup-replaced')
            self.events = os.open('cgroup.events', os.O_RDONLY | os.O_NOFOLLOW, dir_fd=self.group)
            if self.record['phase'] == 'closing':
                self.process = guest.HeldProcess(source['gate']['pid'])
                if asdict(self.process.identity) != source['gate']:
                    raise receiver.Refusal('parking-source-process-changed')
                self.root = os.open('/proc/' + str(source['gate']['pid']) + '/root', os.O_RDONLY | os.O_DIRECTORY)
                info = os.fstat(self.root)
                if (info.st_dev, info.st_ino) != (source['gate']['root_device'], source['gate']['root_inode']):
                    raise receiver.Refusal('parking-source-root-changed')
                self.write('cgroup.freeze', b'1')
                self.wait('frozen', '1')
                self.process.verify()
            elif self.observed().get('populated') != '0' and self.observed().get('frozen') != '1':
                raise receiver.Refusal('parking-writers-thawed')
            return self
        except BaseException:
            self.__exit__(None, None, None)
            raise

    def __exit__(self, *_):
        if self.process is not None:
            self.process.close()
        for descriptor in (self.root, self.events, self.group):
            if descriptor is not None:
                os.close(descriptor)

    def write(self, name, value):
        descriptor = os.open(name, os.O_WRONLY | os.O_NOFOLLOW, dir_fd=self.group)
        try:
            if os.write(descriptor, value) != len(value):
                raise receiver.Refusal('parking-cgroup-write-incomplete')
        finally:
            os.close(descriptor)

    def observed(self):
        os.lseek(self.events, 0, os.SEEK_SET)
        return dict(line.split() for line in os.read(self.events, 4096).decode().splitlines())

    def wait(self, key, expected):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if self.observed().get(key) == expected:
                return
            time.sleep(0.02)
        raise receiver.Refusal('parking-writer-exclusion-unconfirmed')

    def close(self):
        if not self.absent:
            self.write('cgroup.kill', b'1')
            self.wait('populated', '0')
        if guest.census()['processes']:
            raise receiver.Refusal('parking-workspace-writers-remain')


def close(request):
    receiver.fields(request, {'format', 'binding', 'operation_id'})
    if (request['format'] != 'sealant-parking-close-v1'
            or not isinstance(request['operation_id'], str)
            or not re.fullmatch(r'[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}', request['operation_id'])):
        raise receiver.Refusal('invalid-parking-request')
    expected = invocation.binding()
    if request['binding'] != expected:
        raise receiver.Refusal('parking-binding-conflict')
    if path().exists():
        record = state()
        if record['request'] != request:
            raise receiver.Refusal('parking-intent-conflict')
        if record['phase'] == 'closed':
            return status()
    else:
        if (guest.ROOT / 'recovery.json').exists() or invocation.observe() not in ('running', 'ended'):
            raise receiver.Refusal('parking-source-not-running')
        source = invocation.state()
        group = readiness.limits()
        gate = guest.identity(source['gate']['pid'])
        if not gate.cgroup.startswith('0::' + group + '/'):
            raise receiver.Refusal('parking-source-outside-slice')
        for process in guest.census()['processes']:
            if not process['identity']['cgroup'].startswith('0::' + group + '/'):
                raise receiver.Refusal('parking-uncontained-workspace-writer')
        receiver.private_directory(guest.ROOT / 'capsules')
        group_info = (readiness.CGROUP / group.lstrip('/')).stat()
        record = {'format': 'sealant-parking-state-v1', 'request': request, 'phase': 'closing',
                  'source': {'group': group, 'cgroup_identity': [group_info.st_dev, group_info.st_ino],
                             'gate': asdict(gate)}, 'volumes': None, 'capsule': None}
        # This closes all ordinary and capture-recovery starts before any freeze or writer stop.
        guest.save(path(), record, exclusive=True)
    with capsule.deadline(), Writers(record) as writers:
        destination = directory(request)
        if record['phase'] == 'closing':
            document = Path('/proc/' + str(record['source']['gate']['pid']) + '/mountinfo').read_text()
            import guest_resume as resume
            retained_paths = [item['path'] for item in resume.mounts()] if resume.path().exists() else []
            volumes = capsule.plan(document, retained_paths)
            if record['volumes'] is not None and record['volumes'] != volumes:
                raise receiver.Refusal('parking-mount-plan-changed')
            record = {**record, 'volumes': volumes}
            guest.save(path(), record)
            if destination.exists():
                # A previous exporter can only be adopted from its complete, durable manifest.
                raw = (destination / 'manifest.json').read_bytes()
                manifest = capsule.verify(destination, digest(raw), request)
                if [volume['path'] for volume in manifest['volumes']] != [volume['path'] for volume in volumes]:
                    raise receiver.Refusal('parking-capsule-volume-conflict')
                receipt = capsule.receipt(destination, manifest)
            else:
                receipt = capsule.export(writers.root, volumes, destination, request)
            record = {**record, 'phase': 'exported', 'capsule': receipt}
            guest.save(path(), record)
        manifest = capsule.verify(destination, record['capsule']['sha256'], request)
        if capsule.receipt(destination, manifest) != record['capsule']:
            raise receiver.Refusal('parking-capsule-pack-changed')
        writers.close()
        # Hygiene only. Correctness rests on the fsynced capsule and positive writer closure.
        os.sync()
        record = {**record, 'phase': 'closed'}
        guest.save(path(), record)
    return status()
