# Boat guest bootstrap and staging

Boat remains unregistered. This layer supplies an executable guest receiver for public bootstrap and
private file installation. It does not start sealantd, grant resource access, bridge a daemon
socket, close a writer, authorize recovery or implement parking.

## Ownership and calls

The packaged `guest_receiver.py` owns the immutable disk identity, accepted epoch and staged files.
It shares `guest.lock` with the held-boot checker. `guest_boot.py bind` is its public
provider-command entry point. The existing control relay forwards only two bootstrap routes to a
root-private Unix socket. It still uses its own bearer check, and the receiver checks that bearer
again. No endpoint runs a caller-supplied command. The packaged workspace service remains
`/bin/false`.

The caller must first verify the actual provider target, persist its operation and seal its RSA-3072
private exchange key. It invokes the pinned guest Python with `guest_boot.py bind` and one public
JSON argument, capped at 8192 characters:

```json
{
  "format": "sealant-bootstrap-v1",
  "identity": {
    "deployment_id": "deployment-id",
    "instance_id": "bx_exact-instance",
    "disk_lineage": "immutable-disk-id"
  },
  "boot_id": "current-provider-guest-boot-id",
  "manifest_digest": "exact-protected-manifest-sha256",
  "operation_id": "persisted-exchange-id",
  "public_key": "RSA-3072 SPKI PEM"
}
```

The reply contains only public identity, the held-boot result and the base64 OAEP ciphertext. Node's
standard crypto implementation encrypts the guest-generated bearer with RSA-OAEP-SHA256. The OAEP
label is the UTF-8 JSON array
`["sealant-bootstrap-v1", deployment_id, instance_id, disk_lineage, boot_id, operation_id, manifest_digest]`,
in that order with no whitespace. The same request re-encrypts the same bearer after a lost
response. A different key or operation during that boot refuses. Ciphertext alone is not proof of
the provider target's identity.

The worker-side sealed exchange owner and runtime adapter integration remain a subsequent layer.
They must decrypt only in memory, authenticate over refreshed provider-hosted HTTPS, seal the
control credential before admission, and clear the exchange key after commit. Bearer bytes must
never enter provider commands, argv, environment, stdout, diagnostics or the runtime endpoint.

## Held boot and publication

Reusable publications contain no receiver identity, credentials or enabled receiver services. An
approved, unbound boot waits held without beginning its compatibility inspection. Delivering its
current-boot binding starts the existing 60-second inspection with two-second intervals and three
stable observations. Existing current-boot inspection events always retain their deadline; removing
or replaying a binding cannot reset it. All shipped-only guard decisions remain intact.

A bound disk accepts only its original deployment, instance and disk lineage. A runtime snapshot
cannot be adopted as a new instance by this entry point. Authorized recovery rebind is deliberately
absent. Stale runtime credentials refuse rather than reactivate on another boot.

The receiver and relay start only on explicit bootstrap. They use the private bundled Python, Node
and dependency closure and have no automatic workspace restart policy. The relay listens on port
8080 and forwards bootstrap HTTP to `/run/sealant-bootstrap/receiver.sock`. Its daemon route points
to an unavailable socket until a later verified namespace connector replaces that wiring. Mend must
copy `boat-assets` beside `dist`; the new helpers travel through the same asset manifest.

Node is the checksum-pinned upstream 24.22.2 binary. Ubuntu's Node 18 aborts in a private root
because it loads externalized JavaScript built-ins from `/usr/share/nodejs`. The upstream binary and
its native dependencies are copied into the protected bundle. An Ubuntu 24.04 source-hidden
execution check passed for both the real crypto helper and the compiled relay, with no system Node
installed or externalized built-ins available. No guard exception was introduced.

## Private installation

`GET /sealant/bootstrap/status` returns identity, boot, accepted epoch and stage, always with
`admission: held` and `execution: unavailable`. It returns no file contents or fingerprints.

`POST /sealant/bootstrap/stage` accepts authenticated JSON with exactly `format`, `identity`,
`boot_id`, `epoch`, `operation_id` and `files`. Its format is `sealant-admission-stage-v1`. Each
file has exactly `name`, `size`, `sha256` and base64 `data`. Names are a single component of at most
64 ASCII letters, digits, hyphens or underscores, starting with a letter or digit. There are at most
16 files and 2 MiB decoded bytes in a request body capped at 4 MiB. The caller must pin resolved
credential versions and dotfiles digests in the delivered launch descriptor. The receiver verifies
file bytes; it does not interpret a daemon launch descriptor or claim protocol readiness.

Before writing payload bytes, the receiver revalidates the compatible bound boot and durably records
`prepared` with the complete manifest digest. Files install at mode 0600 in a root-owned 0700 epoch
directory on verified tmpfs. Temporary files converge after an interrupted write; conflicting final
files, links, traversal, duplicate names and unknown fields refuse. Only after all files and held
processes verify does the durable stage become `installed`.

An exact same-boot replay converges. Any different payload, operation or epoch refuses after the
first acceptance, even if the earlier request lost its response. A reboot cannot clear this disk
barrier or restore missing tmpfs files under a new identity. There is no generic reset, start or
close endpoint. Canonical close, preservation, recovery and a whole-daemon-invocation receipt must
be implemented before a new writer is possible. Installation proves no scripts ran.

## Verification and remaining gates

Local tests execute the real Unix HTTP boundary, root-private staging, conflicting and lost-response
replays, RSA encryption/decryption and the relay as source and bundled bytes. Source-hidden worker
packaging must include every new helper and reject modified assets. These checks establish local
contracts, not live hosted transport or an end-to-end Boat session.

Before registration, the executor still needs durable sealed exchange and allocation ownership,
whole-invocation adoption, authenticated daemon readiness, resource isolation and the tunnel, FINAL
settlement and writer exclusion, recovery and executable parking. Parking will run plain `sync`
before stop as hygiene. User-work durability was established separately; sync is not a fix for
Boat's handling of its own base systemd executable.
