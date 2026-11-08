import json
import os
import signal
import subprocess
import sys


def retain_namespaces(argv, environment):
    """PID1 retains volatile mounts after the daemon exits, until the outside owner exports them."""
    signal.signal(signal.SIGTERM, lambda *_: None)
    daemon = subprocess.Popen(argv, env=environment)
    result = daemon.wait()
    print(json.dumps({'format': 'sealant-daemon-exit-v1', 'exit_code': result}), flush=True)
    # Only the outer cgroup owner can discharge this holder. A daemon exit is not durable custody.
    while True:
        try:
            os.waitpid(-1, 0)
        except ChildProcessError:
            signal.pause()


def main():
    if os.getpid() != 1:
        raise SystemExit('mapped entry requires PID1')
    if open('/proc/self/uid_map').read().split() != ['0', '131072', '65536']:
        raise SystemExit('mapped authority mismatch')
    print("sealant-native-gate-ready", flush=True)
    operation = json.loads(sys.stdin.buffer.readline(4096))
    if operation in ({'mode': 'workspace'}, {'mode': 'recovery'}):
        launch = json.load(open('/run/sealant-inputs/launch'))
        if launch.get('format') != 'sealant-daemon-launch-v1':
            raise SystemExit('invalid-daemon-launch')
        arguments = ['/usr/local/bin/sealantd', 'boot',
                     *(['--recovery'] if operation['mode'] == 'recovery' else [])]
        environment = {
            **launch['boot_env'], 'PATH': '/usr/local/bin:/nix/var/nix/profiles/default/bin:/usr/sbin:/usr/bin:/sbin:/bin',
            'HOME': '/root', 'LANG': 'C.UTF-8',
            'SEALANT_CONTROL_SOCKET': '/run/sealant/control.sock',
        }
        if operation['mode'] == 'workspace':
            retain_namespaces(arguments, environment)
        os.execve(arguments[0], arguments, environment)
    if operation not in ({'mode': 'build'}, {'mode': 'probe'}):
        raise SystemExit('ordinary admission unavailable')
    os.execve('/bin/bash', ['/bin/bash', '/run/sealant-operation'], {
        'PATH': '/usr/local/bin:/nix/var/nix/profiles/default/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        'HOME': '/root', 'LANG': 'C.UTF-8', 'NEEDRESTART_MODE': 'l',
    })


if __name__ == "__main__":
    main()
