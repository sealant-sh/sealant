# Boat tunnel key and UDP custody

Boat remains unregistered. This layer supplies durable credentials for the host resource tunnel from
#462. The [resource reconciler](boat-resource-reconciliation.md) now consumes these credentials for
host and guest setup. It does not create an isolation permit, start the daemon or report readiness.
No live Boat session is needed to validate this layer.

`BoatTunnelCredentialsOwner.prepare` takes the exact authenticated execution target and a stable
operator-owned `gatewayHostId` for the physical Docker host. The execution must already have
exchanged its control token and must not be held. The repository checks the entire target against
the execution record. A changed host, boot, disk, publication or launch attempt cannot silently get
new keys. Future reconciliation must recheck the current execution and authorization immediately
before external I/O. Reserving custody is not admission authority.

## Ownership and replay

PostgreSQL reserves one UDP port in 61000–61511 per runtime instance (a reservation made by the
first allocator, in 40000–40015, stays valid until its run ends; that range is no longer handed
out). The unique host/port index spans deployments in that database. Deployments on the same
physical Docker host must use the same host identity and database; separate hosts may use the same
port. The identity must survive worker restarts and redeployments. This layer adds no environment
setting or ephemeral default for it. External port users are still the Docker gateway adapter's
responsibility; a bind failure cannot cause this owner to rotate the reservation.

One insert arbitrates the runtime and host/port constraints. A crash or encryption failure after
that insert leaves a reservation with no key material. Retrying uses its original port and
reservation ID. A random reservation-ID collision refuses rather than consuming another port. The
pool has 512 slots per host. Exhaustion returns `ports-exhausted` without replacing an existing
reservation.

After reserving the port, the owner generates separate X25519 gateway and guest key pairs. Both
private keys are encrypted together with the existing `CredentialCipher`, using
`SEALANT_CREDENTIALS_KEY`. The sealed plaintext binds its format, complete target, host identity,
reservation ID, port and both public keys. The database stores public keys and ciphertext only. A
compare-and-set installs one winning ciphertext. Concurrent callers and a caller that lost the
install reply adopt that persisted winner before returning any credentials.

Every preparation decrypts the persisted record, checks its complete context and derives each public
key from its private key. Swapped ciphertext, altered public keys or mismatched key pairs refuse.
Returned private keys are `Redacted` values; only the respective gateway or guest I/O owner may
unwrap them. Errors contain fixed codes without SQL, ciphertext or parser diagnostics. The
configured credential key must remain available across worker restarts, as for the existing sealed
execution records.

There is deliberately no expiry, release, rotation or rebinding API. Generic execution deletion is
blocked by a restricting foreign key. Even held executions keep their port and key obligation.
Canonical FINAL and cleanup must eventually prove both guest peer and host gateway removal before
releasing it. Until that layer lands, a claimed slot remains occupied indefinitely. This capacity
tradeoff is preferable to reusing a port while an old peer might still exist.

## Composition and validation

The repository owns SQL arbitration. The credential owner owns generation, sealing, validation and
redaction; neither concern belongs in the Docker gateway adapter. `boatTunnelCredentialsLayer`
provides its repository and leaves PostgreSQL and `CredentialCipher` to the worker composition root.
Its open assembly permits focused failure controls without replacing PostgreSQL.

Migrated PostgreSQL tests rebuild the production assembly, race same-run preparations and host ports
across deployments, fill the range to exercise exhaustion and separate hosts, retain partial custody
after sealing failure, adopt an already committed install and reject changed targets. They also
cover reservation-ID collisions, corrupt records, swapped ciphertext, mismatched keys, redacted
output and deletion protection. These are local custody proofs. The encrypted reach proof from #462
remains the gateway's responsibility.

Next, configure the guest network namespace and peer from these exact credentials, then integrate
worker/resource reconciliation and authenticated readiness. The first end-to-end session on VM 131
will need operator-approved tailnet join and Funnel on 443/8443/10000; the gateway's ports are
published on the relay host only and need no forwarding. This layer makes no box changes. FINAL
close and recovery remain later layers.
