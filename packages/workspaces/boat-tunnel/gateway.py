"""One WireGuard peer, one Docker reach network. No resource port is published."""
import base64
import fcntl
import ipaddress
import json
import os
from pathlib import Path
import re
import signal
import shlex
import socket
import struct
import subprocess
import sys
import time

ROOT = Path('/run/sealant-tunnel')
GATEWAY = '100.127.255.253'
CLIENT = '100.127.255.254'
TUNNEL = ipaddress.ip_network('100.127.255.252/30')
PORT = 51820


class Refusal(ValueError):
    pass


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'))


def key(value):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9+/]{43}=', value):
        raise Refusal('invalid-key')
    raw = base64.b64decode(value, validate=True)
    if len(raw) != 32 or raw == b'\0' * 32 or base64.b64encode(raw).decode() != value:
        raise Refusal('invalid-key')
    return value


def parse_config(value):
    if not isinstance(value, dict) or set(value) != {'format', 'binding', 'privateKey', 'publicKey', 'peerKey', 'subnet', 'bridge'}:
        raise Refusal('invalid-config')
    if value['format'] != 'sealant-resource-tunnel-v1' or not re.fullmatch(r'[a-f0-9]{64}', value['binding']):
        raise Refusal('invalid-binding')
    for name in ('privateKey', 'publicKey', 'peerKey'):
        key(value[name])
    network = ipaddress.ip_network(value['subnet'], strict=True)
    bridge = ipaddress.ip_address(value['bridge'])
    private = [ipaddress.ip_network(value) for value in ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16')]
    if (network.version != 4 or network.prefixlen != 27 or not any(network.subnet_of(parent) for parent in private if network.version == parent.version)
            or network.overlaps(TUNNEL) or bridge not in network.hosts()):
        raise Refusal('invalid-reach-network')
    return {**value, 'subnet': str(network), 'bridge': str(bridge)}


def public(config):
    return {name: value for name, value in config.items() if name != 'privateKey'}


def run(*args, data=None, pass_fds=()):
    result = subprocess.run(args, input=data, capture_output=True, timeout=5, pass_fds=pass_fds)
    if result.returncode:
        raise Refusal('gateway-command-refused')
    return result.stdout.decode().strip()


def interface(config):
    found = []
    network = ipaddress.ip_network(config['subnet'])
    for item in json.loads(run('ip', '-j', '-4', 'addr', 'show')):
        for address in item.get('addr_info', []):
            if ipaddress.ip_address(address['local']) in network:
                found.append((item['ifname'], address['local']))
    if len(found) != 1 or not re.fullmatch(r'[a-zA-Z0-9_-]{1,15}', found[0][0]):
        raise Refusal('reach-interface-unavailable')
    return found[0]


def rules(config, reach, local):
    chains = {
        'INPUT': ['-i lo -j ACCEPT', '-m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT',
                  '-p udp --dport 51820 -j ACCEPT',
                  f'-i wg0 -s {CLIENT}/32 -d {GATEWAY}/32 -p udp --dport 53 -j ACCEPT',
                  f'-i wg0 -s {CLIENT}/32 -d {GATEWAY}/32 -p tcp --dport 53 -j ACCEPT'],
        'OUTPUT': ['-o lo -j ACCEPT', '-m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT',
                   '-p udp --sport 51820 -j ACCEPT'],
        'FORWARD': [f'-i wg0 -d {config["bridge"]}/32 -j REJECT',
                    f'-i wg0 -d {local}/32 -j REJECT',
                    f'-i wg0 -o {reach} -s {CLIENT}/32 -d {config["subnet"]} -j ACCEPT',
                    f'-i {reach} -o wg0 -d {CLIENT}/32 -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT'],
    }
    return {chain: [entry.split() for entry in entries] for chain, entries in chains.items()}


def apply(config):
    reach, local = interface(config)
    # Keep the encrypted interface down until every boundary is in place, including retries.
    if Path('/sys/class/net/wg0').exists():
        run('ip', 'link', 'del', 'wg0')
    for chain in ('INPUT', 'OUTPUT', 'FORWARD'):
        run('iptables', '-w', '2', '-P', chain, 'DROP')
        run('iptables', '-w', '2', '-F', chain)
    # The key travels only in stdin and an anonymous descriptor, never argv, env or a disk file.
    descriptor = os.memfd_create('wireguard-private', os.MFD_CLOEXEC)
    try:
        os.write(descriptor, (config['privateKey'] + '\n').encode())
        os.lseek(descriptor, 0, os.SEEK_SET)
        measured = run('wg', 'pubkey', data=(config['privateKey'] + '\n').encode())
        if measured != config['publicKey'] or measured == config['peerKey']:
            raise Refusal('key-binding-conflict')
        if not Path('/sys/class/net/wg0').exists():
            run('ip', 'link', 'add', 'wg0', 'type', 'wireguard')
        run('wg', 'set', 'wg0', 'listen-port', str(PORT), 'private-key', '/proc/self/fd/' + str(descriptor),
            'peer', config['peerKey'], 'allowed-ips', CLIENT + '/32', pass_fds=(descriptor,))
    finally:
        os.close(descriptor)
    run('ip', 'address', 'replace', GATEWAY + '/30', 'dev', 'wg0')
    for chain, entries in rules(config, reach, local).items():
        for entry in entries:
            run('iptables', '-w', '2', '-A', chain, *entry)
    # Preserve Docker's embedded-DNS NAT rules. Own only this named POSTROUTING chain.
    existing = run('iptables', '-t', 'nat', '-S')
    if '-N SEALANT-TUNNEL' not in existing:
        run('iptables', '-w', '2', '-t', 'nat', '-N', 'SEALANT-TUNNEL')
    run('iptables', '-w', '2', '-t', 'nat', '-F', 'SEALANT-TUNNEL')
    if '-A POSTROUTING -j SEALANT-TUNNEL' not in existing:
        run('iptables', '-w', '2', '-t', 'nat', '-A', 'POSTROUTING', '-j', 'SEALANT-TUNNEL')
    run('iptables', '-w', '2', '-t', 'nat', '-A', 'SEALANT-TUNNEL', '-s', CLIENT + '/32',
        '-d', config['subnet'], '-o', reach, '-j', 'MASQUERADE')
    run('ip', 'link', 'set', 'wg0', 'mtu', '1380', 'up')


def check(config):
    reach, local = interface(config)
    if (run('wg', 'show', 'wg0', 'public-key') != config['publicKey']
            or run('wg', 'show', 'wg0', 'peers') != config['peerKey']
            or run('wg', 'show', 'wg0', 'allowed-ips').split() != [config['peerKey'], CLIENT + '/32']
            or run('wg', 'show', 'wg0', 'listen-port') != str(PORT)
            or Path('/proc/sys/net/ipv4/ip_forward').read_text().strip() != '1'
            or Path('/proc/sys/net/ipv6/conf/all/disable_ipv6').read_text().strip() != '1'):
        raise Refusal('gateway-policy-changed')
    for chain, entries in rules(config, reach, local).items():
        def normalized(tokens):
            result = []
            index = 0
            while index < len(tokens):
                if tokens[index:index + 2] in (['-m', 'udp'], ['-m', 'tcp'], ['--reject-with', 'icmp-port-unreachable']):
                    index += 2
                    continue
                if index > 0 and tokens[index - 1] == '--ctstate':
                    result.append(','.join(sorted(tokens[index].split(','))))
                else:
                    result.append(tokens[index])
                index += 1
            if len(result) % 2:
                raise Refusal('gateway-policy-changed')
            return sorted(zip(result[::2], result[1::2]))
        lines = run('iptables', '-S', chain).splitlines()
        observed = [normalized(shlex.split(line)) for line in lines[1:]]
        expected = [normalized(['-A', chain, *entry]) for entry in entries]
        if not lines or lines[0] != '-P ' + chain + ' DROP' or observed != expected:
            raise Refusal('gateway-policy-changed')
    run('iptables', '-t', 'nat', '-C', 'POSTROUTING', '-j', 'SEALANT-TUNNEL')
    if len(run('iptables', '-t', 'nat', '-S', 'SEALANT-TUNNEL').splitlines()) != 2:
        raise Refusal('gateway-policy-changed')
    run('iptables', '-t', 'nat', '-C', 'SEALANT-TUNNEL', '-s', CLIENT + '/32',
        '-d', config['subnet'], '-o', reach, '-j', 'MASQUERADE')


def configure(value):
    config = parse_config(value)
    saved = ROOT / 'ready.json'
    with (ROOT / 'lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if saved.exists():
            if json.loads(saved.read_text()) != public(config):
                raise Refusal('gateway-binding-conflict')
            check(config)
            return {'configured': True}
        apply(config)
        check(config)
        temporary = ROOT / 'pending.json'
        temporary.write_text(canonical(public(config)))
        os.replace(temporary, saved)
        return {'configured': True}


def dns_check():
    question = b'\x07sealant\x07gateway\x07invalid\0' + struct.pack('!HH', 1, 1)
    query = struct.pack('!HHHHHH', 123, 0x100, 1, 0, 0, 0) + question
    for kind in (socket.SOCK_DGRAM, socket.SOCK_STREAM):
        with socket.socket(socket.AF_INET, kind) as connection:
            connection.settimeout(1)
            connection.connect((GATEWAY, 53))
            connection.sendall(query if kind == socket.SOCK_DGRAM else struct.pack('!H', len(query)) + query)
            if kind == socket.SOCK_DGRAM:
                answer = connection.recv(4096)
            else:
                def exact(size):
                    data = b''
                    while len(data) < size:
                        part = connection.recv(size - len(data))
                        if not part:
                            raise Refusal('gateway-dns-unavailable')
                        data += part
                    return data
                answer = exact(struct.unpack('!H', exact(2))[0])
            if len(answer) < 12:
                raise Refusal('gateway-dns-unavailable')
            identity, flags, questions, answers, _, _ = struct.unpack('!HHHHHH', answer[:12])
            if identity != 123 or flags & 0x800f != 0x8000 or questions != 1 or answers != 1 or answer[-4:] != socket.inet_aton(GATEWAY):
                raise Refusal('gateway-dns-unavailable')


def status():
    value = json.loads((ROOT / 'ready.json').read_text())
    check(value)
    dns_check()
    return {'format': 'sealant-resource-gateway-status-v1', 'config': value,
            'gateway': GATEWAY, 'client': CLIENT, 'dns': 'udp-and-tcp', 'peerHandshake': 'unverified'}


def serve():
    ROOT.mkdir(mode=0o700, exist_ok=True)
    while not (ROOT / 'ready.json').exists():
        time.sleep(0.05)
    # No privilege-changing capabilities: stay root inside this restricted namespace.
    child = subprocess.Popen(['dnsmasq', '--no-daemon', '--no-resolv', '--no-hosts', '--cache-size=0',
                              '--bind-interfaces', '--interface=wg0', '--listen-address=' + GATEWAY,
                              '--server=127.0.0.11', '--address=/sealant.gateway.invalid/' + GATEWAY,
                              '--user=root', '--group=root', '--pid-file=', '--log-facility=-'])
    def stop(*_):
        child.terminate()
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    raise SystemExit(child.wait())


def main():
    os.umask(0o077)
    try:
        action = sys.argv[1]
        if action == 'serve':
            serve()
        elif action == 'configure':
            raw = sys.stdin.buffer.read(8193)
            if len(raw) > 8192:
                raise Refusal('oversized-config')
            print(canonical(configure(json.loads(raw))))
        elif action == 'status':
            print(canonical(status()))
        else:
            raise Refusal('unknown-operation')
    except Exception:
        # Never echo argv, stdin, subprocess stderr or a key in an error.
        print('{"error":"resource-gateway-unavailable"}')
        raise SystemExit(1)


if __name__ == '__main__':
    main()
