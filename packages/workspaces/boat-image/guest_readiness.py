"""Current-epoch isolation permits and authenticated readiness observations."""
import json
from pathlib import Path
import re

import guest_boot as guest
import guest_invocation as invocation
import guest_network as network
import guest_receiver as receiver
from guest_contract import canonical, digest

SLICE = 'sealant-workspace.slice'
CGROUP = Path('/sys/fs/cgroup')
LIMITS = {'memory_bytes': 2147483648, 'cpu_millicores': 1000, 'tasks': 512}

# Both transports must answer the unpredictable question over the encrypted interface.
DNS_PROBE = r'''
import json,secrets,socket,struct
nonce=secrets.token_hex(16)
question=bytes([len(nonce)])+nonce.encode()+b'\x07sealant\x07gateway\x07invalid\0'+struct.pack('!HH',1,1)
ident=secrets.randbelow(65536)
query=struct.pack('!HHHHHH',ident,0x100,1,0,0,0)+question
def exact(s,n):
 data=b''
 while len(data)<n:
  part=s.recv(n-len(data))
  if not part: raise ValueError('short-dns-response')
  data+=part
 return data
for kind in (socket.SOCK_DGRAM,socket.SOCK_STREAM):
 with socket.socket(socket.AF_INET,kind) as s:
  s.settimeout(2);s.connect(('100.127.255.253',53))
  s.sendall(query if kind==socket.SOCK_DGRAM else struct.pack('!H',len(query))+query)
  answer=s.recv(4096) if kind==socket.SOCK_DGRAM else exact(s,struct.unpack('!H',exact(s,2))[0])
  if len(answer)<12: raise ValueError('short-dns-response')
  i,flags,questions,answers,_,_=struct.unpack('!HHHHHH',answer[:12])
  if i!=ident or flags&0x800f!=0x8000 or questions!=1 or answers!=1 or answer[12:12+len(question)]!=question or answer[-4:]!=socket.inet_aton('100.127.255.253'):
   raise ValueError('invalid-dns-response')
print(json.dumps({'dns':'udp-and-tcp','nonce':nonce}))
'''


def limits():
    properties = dict(line.split('=', 1) for line in guest.run('/usr/bin/systemctl', 'show', SLICE,
                      '-p', 'ControlGroup', '-p', 'MemoryMax', '-p', 'MemorySwapMax', '-p', 'TasksMax', '-p', 'CPUQuotaPerSecUSec').splitlines())
    group = properties.get('ControlGroup', '')
    if (not group.startswith('/') or '..' in Path(group).parts or Path(group).name != SLICE
            or properties.get('MemoryMax') != str(LIMITS['memory_bytes'])
            or properties.get('TasksMax') != str(LIMITS['tasks'])
            or properties.get('MemorySwapMax') != '0'
            or properties.get('CPUQuotaPerSecUSec') != '1s'):
        raise receiver.Refusal('workspace-limits-unavailable')
    root = CGROUP / group.lstrip('/')
    quota, period = (root / 'cpu.max').read_text().split()
    if ((root / 'memory.max').read_text().strip() != str(LIMITS['memory_bytes'])
            or (root / 'pids.max').read_text().strip() != str(LIMITS['tasks'])
            or (root / 'memory.swap.max').read_text().strip() != '0'
            or not quota.isdecimal() or not period.isdecimal() or int(period) <= 0
            or int(quota) != int(period)):
        raise receiver.Refusal('workspace-kernel-limits-changed')
    return group


def peer(binding):
    record = network.verify(binding)
    result = json.loads(network.command('/usr/bin/python3', '-I', '-S', '-B', '-c', DNS_PROBE, inside=True))
    if (set(result) != {'dns', 'nonce'} or result['dns'] != 'udp-and-tcp'
            or not isinstance(result['nonce'], str) or not re.fullmatch('[a-f0-9]{32}', result['nonce'])):
        raise receiver.Refusal('tunnel-probe-unavailable')
    handshake = network.command('/usr/bin/wg', 'show', network.WIRE, 'latest-handshakes', inside=True).split()
    if len(handshake) != 2 or handshake[0] != record['config']['gateway_key'] or not handshake[1].isdecimal() or int(handshake[1]) <= 0:
        raise receiver.Refusal('tunnel-handshake-unavailable')
    network.verify(binding)
    return result


def permit_path():
    return receiver.RUNTIME / 'execution-permit.json'


def permit(value):
    receiver.fields(value, {'format', 'binding', 'resource_receipt', 'tunnel_receipt', 'limits'})
    expected = invocation.binding()
    if value['format'] != 'sealant-execution-permit-v2' or value['binding'] != expected or value['limits'] != LIMITS:
        raise receiver.Refusal('isolation-permit-binding-conflict')
    for key in ('resource_receipt', 'tunnel_receipt'):
        if not isinstance(value[key], str) or not re.fullmatch('[a-f0-9]{64}', value[key]):
            raise receiver.Refusal('invalid-isolation-receipt')
    receiver.require_tmpfs()
    if digest(network.record_path().read_bytes()) != value['resource_receipt']:
        raise receiver.Refusal('network-receipt-changed')
    if permit_path().exists() and guest.private_json(permit_path()) != value:
        raise receiver.Refusal('isolation-permit-conflict')
    if invocation.path().exists() and invocation.observe() not in ('issued', 'running'):
        raise receiver.Refusal('invocation-held')
    held = receiver.revalidate_execution()
    try:
        guest.run('/usr/bin/systemctl', 'start', SLICE)
        limits()
        proof = peer(expected)
        for process in held:
            process.verify()
        if not permit_path().exists():
            guest.save(permit_path(), value, exclusive=True)
        return {'format': 'sealant-execution-permitted-v1', 'binding': expected,
                'receipt': digest(canonical(value)), 'handshake': 'verified', 'dns': proof['dns'], 'admission': 'held'}
    finally:
        for process in held:
            process.close()


def verify_permit(binding):
    value = guest.private_json(permit_path())
    receiver.fields(value, {'format', 'binding', 'resource_receipt', 'tunnel_receipt', 'limits'})
    if (value['format'] != 'sealant-execution-permit-v2' or value['binding'] != binding or value['limits'] != LIMITS
            or digest(network.record_path().read_bytes()) != value['resource_receipt']):
        raise receiver.Refusal('isolation-permit-changed')
    limits()
    network.verify(binding)
    return value


def readiness(value):
    receiver.fields(value, {'format', 'binding', 'permit_receipt'})
    binding = invocation.binding()
    permit = verify_permit(binding)
    if (value['format'] != 'sealant-readiness-v1' or value['binding'] != binding
            or value['permit_receipt'] != digest(canonical(permit))):
        raise receiver.Refusal('readiness-binding-conflict')
    if invocation.observe() != 'running':
        raise receiver.Refusal('invocation-not-running')
    record = invocation.state()
    group = limits()
    for name in ('owner', 'launcher', 'gate'):
        identity = record[name]['process'] if name == 'owner' else record[name]
        if not identity['cgroup'].startswith('0::' + group + '/'):
            raise receiver.Refusal('workspace-outside-limits')
    proof = peer(binding)
    if invocation.observe() != 'running':
        raise receiver.Refusal('invocation-not-running')
    return {'format': 'sealant-readiness-status-v1', 'binding': binding, 'permit_receipt': value['permit_receipt'],
            'invocation': record['owner']['systemd_invocation'], 'handshake': 'verified',
            'dns': proof['dns'], 'limits': LIMITS, 'admission': 'held'}
