"""Provider-authenticated cold custody handoff. No setup, harness or admission is replayed."""
import json
import os
from pathlib import Path
import re
import shutil

import guest_boot as guest
import guest_capsule as capsule
import guest_parking as parking
import guest_receiver as receiver
from guest_contract import canonical, digest


def path():
    return guest.ROOT / 'resume.json'


def sync_directory(directory):
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def rebind(request):
    receiver.fields(request, {'format', 'source_request', 'capsule', 'identity', 'boot_id', 'operation_id', 'capture_launch_id'})
    receiver.fields(request['identity'], receiver.IDENTITY_KEYS)
    receiver.fields(request['source_request'], {'format', 'binding', 'operation_id'})
    receiver.fields(request['source_request']['binding'], {'identity', 'boot_id', 'epoch', 'operation_id'})
    receiver.fields(request['source_request']['binding']['identity'], receiver.IDENTITY_KEYS)
    for value in [*request['identity'].values(), request['operation_id'], request['capture_launch_id']]:
        receiver.name(value)
    if (request['format'] != 'sealant-parking-rebind-v1' or request['boot_id'] != guest.boot_id()
            or request['boot_id'] == request['source_request']['binding']['boot_id']
            or request['identity']['instance_id'] == request['source_request']['binding']['identity']['instance_id']
            or not re.fullmatch(r'[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}', request['operation_id'])):
        raise receiver.Refusal('invalid-cold-rebind')
    if guest.census()['processes']:
        raise receiver.Refusal('cold-rebind-existing-writer')
    if path().exists():
        record = guest.private_json(path())
        if record['request'] != request:
            source = parking.state() if parking.path().exists() else None
            if (record['phase'] != 'bound' or source is None or source['phase'] != 'closed'
                    or source['request'] != request['source_request'] or source['capsule'] != request['capsule']
                    or record['request']['identity'] != request['source_request']['binding']['identity']
                    or record['request']['boot_id'] != request['source_request']['binding']['boot_id']):
                raise receiver.Refusal('cold-rebind-conflict')
            prior = guest.ROOT / ('resume-history-' + record['request']['operation_id'] + '.json')
            if prior.exists():
                raise receiver.Refusal('cold-rebind-history-conflict')
            os.rename(path(), prior)
            sync_directory(guest.ROOT)
            return rebind(request)
        if record['phase'] == 'bound':
            if receiver.disk_state()['identity'] != request['identity']:
                raise receiver.Refusal('cold-rebind-identity-changed')
            return status(record)
    else:
        source = parking.state()
        if (source['phase'] != 'closed' or source['request'] != request['source_request']
                or source['capsule'] != request['capsule']):
            raise receiver.Refusal('cold-rebind-source-conflict')
        record = {'format': 'sealant-parking-resume-state-v1', 'request': request, 'phase': 'preparing', 'mounts': None}
        guest.save(path(), record, exclusive=True)
    source = parking.directory(request['source_request'])
    manifest = capsule.verify(source, request['capsule']['sha256'], request['source_request'])
    if capsule.receipt(source, manifest) != request['capsule']:
        raise receiver.Refusal('cold-rebind-capsule-changed')
    destination = guest.ROOT / ('resume-' + request['operation_id'])
    if record['mounts'] is None:
        # Only our unadmitted private materialization can exist at this exact intent path.
        if destination.exists():
            capsule.require_private_directory(destination)
            shutil.rmtree(destination)
        mounts = capsule.hydrate(source, request['capsule']['sha256'], request['source_request'], destination)
        if any(':' in item['path'] or ':' in item['source'] for item in mounts):
            raise receiver.Refusal('cold-rebind-mount-path')
        record = {**record, 'mounts': mounts}
        guest.save(path(), record)
    history = guest.ROOT / ('history-' + request['operation_id'])
    receiver.private_directory(history)
    for name in ('receiver.json', 'instance.json', 'invocation.json', 'invocation-daemon.json',
                 'recovery.json', 'recovery-invocation.json', 'parking.json'):
        old, kept = guest.ROOT / name, history / name
        if old.exists() and not kept.exists():
            os.rename(old, kept)
    sync_directory(history)
    sync_directory(guest.ROOT)
    if (guest.ROOT / 'receiver.json').exists():
        if receiver.disk_state() != {'format': 'sealant-receiver-v1', 'identity': request['identity'], 'admission': None}:
            raise receiver.Refusal('cold-rebind-identity-conflict')
    else:
        guest.save(guest.ROOT / 'receiver.json', {'format': 'sealant-receiver-v1', 'identity': request['identity'], 'admission': None}, exclusive=True)
    record = {**record, 'phase': 'bound'}
    guest.save(path(), record)
    return status(record)


def status(record):
    return {'format': 'sealant-parking-rebound-v1', 'boot_id': record['request']['boot_id'],
            'identity': record['request']['identity'], 'operation_id': record['request']['operation_id'],
            'capsule': record['request']['capsule'], 'admission': 'held'}


def mounts():
    record = guest.private_json(path())
    if (record['phase'] != 'bound' or record['request']['boot_id'] != guest.boot_id()
            or record['request']['identity'] != receiver.disk_state()['identity']):
        raise receiver.Refusal('cold-resume-binding-unavailable')
    return record['mounts']


def validate_launch(launch):
    record = guest.private_json(path())
    env = launch['boot_env']
    if (record['phase'] != 'bound' or record['request']['boot_id'] != guest.boot_id()
            or env.get('SEALANT_WORKSPACE_SOURCE') != 'capture'
            or env.get('SEALANT_CAPTURE_LAUNCH_ID') != record['request']['capture_launch_id']
            or env.get('SEALANT_LIFECYCLE_SETUP_JSON') != '[]'
            or env.get('SEALANT_LIFECYCLE_STARTUP_JSON') != '[]'
            or env.get('SEALANT_FOREGROUND_COMMAND') != 'sleep infinity'
            or any(key.startswith(('SEALANT_DOTFILES_', 'SEALANT_HARNESS_')) for key in env)):
        raise receiver.Refusal('cold-resume-replays-user-code')
