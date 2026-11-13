# Native control transport on boat

This experiment tests whether sealant can reach native sealantd in a boat VM through a narrow
WebSocket relay. It does not enable a workspace runtime. Mend, capture storage, resources, and
screen sessions are outside this transport experiment.

## Findings from the trial account

The live test on 2026-11-05 used one `small` VM at a time with `noEnv: true`, `monitoring: false`, a
900-second TTL, and `sealant-dev=boat-stream` labels. Every request used the VM's direct hosted port
with `localhost: false`.

| Probe                                          | Fresh VM                                   | After stop and resume                      |
| ---------------------------------------------- | ------------------------------------------ | ------------------------------------------ |
| HTTP with proxy cookie and relay bearer        | 200                                        | 200                                        |
| HTTP without proxy credential                  | 403                                        | 403                                        |
| HTTP without relay bearer                      | 401                                        | 401                                        |
| HTTP with incorrect relay bearer               | 401                                        | 401                                        |
| HTTP with `_token` query and relay bearer      | 302                                        | 302                                        |
| WebSocket with proxy cookie and relay bearer   | 101, native health and capabilities passed | 101, native health and capabilities passed |
| WebSocket with `_token` query and relay bearer | 101, native health and capabilities passed | 101, native health and capabilities passed |

Boat's HTTP query token redirects to establish its `_port_auth` cookie. A backend can send
`Cookie: _port_auth=<token>` directly. The relay requires a separate bearer on every HTTP request
and WebSocket upgrade. sealant's connection helper returns a clean endpoint and prepares both
headers for the connection, so the secret hosted URL is never retained as the endpoint.

The hosted origin and proxy token stayed the same across the observed stop and resume. That resume
happened within Boat's live-machine grace period. It provides reconnect evidence, not evidence of a
cold restore. Code must fetch connection material again after resume rather than assume this
observation guarantees stability.

The VM reported Ubuntu 24.04.4 LTS, x86_64, and Node v24.22.1 at
`/home/user/.nvm/versions/node/v24.22.1/bin/node`. The command user was uid 1000. Native sealantd
and the relay ran as systemd services.

The daemon came from an image labelled `0.21.0-next.177`, revision
`0a46de1ec57064b39e9dcff5ba75724a8ecc3021`. Its binary reported `0.0.0`. sealant's runtime client is
pinned to `0.21.0-next.180`. Real `SealantClient.health()` and `getCapabilities()` passed with that
client and the older artifact. This proves the measured control exchange only. Production daemon
compatibility, capture, execution, screens, and process containment need their own checks against
the production artifact.

The trial rejected saved snapshots with HTTP 403 and `trial_saved_snapshots_not_allowed`. No saved
snapshot was created during that test. A later paid-account test below settled the cold-launch
question.

Two trial sandboxes were created and deleted. Boat reported these deletion operations as
`completed`:

| Sandbox       | Deletion operation                      |
| ------------- | --------------------------------------- |
| `bx_t2qgqa5m` | `bdop_2b7badf45fc04108917a26077648dec1` |
| `bx_ncgtafk2` | `bdop_8ccd7ac0e6a44c3e8e8342db76b3dab7` |

No raw-IP negative-authentication check was run. Local interface tests cover the relay's own bearer
gate independently of Boat's proxy.

## Cold saved-snapshot launch on the paid account

The paid-account test on 2026-11-05 bundled the relay from this checkout and used the same native
daemon artifact and pinned sealant runtime client. Saving the snapshot returned HTTP 202. Boat
finished saving immutable artifact `cf4d5ffe-648b-46a7-8100-fc33ebe4471d` from source `bx_yt9umdv5`.
The source finished deletion before a new sandbox was created from the saved handle. This
establishes a new VM launch from saved disk, independently of Boat's live-machine grace period.

One cold launch reached provider-ready in 2.085 seconds and returned a real native health reply in
3.366 seconds from the start of create. The latter includes provider polling and delivery of the new
relay credential. The hosted WebSocket upgraded with HTTP 101, and native capabilities passed. These
are single transport observations with an older daemon artifact, not a production session benchmark
or latency guarantee. There is no baseline comparison, distribution, or screen workload in this
measurement.

The cold VM returned HTTP 200 with the proxy cookie and relay bearer, 403 without the proxy
credential, and 401 with a missing or incorrect relay bearer. After stop and resume, real WebSocket
health and capabilities passed again. The same HTTP auth checks passed. Hosted origin and token
remained unchanged for that observed resume, which was not a second cold-launch test.

The saved handle was `sealant-dev-boat-stream-3b95a715-98ac-4f65-93c0-e525597e605b`. Its API has no
labels field. Ownership came from that unique name, the source's `sealant-dev=boat-stream` label,
and the recorded artifact. Both VMs finished deletion:

| Sandbox       | Deletion operation                      |
| ------------- | --------------------------------------- |
| `bx_yt9umdv5` | `bdop_6de6f45bb914492eb368eca496cb8e60` |
| `bx_j5dktcxy` | `bdop_f5baa85713104dcf8bea9fd0010c61ef` |

The saved handle was deleted separately. A subsequent GET returned 404 `not_found`. No cloud objects
created by either experiment were retained. The native daemon's SHA-256 was
`af73d64d778ce2920c2076eb28814a821f33ab3185245593609ca6ffd251229e`.

## Reproducible transport artifact

`packages/workspaces/boat-image/control-relay.mjs` owns exactly two authenticated routes:

- `GET /sealant/health` connects to the Unix socket and reports socket reachability. Its body
  explicitly says native readiness is unverified.
- The `/sealant/control` WebSocket upgrade forwards binary bytes to that same socket. The route uses
  `URL.pathname`, so query parameters do not alter routing.

There are no lifecycle hooks, remote commands, launch delivery, capture flushes, or process
supervision routes. The listener uses `ws` streams for backpressure, limits messages to 16 MiB and
active or pending connections to 64, and tears down both peers together. Its token comes from an
owner-only regular file. The listener rejects symlinks and files readable by other users.

`build-relay.mjs` bundles the installed `ws` dependency into one CommonJS artifact for Node 24. It
removes the local Boat API key from its environment before starting the bundler. Generated bundles
and native binaries are not committed.

The provider client owns JSON parsing, provider IDs and states, safe URL policy, and redacted error
translation. Unknown provider states fail closed. Archive remains a provider state with potentially
live writers. A completed deletion operation is distinct from an accepted deletion request.

The opt-in runner accepts these forms from the sealant repository root:

```sh
BOAT_API_KEY="$(cat ~/.config/sealant-dev/boat-api-key)" pnpm exec tsx \
  packages/workspaces/boat-image/spike.ts --sealantd /absolute/path/to/native/sealantd

BOAT_API_KEY="$(cat ~/.config/sealant-dev/boat-api-key)" pnpm exec tsx \
  packages/workspaces/boat-image/spike.ts --cleanup /absolute/path/to/ownership.json
```

The native daemon path is mandatory. The runner rejects a missing, nonexecutable, or non-amd64 ELF
binary before allocation. The evidence report records its SHA-256 and treats daemon compatibility as
a separate requirement. It does not download a daemon or claim that its filename proves its version.

The runner creates a private named scratch directory and prints paths to its nonsecret ownership
record and evidence. It persists the run marker, idempotency key, and requested source before
allocation. It persists the returned sandbox ID before bootstrap. Retries use the same request body
and idempotency key. Cleanup can recover an ambiguous create with that recorded key only within a
conservative 23-hour window. An expired window requires investigation and cannot allocate a
replacement.

Uploads use approved Boat HTTPS origins with redirects disabled. No account credential accompanies a
signed upload request. Relay secrets arrive through the file API inside an already private staging
directory, then move to a root-private guest directory with mode 0600. Secrets never enter `env`,
`setupScript`, guest command arguments, or diagnostic payloads.

Saved snapshots have no documented labels field. The runner uses a unique
`sealant-dev-boat-stream-<marker>` name and records the labelled source, creation timestamp, and
immutable artifact ID. Cleanup checks that metadata before deleting the named snapshot. It does not
list or clean up account-wide objects. The source sandbox must finish deletion before a cold clone
can be allocated, so at most one VM runs at a time.

The runner reconnects after stop and resume and uses real native health and capabilities. If the
account permits saved snapshots, it also measures creation-to-provider-ready and
creation-to-first-native-health for a new VM from the saved snapshot, then stops and resumes that
VM. Trial refusal is reported as `INCONCLUSIVE` with exit status 2. SIGINT and SIGTERM stop further
work and enter cleanup after the bounded in-flight request returns. A failed cleanup leaves its
ownership record for an explicit retry.

## Verification boundary

The local suite starts the real source relay and its bundled artifact, a Unix transport peer, and a
faithful local HTTP API. It checks auth, route queries, binary bytes, backpressure, message limits,
paired shutdown, request safety, parsed responses, redaction, stable create identity, and deletion
operation states. It does not simulate cloud success or count a socket probe as native readiness.

The next runtime unit still needs real Ubuntu and Nix snapshot recipes, screen packages, native
lifecycle containment, prequeue Arch and Fedora refusal, capture preservation, and the per-session
encrypted resource tunnel. No public `boat` runtime ID, runtime registration, SDK contract, or
resource network behavior changes in this unit.

## Sources

- [Boat API documentation index](https://docs.boat.dev/llms.txt).
- [Create sandbox](https://docs.boat.dev/api/reference/sandboxes/create-sandbox.md).
- [Expose a port](https://docs.boat.dev/api/reference/agent/expose-a-port.md).
- [Stop and archive sandbox](https://docs.boat.dev/api/reference/sandboxes/stop-and-archive-sandbox.md).
- [Save a saved snapshot](https://docs.boat.dev/api/reference/snapshots/save-saved-snapshot.md).
- [Permanently delete sandbox data](https://docs.boat.dev/api/reference/sandboxes/permanently-delete-sandbox-data.md).
