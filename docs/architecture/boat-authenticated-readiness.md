# Boat authenticated readiness

Boat remains unregistered. This layer provides an explicit worker launch and readiness owner, with
admission still held. It does not publish a ready runtime row or start sessions from a scanner.
Canonical FINAL close and tunnel slot release in #465 remain admission blockers.

`BoatReadiness.launch` requires the current bound allocation and an active run. It stages the
original envelope, prepares current resource networking, freezes the guest and gateway receipts in
the execution record, delivers an authenticated current-epoch permit and starts the original
invocation. Each external boundary rechecks allocation authority. Lost replies retain the original
execution, keys and reservations. Existing receipt fields are additive JSON; no migration is needed.
A changed receipt cannot replace an issued permit.

The guest verifies the exact identity, boot, epoch, operation and guest network receipt before
writing its root-private tmpfs permit. Both workspace units run inside `sealant-workspace.slice`,
with 2 GiB memory, no swap, one CPU and 512 tasks. The receiver checks systemd properties and actual
cgroup-v2 limit files. A fresh unpredictable DNS question must return through both UDP and TCP over
the configured WireGuard peer, followed by an observation of its handshake. Configured networking
alone cannot grant a permit.

Readiness verifies the running owner, launcher and daemon inside that bounded slice. The worker
brackets real authenticated daemon health and capability requests with two receiver observations of
the same systemd invocation and permit. It rechecks allocation, execution and current resource
custody before returning. Resource preparation during observation may reconcile attachments, but
observation never stages, permits or starts execution. Changes during the observation refuse it.
Launch has a 120-second bound. Only uncertain transport/start observations retry, at most twenty
times at one-second intervals; they never issue a second invocation.

The hosted relay now connects through a bootstrap-owned control proxy. The proxy pins the recorded
daemon process, root, path components and Unix socket, and checks real Linux peer credentials. It
permits four forwarding connections, bounds writes and rechecks the held process while idle. The
socket path is fixed inside the owned mapped root. Neither callers nor environment payloads can
select an arbitrary outer socket. Active invocation replay validates shipped assets and recorded
processes instead of rerunning the held-boot test that intentionally refuses a running workspace.

## Local proof and live gate

Migrated PostgreSQL cases exercise frozen receipts, lost replies, changed bindings, stops during
permit delivery and readiness, gateway changes, and launch ordering. Python controls exercise permit
replay, cgroup-policy parsing and drift, peer requirements, process/root identity and real
Unix-socket peer credentials. The Docker/kernel proof uses the shipped peer probe over actual
WireGuard with fresh UDP/TCP DNS responses. A pinned real daemon and the actual relay prove the
production authenticated health/capability path and wrong-bearer refusal. CI requires that test. The
source-hidden worker packaging check includes both new modules and the slice.

These local proofs do not establish a complete restored Boat session, actual guest systemd slice
enforcement or the provider's HTTPS/WebSocket path. That end-to-end proof on VM 131 is pending
Yiannis's approval for the tailnet join, Funnel on 443/8443/10000 and host UDP DNAT on 40000-40015.
The preview VM budget is 8 GB. No provider allocation, credential read or box change occurs here.
The PR must remain unmerged until that live proof passes.

The 2026-11-06 guard decision remains intact: hash-gate shipped files only; ignore timestamps during
reads while retaining content, identity, ownership, mode, size and link checks; inspect only owned
processes and their shipped mappings; require a fresh current-boot clone binding. Base-image systemd
and PID 1 observations do not gate. The Ubuntu recipe keeps the systemd family at the base version.
FINAL close/recovery and executable parking follow. Parking retains a plain `sync` before stop as
hygiene.
