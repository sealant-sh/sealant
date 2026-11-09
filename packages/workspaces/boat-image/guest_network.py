"""Outer-owned workspace networking. Setup is never an execution permit."""
import base64
from dataclasses import asdict, dataclass, field
import fcntl
import ipaddress
import json
import os
from pathlib import Path
import re
import subprocess

import guest_boot as guest
from guest_contract import canonical, digest

NAME = 'sealant-workspace'
NAMESPACE = Path('/run/netns') / NAME
OUTSIDE = 'sealant-out'
INSIDE = 'egress0'
WIRE = 'wg0'
OUTER_WIRE = 'sealant-wire'
GATEWAY = '100.127.255.253'
CLIENT = '100.127.255.254'
UPLINK = '169.254.241.1'
ADDRESS = '169.254.241.2'
TABLE = 'sealant_workspace'
DENIED = ('0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8',
          '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24',
          '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24',
          '224.0.0.0/4', '240.0.0.0/4')


class Refusal(ValueError):
    pass


@dataclass(frozen=True)
class PrivateKey:
    value: str = field(repr=False)

    def __repr__(self):
        return '<redacted>'


def key(value):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9+/]{43}=', value):
        raise Refusal('invalid-network-key')
    raw = base64.b64decode(value, validate=True)
    if raw == b'\0' * 32 or base64.b64encode(raw).decode() != value:
        raise Refusal('invalid-network-key')
    return value


def parse(value):
    fields = {'format', 'binding', 'private_key', 'public_key', 'gateway_key', 'endpoint', 'port', 'subnet'}
    if not isinstance(value, dict) or set(value) != fields or value['format'] != 'sealant-guest-network-v1':
        raise Refusal('invalid-network-config')
    for name in ('private_key', 'public_key', 'gateway_key'):
        key(value[name])
    endpoint = ipaddress.IPv4Address(value['endpoint'])
    subnet = ipaddress.IPv4Network(value['subnet'], strict=True)
    private = ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16')
    if (endpoint.is_unspecified or endpoint.is_loopback or endpoint.is_multicast or endpoint.is_link_local
            or subnet.prefixlen != 27 or not any(subnet.subnet_of(ipaddress.ip_network(parent)) for parent in private)
            or type(value['port']) is not int or not 1 <= value['port'] <= 65535):
        raise Refusal('invalid-network-destination')
    return {**value, 'private_key': PrivateKey(value['private_key']), 'endpoint': str(endpoint), 'subnet': str(subnet)}


def public(config):
    return {name: value for name, value in config.items() if name != 'private_key'}


def command(program, *args, inside=False, data=None, pass_fds=()):
    argv = guest.invoke(program, *args)
    if inside:
        argv = guest.invoke('/usr/bin/nsenter', '--net=' + str(NAMESPACE), '--', *argv)
    result = subprocess.run(argv, input=data, capture_output=True, timeout=5, env=guest.ENV, pass_fds=pass_fds)
    if result.returncode:
        # Subprocess errors, config and argv must never escape with key material.
        raise Refusal('network-command-refused')
    return result.stdout.decode().strip()


def ip(*args, inside=False):
    return command('/usr/sbin/ip', *args, inside=inside)


def nft(script, inside=False):
    return command('/usr/sbin/nft', '-f', '-', inside=inside, data=script.encode())


def rules(config, local_addresses):
    denied = ', '.join((*DENIED, config['endpoint'] + '/32'))
    local = ', '.join(sorted(set([config['endpoint'], *local_addresses])))
    return f'''table inet {TABLE} {{
 chain input {{ type filter hook input priority -10; policy drop;
  iifname "lo" accept
  ct state established,related accept
 }}
 chain forward {{ type filter hook forward priority -10; policy drop; }}
 chain output {{ type filter hook output priority -10; policy drop;
  oifname "lo" accept
  meta nfproto ipv6 drop
  oifname "{WIRE}" ip daddr {{ {local} }} drop
  oifname "{WIRE}" ip daddr {GATEWAY} meta l4proto {{ tcp, udp }} th dport 53 accept
  oifname "{WIRE}" ip daddr {config['subnet']} accept
  oifname "{INSIDE}" ip daddr {{ {denied} }} drop
  oifname "{INSIDE}" accept
 }}
}}'''


def outer_rules(config):
    denied = ', '.join((*DENIED, config['endpoint'] + '/32'))
    return f'''table inet {TABLE} {{
 chain input {{ type filter hook input priority -10; policy accept;
  iifname "{OUTSIDE}" drop
 }}
 chain forward {{ type filter hook forward priority -10; policy accept;
  iifname "{OUTSIDE}" ip saddr != {ADDRESS} drop
  iifname "{OUTSIDE}" ip daddr {{ {denied} }} drop
  iifname "{OUTSIDE}" meta nfproto ipv6 drop
  oifname "{OUTSIDE}" ct state established,related accept
  oifname "{OUTSIDE}" drop
 }}
}}
table ip {TABLE} {{
 chain postrouting {{ type nat hook postrouting priority srcnat; policy accept;
  ip saddr {ADDRESS} masquerade
 }}
}}'''


def namespace_identity():
    descriptor = os.open(NAMESPACE, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        owner = fcntl.ioctl(descriptor, 0xB701)  # NS_GET_USERNS
        try:
            if os.fstat(owner).st_ino != Path('/proc/self/ns/user').stat().st_ino:
                raise Refusal('network-namespace-owner-changed')
        finally:
            os.close(owner)
        info = os.fstat(descriptor)
        if info.st_ino == Path('/proc/self/ns/net').stat().st_ino:
            raise Refusal('network-namespace-not-isolated')
        return {'device': info.st_dev, 'inode': info.st_ino}
    finally:
        os.close(descriptor)


def firewall(inside=False):
    result = []
    for family in (('inet', 'ip') if not inside else ('inet',)):
        raw = json.loads(command('/usr/sbin/nft', '-j', 'list', 'table', family, TABLE, inside=inside))
        result.extend(entry for entry in raw['nftables'] if 'metainfo' not in entry)
    # Handles are identifiers, not policy, and nft assigns them at insertion time.
    def stable(value):
        if isinstance(value, dict):
            return {key: stable(item) for key, item in value.items() if key != 'handle'}
        if isinstance(value, list):
            return [stable(item) for item in value]
        return value
    return stable(result)


def outer_addresses():
    return sorted({address['local'] for item in json.loads(ip('-j', '-4', 'address', 'show'))
                   if item['ifname'] != OUTSIDE for address in item['addr_info']})


def inspect(config):
    namespace = namespace_identity()
    for name, expected in (('public-key', config['public_key']), ('peers', config['gateway_key']),
                           ('allowed-ips', config['gateway_key'] + '\t' + config['subnet'] + ' ' + GATEWAY + '/32'),
                           ('endpoints', config['gateway_key'] + '\t' + config['endpoint'] + ':' + str(config['port']))):
        actual = command('/usr/bin/wg', 'show', WIRE, name, inside=True)
        if name == 'allowed-ips':
            if actual.split()[:1] != [config['gateway_key']] or set(actual.split()[1:]) != {config['subnet'], GATEWAY + '/32'}:
                raise Refusal('network-peer-changed')
        elif actual != expected:
            raise Refusal('network-peer-changed')
    links = json.loads(ip('-j', 'link', 'show', inside=True))
    if {link['ifname'] for link in links} != {'lo', INSIDE, WIRE} or any('UP' not in link['flags'] for link in links):
        raise Refusal('network-links-changed')
    addresses = json.loads(ip('-j', '-4', 'address', 'show', inside=True))
    measured = {(item['ifname'], address['local'], address['prefixlen']) for item in addresses for address in item['addr_info']}
    if measured != {('lo', '127.0.0.1', 8), (INSIDE, ADDRESS, 30), (WIRE, CLIENT, 32)}:
        raise Refusal('network-addresses-changed')
    disabled = command('/usr/bin/cat', '/proc/sys/net/ipv6/conf/all/disable_ipv6', inside=True)
    if disabled != '1' or Path('/proc/sys/net/ipv4/ip_forward').read_text().strip() != '1':
        raise Refusal('network-forwarding-changed')
    routes = json.loads(ip('-j', '-4', 'route', 'show', 'table', 'all', inside=True))
    outer = json.loads(ip('-j', 'link', 'show', 'dev', OUTSIDE))[0]
    resolver = guest.file_identity(resolver_path(), digest(resolver_bytes()))
    if (resolver.uid, resolver.gid, resolver.mode) != (0, 0, 0o644):
        raise Refusal('network-resolver-changed')
    return {'namespace': namespace, 'routes': routes, 'links': links, 'addresses': addresses,
            'outer_link': outer, 'outer_addresses': outer_addresses(), 'firewall': firewall(True), 'outer_firewall': firewall(), 'resolver': asdict(resolver)}


def record_path():
    return guest.ROOT / 'network.json'


def resolver_path():
    return guest.ROOT / 'network-resolv.conf'


def resolver_bytes():
    return ('nameserver ' + GATEWAY + '\noptions timeout:2 attempts:2\n').encode()


def prepare(config):
    # Names are reserved before any kernel side effect. An uncertain partial setup holds them.
    if NAMESPACE.exists() or any(Path('/sys/class/net', name).exists() for name in (OUTSIDE, OUTER_WIRE)):
        raise Refusal('network-name-already-present')
    ip('netns', 'add', NAME)
    ip('link', 'add', OUTSIDE, 'type', 'veth', 'peer', 'name', INSIDE)
    ip('link', 'set', INSIDE, 'netns', NAME)
    # Boat owns an outer wg0 already. Only our reserved name is created or moved;
    # the workspace's wg0 lives exclusively inside the fresh namespace.
    ip('link', 'add', OUTER_WIRE, 'type', 'wireguard')
    # The UDP socket stays in the outer namespace, out of reach of inner root.
    descriptor = os.memfd_create('sealant-wireguard', os.MFD_CLOEXEC)
    try:
        os.write(descriptor, (config['private_key'].value + '\n').encode())
        os.lseek(descriptor, 0, os.SEEK_SET)
        command('/usr/bin/wg', 'set', OUTER_WIRE, 'private-key', '/proc/self/fd/' + str(descriptor),
                'peer', config['gateway_key'], 'endpoint', config['endpoint'] + ':' + str(config['port']),
                'allowed-ips', config['subnet'] + ',' + GATEWAY + '/32', 'persistent-keepalive', '25', pass_fds=(descriptor,))
    finally:
        os.close(descriptor)
    ip('link', 'set', OUTER_WIRE, 'netns', NAME)
    ip('link', 'set', OUTER_WIRE, 'name', WIRE, inside=True)
    command('/usr/sbin/sysctl', '-q', '-w', 'net.ipv6.conf.all.disable_ipv6=1', 'net.ipv6.conf.default.disable_ipv6=1', inside=True)
    nft(rules(config, outer_addresses()), inside=True)
    nft(outer_rules(config))
    ip('address', 'add', UPLINK + '/30', 'dev', OUTSIDE)
    ip('address', 'add', ADDRESS + '/30', 'dev', INSIDE, inside=True)
    ip('address', 'add', CLIENT + '/32', 'dev', WIRE, inside=True)
    command('/usr/sbin/sysctl', '-q', '-w', 'net.ipv4.ip_forward=1')
    ip('link', 'set', OUTSIDE, 'up')
    for name in ('lo', INSIDE, WIRE):
        ip('link', 'set', name, 'up', inside=True)
    ip('link', 'set', WIRE, 'mtu', '1380', inside=True)
    ip('route', 'add', config['subnet'], 'dev', WIRE, inside=True)
    ip('route', 'add', GATEWAY + '/32', 'dev', WIRE, inside=True)
    ip('route', 'add', 'default', 'via', UPLINK, 'dev', INSIDE, inside=True)
    descriptor = os.open(resolver_path(), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
    with os.fdopen(descriptor, 'wb') as stream:
        os.fchmod(stream.fileno(), 0o644)
        stream.write(resolver_bytes())
        stream.flush()
        os.fsync(stream.fileno())


def configure(value, binding):
    config = parse(value)
    if canonical(config['binding']) != canonical(binding):
        raise Refusal('network-binding-conflict')
    measured = command('/usr/bin/wg', 'pubkey', data=(config['private_key'].value + '\n').encode())
    if measured != config['public_key'] or measured == config['gateway_key']:
        raise Refusal('network-key-conflict')
    if record_path().exists():
        record = guest.private_json(record_path())
        if record.get('config') != public(config):
            raise Refusal('network-binding-conflict')
        verify(binding)
    else:
        guest.save(record_path(), {'format': 'sealant-network-state-v1', 'status': 'preparing', 'config': public(config)}, exclusive=True)
        prepare(config)
        observation = inspect(config)
        guest.save(record_path(), {'format': 'sealant-network-state-v1', 'status': 'configured',
                                  'config': public(config), 'observation': observation})
    return {'format': 'sealant-guest-network-status-v1', 'binding': binding, 'receipt': digest(record_path().read_bytes()),
            'configured': True, 'handshake': 'unverified', 'admission': 'held'}


def verify(binding, pid=None):
    record = guest.private_json(record_path())
    if (record.get('format') != 'sealant-network-state-v1' or record.get('status') != 'configured'
            or record['config']['binding'] != binding or record['config']['binding']['boot_id'] != guest.boot_id()):
        raise Refusal('network-setup-unresolved')
    if inspect(record['config']) != record['observation']:
        raise Refusal('network-state-changed')
    if pid is not None:
        info = Path('/proc', str(pid), 'ns/net').stat()
        if {'device': info.st_dev, 'inode': info.st_ino} != record['observation']['namespace']:
            raise Refusal('workspace-network-namespace-changed')
    return record
