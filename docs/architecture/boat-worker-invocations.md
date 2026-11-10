# Boat worker exchange and launch ownership

Boat remains unregistered. This layer provides the executable worker exchange, the sealed launch
material and the launch owner (`BoatExecution`, `src/runtime/boat/execution.ts`). It does not
establish resource isolation, FINAL settlement, recovery, parking or an end-to-end Boat session.

`BoatExecution` uses the existing credential cipher and `BoatExecutionRepo`. The native publication
catalog continues to own reusable images.
[Allocation reconciliation](boat-allocation-reconciliation.md) supplies the reserved, verified
provider target and composes this service for the bind exchange. Ordinary runtime registration
remains disabled.

## Exchange

The database binds one run/runtime instance to its deployment, workspace, launch attempt, source,
sandbox, disk lineage, boot and agent manifest digest. Unique deployment/sandbox and deployment/disk
constraints prevent another run claiming that disk. Every read parses the stored representation;
every transition compares the complete previous record in one SQL statement. Network calls run
outside database transactions.

Before the bind command, the worker reserves a stable operation and seals its RSA-3072 private key.
The provider target must have every expected ownership label. The command is the
[guest agent's](boat-guest-agent.md) bind CLI with the public request as its one argument. The
worker checks the returned identity, boot, operation and compatible held result, decrypts the bearer
with the bound OAEP label, then proves it on `GET /sealant/health` (the agent answers the bearer
503, not booted). One commit stores purpose-bound encrypted control material (hosted origin, proxy
cookie, bearer) and removes the encrypted exchange key. A reply lost before that commit replays the
same public request. A bind refusal is typed (`agent-refused`, the CLI's reason code). The exchange
answers a binding receipt, a digest of the public bind, the same on every replay; the parking resume
records it as the rebind of a restored disk.

## Sealed launch material

What a launch is made of is sealed once, as the admission envelope: the boot environment, the secret
environment, the resolved credential-version and dotfiles pins, and whether the VM's own Docker is
required. A retry uses this envelope even if its caller supplies newer material. No credential or
archive resolver runs during replay. Nothing reaches the VM until the launch is pushed; the record
moves `control` to `installed` on sealing. The admission's epoch and operation bind the network
intent and the isolation receipts.

## Launch

Core pushes the sealed material as the agent's launch body (`POST /sealant/launch`), with the bearer
as the control token. The record is `issued` before the push and `running` after: an accepted push
or an adopted `409 already booted` (the agent recorded the launch on this boot before
`sealantd boot`; a push whose reply was lost is that launch). The secret-bearing launch envelope is
erased on `running`; the resume copy stays until Boat positively no longer has the VM. `hold` fences
`issued` and `running` alike: Core never pushes again, and the agent only ever adopts what it
recorded.

`running` means the agent accepted the launch. It does not prove the daemon is up, the tunnel shook
hands or FINAL custody; [authenticated readiness](boat-authenticated-readiness.md) owns those
observations.

## Verification

PostgreSQL tests cover lost replies, concurrent sealing, immutable target bindings, sealed context
swaps and secret-envelope settlement. `agent-transport.test.ts` runs this owner against the real
agent. These are local proofs; they do not replace a live launch.
