import json
import os
import sys

if os.getpid() != 1:
    raise SystemExit('mapped entry requires PID1')
if open('/proc/self/uid_map').read().split() != ['0', '131072', '65536']:
    raise SystemExit('mapped authority mismatch')
print("sealant-native-gate-ready", flush=True)
operation = json.loads(sys.stdin.buffer.readline(4096))
if operation == {'mode': 'workspace'}:
    launch = json.load(open('/run/sealant-inputs/launch'))
    if launch.get('format') != 'sealant-daemon-launch-v1':
        raise SystemExit('invalid-daemon-launch')
    os.execve('/usr/local/bin/sealantd', ['/usr/local/bin/sealantd', 'boot'], {
        **launch['boot_env'], 'PATH': '/usr/local/bin:/nix/var/nix/profiles/default/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        'HOME': '/root', 'LANG': 'C.UTF-8',
        'SEALANT_CONTROL_SOCKET': '/run/sealant/control.sock',
    })
if operation not in ({'mode': 'build'}, {'mode': 'probe'}):
    raise SystemExit('ordinary admission unavailable')
os.execve('/bin/bash', ['/bin/bash', '/run/sealant-operation'], {
    'PATH': '/usr/local/bin:/nix/var/nix/profiles/default/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    'HOME': '/root', 'LANG': 'C.UTF-8', 'NEEDRESTART_MODE': 'l',
})
