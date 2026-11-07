# Boat worker exchange and invocation ownership

Boat remains unregistered. This layer provides executable worker exchange and staging plus a
whole-daemon invocation owner. It does not establish resource isolation, a working control tunnel,
FINAL settlement, recovery, parking or an end-to-end Boat session.

`BoatExecution` uses the existing credential cipher and `BoatExecutionRepo`. The native publication
catalog continues to own reusable images.
[Allocation reconciliation](boat-allocation-reconciliation.md) now supplies the reserved, verified
provider target and composes this service for held bootstrap. Ordinary runtime registration remains
disabled.

## Exchange and delivery

The database binds one run/runtime instance to its deployment, workspace, launch attempt, source,
sandbox, disk lineage, boot and protected manifest. Unique deployment/sandbox and deployment/disk
constraints prevent another run claiming that disk. The foreign key prevents deletion of the run
from discarding ownership. Every read parses the stored representation; every transition compares
the complete previous record in one SQL statement. Network calls run outside database transactions.

Before the public bootstrap command, the worker reserves a stable operation and seals its RSA-3072
private key. The provider target must have every expected ownership label. The command contains only
the fixed bundled helper and public binding/key inputs. The worker checks the returned identity,
boot, operation and compatible held result, decrypts with the bound OAEP label, then proves the
bearer through authenticated hosted status. One commit stores purpose-bound encrypted control
material and removes the encrypted exchange key. A reply lost before that commit replays the same
public request. Concurrent randomized control commits may report a stale transition; redelivery
reads the winner.

The existing credential cipher authenticates an encrypted context containing the full target,
exchange ID and purpose. Admission also contains its epoch/operation. Decryption compares the
context before using any plaintext. Control cookies and bearers never become URL/query values or
logs. Hosted access refreshes before every delivery or adoption, without rerunning bootstrap.

Before staging, the worker seals the exact files and resolved credential-version and dotfiles pins.
Dotfiles pins must match an actual staged file hash. A retry uses this envelope even if its caller
supplies newer material. No credential or archive resolver runs during replay. The guest installs
the original manifest on private tmpfs and returns its exact epoch/operation. The database records
installation before issuing start. Secret-bearing envelopes are removed on running/held settlement;
uncertain delivery retains the envelope for bounded caller retries. Existing job claims own
scheduling.

## Whole invocation

The authenticated relay adds `POST /sealant/bootstrap/start`. Its request names exactly the accepted
identity, boot, epoch and operation, with format `sealant-invocation-start-v1`.

Start requires `/run/sealant-bootstrap/execution-permit.json`, root-private and bound to that same
identity, boot, epoch and operation. Its format is `sealant-execution-permit-v1`, with `binding`,
`resource_receipt` and `tunnel_receipt` fields. The latter two are SHA-256 receipt identities. No
production permit writer ships in this layer. They are an activation contract, not evidence that
resource or tunnel policy has been applied. The next layer must own validating those policies and
issuing the permit from current acknowledgements. A missing permit refuses before invocation intent.

The receiver revalidates held boot and persists `issued` before its single nonblocking systemd
start. An unknown start result never issues start again. The static workspace service has
`Restart=no`, no install target, and the permit condition. Its wrapper claims the issued receipt
with its systemd InvocationID and full process identity before copying launch material or running
setup. Any second service invocation refuses, including with fresh logical IDs or a changed boot.

The wrapper validates the staged manifest, copies only its files to a separate private tmpfs
directory owned by mapped root, and binds it read-only at `/run/sealant-inputs`. Original root-owned
staging remains intact for exact delivery replay. The required `launch` file is JSON with format
`sealant-daemon-launch-v1` and `boot_env`. File references in that environment use the fixed private
input directory. The mapped PID 1 executes only `/usr/local/bin/sealantd boot` after the existing
verified nspawn gate handshake. A protected daemon copy is bound read-only over that executable.
Workspace stdout streams to its supervisor rather than accumulating in memory. Build/probe execution
keeps its existing bounded behavior.

Before releasing the gate, the wrapper records launcher and gate identities. Adoption verifies the
same systemd invocation, wrapper, launcher and PID 1 start/root/namespace/cgroup identities, then
checks the running daemon's exact protected inode and bytes. A gate still waiting to exec reports
issued. Process loss, a deleted executable, a changed identity or an ended invocation holds the
disk. Normal invocation units cannot use the boot guard's automatic mapping restart. Canonical
recovery must authorize any later writer. There is no reset/close/rebind endpoint in this layer.

`running` proves adoption of the whole invocation. It does not prove setup completed, daemon health,
per-script exactly-once execution or FINAL custody. Those remain separate gates.

## Verification and remaining work

PostgreSQL tests cover lost replies, concurrent staging, immutable target bindings, sealed context
swaps and secret-envelope settlement. Guest tests exercise durable intent before start, lost-start
refusal, real local process adoption, changed systemd invocation and exit barriers. Relay and
builder tests check source and shipped assets. These are local proofs; they do not replace a live
native invocation or cold recovery proof.

The existing `BoatApi` remains the provider client, `BoatExecutionRepo` owns only atomic
persistence, and the guest owns systemd invocation receipts. A separate owner is necessary because
generic job claims cannot fence already-issued guest work, and the publication catalog must not own
run secrets or invocation state. The worker layer centralizes the encryption/delivery order so
callers cannot accidentally send a new payload under a retried operation.

Continue with isolation and tunnel enforcement, authenticated daemon readiness, FINAL
close/exclusion and held recovery, then executable parking. Parking will run plain `sync` before
stop as hygiene. The 2026-11-06 shipped-only guard, timestamp decision, fresh clone binding and held
base-systemd versions remain unchanged. No provider allocation or live proof is claimed for this PR.
