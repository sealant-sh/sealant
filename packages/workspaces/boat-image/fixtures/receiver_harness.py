"""Test-only: run the shipped receiver entry with privileged guest observations substituted.

Requests still reach the real entry file, route table, HTTP handler, parsers and route actions.
Only root ownership, tmpfs, held-boot inspection, kernel networking, systemd and DNS observations
are replaced, because an unprivileged test process cannot make them.

argv: <boat-image directory> <private state directory> <options JSON>
"""
import contextlib
import json
import os
from pathlib import Path
import runpy
import sys
import time

image, state, options = Path(sys.argv[1]), Path(sys.argv[2]), json.loads(sys.argv[3])
sys.path.insert(0, str(image))
import guest_boot as guest  # noqa: E402
import guest_invocation as invocation  # noqa: E402
import guest_network as network  # noqa: E402
import guest_readiness as readiness  # noqa: E402
import guest_receiver as receiver  # noqa: E402

runtime = state / 'runtime'
runtime.mkdir(mode=0o700, exist_ok=True)
guest.ROOT = state
receiver.RUNTIME = runtime
guest.boot_id = lambda: options['bootId']
# What the provider-command bind leaves behind for this disk. Bind is not an HTTP route.
if not (state / 'receiver.json').exists():
    guest.save(state / 'receiver.json', {'format': 'sealant-receiver-v1', 'identity': options['identity'], 'admission': None})
# Root ownership of private records.
guest.private_json = lambda path: json.loads(Path(path).read_bytes())
receiver.private_directory = lambda path: path.mkdir(mode=0o700, exist_ok=True)
receiver.require_outer_owner = lambda: None
receiver.require_tmpfs = lambda: None
# Held-boot inspection and same-boot process pinning.
guest.revalidate = lambda: (None, [], {})
receiver.revalidate_execution = lambda: []
receiver.locked = contextlib.nullcontext
receiver.current_control = lambda: {'boot_id': options['bootId'], 'token': receiver.Bearer(options['token'])}
# Kernel networking: `wg pubkey` derivation, namespace setup and its observation.
command = network.command
network.command = lambda program, *args, **kwargs: (
    options['wireguardPublicKey'] if (program, args) == ('/usr/bin/wg', ('pubkey',)) else command(program, *args, **kwargs))
network.prepare = lambda config: None
network.inspect = lambda config: {'namespace': {'device': 1, 'inode': 1}}
if 'dnsPort' in options:
    # The real peer(): its DNS probe runs as a real process against the test's resolver on
    # loopback instead of the tunnel gateway. Only entering the namespace and reading the
    # kernel's WireGuard handshake are substituted.
    readiness.DNS_PROBE = readiness.DNS_PROBE.replace("('100.127.255.253',53)", repr(('127.0.0.1', options['dnsPort'])))
    invoke = guest.invoke

    def local(program, *args):
        if program == '/usr/bin/nsenter':
            return list(args[args.index('--') + 1:])
        if program == '/usr/bin/python3':
            return [sys.executable, *args]
        if program == '/usr/bin/wg' and args[0] == 'show':
            gateway = json.loads(network.record_path().read_bytes())['config']['gateway_key']
            return [sys.executable, '-c', 'print(%r)' % (gateway + '\t1700000000')]
        return invoke(program, *args)
    guest.invoke = local
else:
    readiness.peer = lambda binding: {'dns': 'udp-and-tcp', 'nonce': 'd' * 32}
if not options.get('kernelLimits'):
    # Otherwise the real limits() reads systemd properties and refuses their absence.
    readiness.limits = lambda: '/sealant.slice/sealant-workspace.slice'


def run(program, *args, timeout=10):
    """systemd: starting the workspace unit records the invocation it would run."""
    if program == '/usr/bin/systemctl' and args == ('--no-block', 'start', invocation.UNIT):
        record = json.loads(invocation.path().read_bytes())
        group = '0::/sealant.slice/sealant-workspace.slice/'
        guest.save(invocation.path(), {
            **record, 'status': 'running',
            'owner': {'systemd_invocation': 'd' * 32, 'process': {'cgroup': group + 'workspace'}},
            'launcher': {'pid': os.getpid(), 'cgroup': group + 'native'},
            'gate': {'pid': os.getpid(), 'cgroup': group + 'native/payload'}})
    return ''


guest.run = run


def observe(record_path=None, unit=invocation.UNIT):
    """systemd and /proc: an issued unit that the emulation above started is running."""
    record_path = invocation.path() if record_path is None else record_path
    if not record_path.exists():
        return 'unavailable'
    return 'running' if json.loads(record_path.read_bytes())['status'] == 'running' else 'issued'


invocation.observe = observe
journal = state / 'dispatched.jsonl'
# Main has no ACTIONS table; record nothing there rather than fail before the entry runs.
for name, action in list(getattr(receiver, 'ACTIONS', {}).items()):
    def dispatched(value, name=name, action=action):
        with journal.open('a') as stream:
            stream.write(json.dumps({'route': name}) + '\n')
        time.sleep(options.get('delays', {}).get(name, 0))
        return action(value)
    receiver.ACTIONS[name] = dispatched

# Exactly what bootstrap.service runs: the shipped file as __main__.
sys.argv = [str(image / 'guest_receiver.py')]
runpy.run_path(str(image / 'guest_receiver.py'), run_name='__main__')
