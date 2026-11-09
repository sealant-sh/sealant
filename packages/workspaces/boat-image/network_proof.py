"""Required Docker/kernel proof. No skips, provider access or host networking mutations."""
import json
import os
from pathlib import Path
import subprocess
import unittest
import uuid


class NetworkProof(unittest.TestCase):
    def docker(self, *args, data=None):
        result = subprocess.run(['docker', *args], input=None if data is None else json.dumps(data),
                                capture_output=True, text=True, timeout=45)
        if result.returncode:
            raise AssertionError('owned Docker command failed: ' + result.stderr[-1200:])
        return result.stdout.strip()

    def execute(self, container, script, data=None):
        return json.loads(self.docker('exec', '-i', container, 'python3', '-B', '-c', script, data=data))

    def setUp(self):
        self.names = []
        self.networks = []
        self.prefix = 'sealant-network-proof-' + uuid.uuid4().hex[:12]
        self.addCleanup(self.cleanup)
        self.guest_image = Path(os.environ['SEALANT_BOAT_GUEST_TEST_IMAGE_FILE']).read_text().strip()
        self.gateway_image = Path(os.environ['SEALANT_BOAT_TUNNEL_TEST_IMAGE_FILE']).read_text().strip()
        # Pick unused private and publicly addressed bridges. These exist only in Docker.
        used = [json.loads(self.docker('network', 'inspect', name))[0] for name in self.docker('network', 'ls', '-q').splitlines()]
        import ipaddress
        networks = [ipaddress.ip_network(entry['Subnet']) for item in used for entry in (item['IPAM']['Config'] or []) if 'Subnet' in entry]
        self.subnet = next('10.251.' + str(index) + '.0/27' for index in range(1, 250)
                           if not any(ipaddress.ip_network('10.251.' + str(index) + '.0/27').overlaps(net) for net in networks if net.version == 4))
        self.public = next('192.0.' + str(index) + '.0/24' for index in range(10, 250)
                           if not any(ipaddress.ip_network('192.0.' + str(index) + '.0/24').overlaps(net) for net in networks if net.version == 4))
        self.base = self.subnet.removesuffix('0/27')
        self.public_base = self.public.removesuffix('0/24')
        for suffix, subnet in (('reach', self.subnet), ('public', self.public)):
            name = self.prefix + '-' + suffix
            self.docker('network', 'create', '--subnet', subnet, name)
            self.networks.append(name)
        self.guest = self.prefix + '-guest'
        self.gateway = self.prefix + '-gateway'
        for name in (self.guest, self.gateway):
            self.names.append(name)
        try:
            self.docker('run', '-d', '--name', self.guest, '--privileged', '--cgroupns', 'private', '--network', self.networks[0],
                        '--ip', self.base + '4', self.guest_image)
            self.docker('exec', self.guest, 'ip', 'link', 'add', 'preflight', 'type', 'wireguard')
            self.docker('exec', self.guest, 'ip', 'link', 'delete', 'preflight')
            self.docker('exec', self.guest, 'unshare', '-Ur', 'true')
        except AssertionError as error:
            raise AssertionError('Guest proof requires Docker privileged network namespaces, user namespaces and kernel WireGuard') from error
        self.docker('network', 'connect', self.networks[1], self.guest)
        self.docker('run', '-d', '--name', self.gateway, '--cap-drop', 'ALL', '--cap-add', 'NET_ADMIN',
                    '--sysctl', 'net.ipv4.ip_forward=1', '--sysctl', 'net.ipv6.conf.all.disable_ipv6=1',
                    '--network', self.networks[0], '--ip', self.base + '2', self.gateway_image)
        self.keys = self.execute(self.guest, '''import json, subprocess
pairs=[]
for _ in range(3):
 private=subprocess.check_output(['wg','genkey']).strip()
 pairs.append({'private':private.decode(),'public':subprocess.check_output(['wg','pubkey'],input=private).decode().strip()})
print(json.dumps(pairs))''')
        gateway = {'format': 'sealant-resource-tunnel-v1', 'binding': 'a' * 64,
                   'privateKey': self.keys[0]['private'], 'publicKey': self.keys[0]['public'], 'peerKey': self.keys[1]['public'],
                   'subnet': self.subnet, 'bridge': self.base + '1'}
        self.execute(self.gateway, "import sys,json;sys.path.insert(0,'/usr/local/lib/sealant');import gateway;print(json.dumps(gateway.configure(json.load(sys.stdin))))", gateway)
        self.binding = {'identity': {'deployment_id': 'local', 'instance_id': 'bx_test', 'disk_lineage': 'disk'},
                        'boot_id': self.docker('exec', self.guest, 'cat', '/proc/sys/kernel/random/boot_id'), 'epoch': 1, 'operation_id': 'launch'}
        self.config = {'format': 'sealant-guest-network-v1', 'binding': self.binding, 'private_key': self.keys[1]['private'],
                       'public_key': self.keys[1]['public'], 'gateway_key': self.keys[0]['public'],
                       'endpoint': self.base + '2', 'port': 51820, 'subnet': self.subnet}
        self.configure_script = '''import json,sys,guest_network as n
c=json.load(sys.stdin)
try: print(json.dumps(n.configure(c,c['binding'])))
except Exception as e: print(json.dumps({'error':type(e).__name__+':'+str(e)}))'''

    def cleanup(self):
        for name in reversed(self.names):
            result = subprocess.run(['docker', 'container', 'inspect', name], capture_output=True)
            if not result.returncode:
                self.docker('rm', '-f', name)
            self.assertNotEqual(subprocess.run(['docker', 'container', 'inspect', name], capture_output=True).returncode, 0)
        for name in reversed(self.networks):
            self.docker('network', 'rm', name)
            self.assertNotEqual(subprocess.run(['docker', 'network', 'inspect', name], capture_output=True).returncode, 0)
        print(json.dumps({'ownedContainersAbsent': self.names, 'ownedNetworksAbsent': self.networks}))

    def service(self, suffix, network, address, message):
        name = self.prefix + '-' + suffix
        self.names.append(name)
        script = "import socket; s=socket.socket(); s.bind(('0.0.0.0',31000)); s.listen();\nwhile True:\n c,_=s.accept(); c.sendall(b'" + message + "'); c.close()"
        self.docker('run', '-d', '--name', name, '--network', network, '--ip', address,
                    '--entrypoint', 'python3', self.guest_image, '-B', '-c', script)

    def query(self, host, port=31000, dns=False):
        return self.execute(self.guest, '''import json,sys,subprocess,guest_boot as g,guest_network as n
c=json.load(sys.stdin)
script=r"""import json,socket,struct
try:
 s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM if DNS=='udp' else socket.SOCK_STREAM);s.settimeout(1);s.connect((HOST,PORT))
 if DNS:
  q=struct.pack('!HHHHHH',123,0x100,1,0,0,0)+b'\\x07sealant\\x07gateway\\x07invalid\\0'+struct.pack('!HH',1,1)
  s.sendall(q if DNS=='udp' else struct.pack('!H',len(q))+q)
  if DNS=='tcp':
   def exact(size):
    data=b''
    while len(data)<size:
     part=s.recv(size-len(data))
     if not part: raise OSError()
     data+=part
    return data
   result=exact(struct.unpack('!H',exact(2))[0])
  else: result=s.recv(1024)
 else: result=s.recv(1024)
 print(json.dumps({'result':socket.inet_ntoa(result[-4:]) if DNS else result.decode()}))
except OSError: print(json.dumps({'result':'denied'}))
""".replace('DNS',repr(c['dns'])).replace('HOST',repr(c['host'])).replace('PORT',str(c['port']))
print(n.command('/usr/bin/python3','-B','-c',script,inside=True))''', {'host': host, 'port': port, 'dns': dns})['result']

    def test_encrypted_peer_egress_denials_replay_and_drift(self):
        self.service('resource', self.networks[0], self.base + '3', 'resource')
        self.service('public', self.networks[1], self.public_base + '3', 'public')
        self.docker('exec', self.guest, 'ip', 'address', 'add', '169.254.169.254/32', 'dev', 'lo')
        self.execute(self.guest, r'''import json,socket,subprocess
s=socket.socket();s.bind(('0.0.0.0',31000));s.listen()
script="import socket; s=socket.socket(fileno="+str(s.fileno())+");\nwhile True:\n c,_=s.accept(); c.sendall(b'outer'); c.close()"
subprocess.Popen(['python3','-B','-c',script],pass_fds=[s.fileno()],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
print('{}')''')
        for host in (self.base + '4', '169.254.169.254'):
            self.assertEqual(self.execute(self.guest, "import json,socket,sys;c=json.load(sys.stdin);s=socket.create_connection((c,31000),timeout=1);print(json.dumps(s.recv(32).decode()))", host), 'outer')
        first = self.execute(self.guest, self.configure_script, self.config)
        self.assertNotIn('error', first, first)
        self.assertEqual(first['admission'], 'held')
        self.assertEqual(first['handshake'], 'unverified')
        proof = self.execute(self.guest, "import json,sys,guest_readiness as r;print(json.dumps(r.peer(json.load(sys.stdin))))", self.binding)
        self.assertEqual(proof['dns'], 'udp-and-tcp')
        self.assertEqual(len(proof['nonce']), 32)
        self.assertEqual(self.execute(self.guest, self.configure_script, self.config), first)
        self.assertEqual(self.query(self.base + '3'), 'resource')
        for transport in ('udp', 'tcp'):
            self.assertEqual(self.query('100.127.255.253', 53, transport), '100.127.255.253')
        self.assertEqual(self.query(self.public_base + '3'), 'public')
        for host in (self.base + '1', self.base + '2', self.base + '4', '169.254.169.254', '10.0.0.41', '100.100.100.100'):
            self.assertEqual(self.query(host), 'denied', host)
        self.assertEqual(self.execute(self.guest, '''import json,guest_network as n,subprocess,guest_boot as g
commands=[['/usr/sbin/ip','route','flush','table','main'],['/usr/sbin/nft','flush','ruleset'],['/usr/sbin/ip','link','delete','wg0'],['python3','-c',"open('/proc/sys/net/ipv6/conf/all/disable_ipv6','w').write('0')"]]
results=[]
for command in commands:
 p=subprocess.run(g.invoke('/usr/bin/nsenter','--net='+str(n.NAMESPACE),'--','setpriv','--reuid=131072','--regid=131072','--clear-groups','unshare','-Ur','--',*command),capture_output=True)
 results.append(p.returncode!=0)
print(json.dumps(results))'''), [True] * 4)
        self.prove_mapped_gate()
        self.assertEqual(self.execute(self.guest, self.configure_script, self.config), first)
        wrong = {**self.config, 'private_key': self.keys[2]['private'], 'public_key': self.keys[2]['public']}
        self.assertIn('network-binding-conflict', self.execute(self.guest, self.configure_script, wrong)['error'])
        self.assertNotIn(self.config['private_key'], self.docker('exec', self.guest, 'cat', '/var/lib/sealant/guest/network.json'))
        self.assertEqual(self.docker('exec', self.guest, 'test', '!', '-e', '/run/sealant-bootstrap/execution-permit.json'), '')
        self.docker('exec', self.gateway, 'wg', 'set', 'wg0', 'peer', self.keys[1]['public'], 'remove')
        self.assertEqual(self.query(self.base + '3'), 'denied')
        # A changed live policy refuses adoption rather than applying setup again.
        self.docker('exec', self.guest, 'ip', 'netns', 'exec', 'sealant-workspace', 'nft', 'flush', 'ruleset')
        self.assertIn('error', self.execute(self.guest, self.configure_script, self.config))

    def prove_mapped_gate(self):
        result = self.execute(self.guest, r'''import json,os,select,subprocess,guest_boot as g,guest_network as n
from pathlib import Path
root=g.MAPPED_ROOT
root.mkdir(mode=0o755)
for name in ('usr','etc','var','run','tmp','proc','sys','dev'):
 (root/name).mkdir(mode=0o755)
(root/'etc/os-release').write_text('ID=ubuntu\n')
(g.ROOT/'sealantd').write_bytes(b'not-executed')
script=g.ROOT/'launch-fixture';script.mkdir();(script/'launch').write_text('{}')
child=subprocess.Popen(g.mapped_argv('workspace',script/'launch'),stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env={**os.environ,'SYSTEMD_NSPAWN_UNIFIED_HIERARCHY':'1'})
try:
 if not select.select([child.stdout],[],[],5)[0]: raise ValueError('mapped-test-gate-timeout')
 line=child.stdout.readline()
 if line.strip()!=b'sealant-native-gate-ready':
  raise ValueError('mapped-test-gate-failed:'+child.stderr.read().decode()[-2000:])
 gates=[entry for entry in g.census()['processes'] if entry['uid_map'].split()==['0','131072','65536']]
 if len(gates)!=1: raise ValueError('mapped-test-gate-ambiguous')
 pid=gates[0]['identity']['pid']; binding=g.private_json(n.record_path())['config']['binding']
 n.verify(binding,pid)
 resolver=Path('/proc/'+str(pid)+'/root/etc/resolv.conf').read_bytes()
 if resolver!=n.resolver_bytes(): raise ValueError('mapped-test-resolver-mismatch')
 mounts=Path('/proc/'+str(pid)+'/mountinfo').read_text().splitlines()
 if not any(line.split()[4]=='/etc/resolv.conf' and 'ro' in line.split()[5].split(',') for line in mounts): raise ValueError('mapped-test-resolver-writable')
 info={'network':os.stat('/proc/'+str(pid)+'/ns/net').st_ino,'uidmap':gates[0]['uid_map']}
 child.stdin.write(b'{"mode":"invalid-test-mode"}\n');child.stdin.flush();child.stdin.close();child.stdin=None
 child.communicate(timeout=5)
 print(json.dumps(info))
finally:
 if child.poll() is None: child.kill();child.wait(timeout=5)
''')
        self.assertEqual(result['uidmap'].split(), ['0', '131072', '65536'])

    def test_receiver_isolation_preserves_provider_wireguard(self):
        # Boat's restored guest has its own outer wg0. An empty Docker netns missed this.
        self.docker('exec', self.guest, 'ip', 'link', 'add', 'wg0', 'type', 'wireguard')
        self.docker('exec', self.guest, 'ip', 'address', 'add', '10.248.0.1/32', 'dev', 'wg0')
        self.docker('exec', self.guest, 'ip', 'link', 'set', 'wg0', 'up')
        provider = self.docker('exec', self.guest, 'ip', '-j', 'address', 'show', 'dev', 'wg0')
        collision = self.execute(self.guest, "import json,subprocess,guest_boot as g;p=subprocess.run(g.invoke('/usr/sbin/ip','link','add','wg0','type','wireguard'),capture_output=True,text=True);print(json.dumps({'exit':p.returncode,'stderr':p.stderr}))")
        self.assertEqual(collision['exit'], 2)
        self.assertIn('File exists', collision['stderr'])
        print(json.dumps({'providerInterfaceCollision': collision}))
        result = self.execute(self.guest, r'''import http.client,json,socket,sys,threading
from unittest.mock import patch
import guest_boot as g, guest_receiver as r
c=json.load(sys.stdin); b=c['binding']
r.private_directory(r.RUNTIME)
import subprocess
subprocess.run(['mount','-t','tmpfs','-o','mode=0700','tmpfs',str(r.RUNTIME)],check=True)
g.save(r.RUNTIME/'control.json',{'boot_id':g.boot_id(),'token':'a'*64})
g.save(g.ROOT/'receiver.json',{'format':'sealant-receiver-v1','identity':b['identity'],
 'admission':{'status':'installed','epoch':b['epoch'],'operation_id':b['operation_id'],'boot_id':b['boot_id'],'digest':'a'*64}})
# The full-image receipt/held-process guard is proven separately. This fixture supplies
# its accepted result; HTTP authentication, binding, tmpfs and every network command are real.
with patch.object(g,'revalidate',return_value=(None,[],{})):
 server=r.UnixServer(str(r.RUNTIME/'test.sock'),r.Handler)
 thread=threading.Thread(target=server.serve_forever);thread.start()
 try:
  def request():
   client=http.client.HTTPConnection('localhost',timeout=10)
   client.sock=socket.socket(socket.AF_UNIX);client.sock.connect(str(r.RUNTIME/'test.sock'))
   try:
    client.request('POST','/sealant/bootstrap/isolate',json.dumps(c),
     {'Authorization':'Bearer '+'a'*64,'Content-Type':'application/json'})
    reply=client.getresponse();return {'status':reply.status,'body':json.loads(reply.read())}
   finally: client.close()
  first=request();second=request()
  print(json.dumps({'first':first,'second':second}))
 finally: server.shutdown();thread.join();server.server_close()
''', self.config)
        self.assertEqual(result['first']['status'], 200, result)
        self.assertEqual(result['first'], result['second'])
        self.assertTrue(result['first']['body']['configured'])
        self.assertEqual(self.docker('exec', self.guest, 'ip', '-j', 'address', 'show', 'dev', 'wg0'), provider)
        self.assertEqual(self.execute(self.guest, "import json,sys,guest_readiness as r;print(json.dumps(r.peer(json.load(sys.stdin))))", self.binding)['dns'], 'udp-and-tcp')
        self.assertEqual(self.query('100.127.255.253', 53, 'udp'), '100.127.255.253')

    def test_partial_setup_cannot_reissue(self):
        partial = self.execute(self.guest, '''import json,sys,guest_boot as g,guest_network as n
c=n.parse(json.load(sys.stdin));g.save(n.record_path(),{'format':'sealant-network-state-v1','status':'preparing','config':n.public(c)},exclusive=True)
print({})''', self.config)
        self.assertEqual(partial, {})
        self.assertIn('network-setup-unresolved', self.execute(self.guest, self.configure_script, self.config)['error'])
        self.assertEqual(self.docker('exec', self.guest, 'ip', 'netns', 'list'), '')

    def test_real_parking_writer_closure_and_volatile_hydration(self):
        self.docker('exec', self.guest, 'mount', '-o', 'remount,rw', '/sys/fs/cgroup')
        result = self.docker('exec', self.guest, 'python3', '-B', '/var/lib/sealant/guest/parking_kernel_proof.py')
        self.assertIn('real-cgroup-freeze-export-kill-hydrate', result)

    def test_replaced_namespace_cannot_adopt_or_recreate(self):
        self.assertNotIn('error', self.execute(self.guest, self.configure_script, self.config))
        original = self.docker('exec', self.guest, 'cat', '/var/lib/sealant/guest/network.json')
        self.docker('exec', self.guest, 'ip', 'netns', 'delete', 'sealant-workspace')
        self.docker('exec', self.guest, 'ip', 'netns', 'add', 'sealant-workspace')
        self.assertIn('error', self.execute(self.guest, self.configure_script, self.config))
        self.assertEqual(original, self.docker('exec', self.guest, 'cat', '/var/lib/sealant/guest/network.json'))


if __name__ == '__main__':
    unittest.main()
