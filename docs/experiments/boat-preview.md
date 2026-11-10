# Build the separate Boat preview

Build Core from `feat/boat-native-guest`, pinned to the pushed commit in its pull request. This
branch packages the held native guest above the merged provider and publication groundwork. Boat
admission is disabled. No setting enables Boat sessions in this version. A preview can check
migrations, existing runtimes, image scope authorization and public publication responses now. It
cannot pass the Boat session check.

## Build inputs

Build from the repository root with the committed lockfile. Use the same commit for every Core
component. There are no published preview image tags or image digests for this branch. The operator
builds these Dockerfiles and records the resulting image IDs before deployment:

| Component                                    | Dockerfile                    |
| -------------------------------------------- | ----------------------------- |
| Core API and migration runner                | `apps/api/Dockerfile`         |
| Core worker                                  | `apps/worker/Dockerfile`      |
| Core SSH gateway, when used                  | `apps/ssh-gateway/Dockerfile` |
| Core web, when deployed separately from Mend | `apps/web/Dockerfile`         |

Use the API image's `node dist/migrate.js` command for the preview database. Take a preview database
backup first. This branch adds publication tables and job/runtime fields; rollback to an older
writer is not a database downgrade. Preserve the preview database and its native publication pins.

The exact native daemon input is
`ghcr.io/sealant-sh/sealantd-next:0.21.0-next.180@sha256:f3a2855e210d7357a12c466fac1fc180a4b4d8ab021e4c6f9812b2b2755214fc`.
Its amd64 manifest is `sha256:95bdbf73519d9b122fbdba2c88a17fe73dcf84fa1ac149821ff4cfe5056ebc5b`. The
extracted daemon SHA-256 is `cea5952d9e2b0fa45443adf925c8aaebaa6c2a50eb51cb02ffc2f9ef4083e969`. Its
source revision is `52228108c8bd002ea69dd5dd3d5f843ce1271cca`. This is the exact native builder
input. Any required daemon change needs a real publication and a new verified pin.

Set `SEALANT_DOCKER_NETWORK_GUARD_IMAGE` to
`busybox:1.37@sha256:bdf57e528e45e4433820e045b29b4597825a1c9e38353532d90a01445013f82e`. This is the
existing Docker resource/metadata guard, not a WireGuard gateway image. A resource tunnel gateway
has not been packaged or implemented in this head.

The worker ships `/app/boat-assets` beside its compiled application and verifies the packaged Ubuntu
and Nix recipes during the image build. The assets include the mapped root launcher, private
interpreter and dependency closure, units, held bootstrap and manifest. The exact relay, daemon and
`socat` inputs match `packages/workspaces/src/images/boat/runtime-pin.json`. Held-8.16 cold startup
has not passed; see `boat-native-guest-startup.md`. Authenticated current-boot binding delivery and
ordinary Boat admission remain unavailable.

Mend has no Boat companion PR or public SDK release from this work yet. Keep the preview's current
Mend version pinned separately. Do not import Core workspace internals into Mend or invent an SDK
version. The companion must consume the actual public SDK release before the Boat lifecycle check.

## Configure the preview network

The operator provisions an 8 GB preview VM at `10.0.0.41`. It is separate from live Mend VM 130. The
preview needs no public IP of its own. The Proxmox public endpoint is `49.12.133.97`.

| Path                                             | Public protocol and port           | Destination in preview VM                      | Funnel support                                          |
| ------------------------------------------------ | ---------------------------------- | ---------------------------------------------- | ------------------------------------------------------- |
| Mend web, browser screens and terminal           | HTTPS and WSS, 443                 | Loopback 3105 to Mend 3105                     | HTTPS proxy                                             |
| Session calls and project Git CONNECT            | TLS carrying HTTP/1.1, 8443        | Loopback 13106 to Mend 3106                    | TLS-terminated raw TCP, preserving CONNECT              |
| Presigned capture, screen and recovery objects   | HTTPS PUT and GET, 10000           | Loopback 13900 to Garage 3900                  | TLS-terminated raw TCP, preserving Host, path and query |
| Session resource tunnel and tunnel DNS           | WireGuard UDP, 40000 through 40015 | Proxmox DNAT to the same ports on 10.0.0.41    | Unsupported, public UDP DNAT is required                |
| Resource Postgres, Redis and other service ports | None                               | The session's own private Docker reach network | Never publish or individually relay these ports         |
| Core API, Postgres, Garage admin and Docker      | None                               | Internal services and Unix sockets             | Keep private                                            |

Only the preview browser needs the web path. Boat needs the session, object and eventual encrypted
resource paths. It needs no webhook receiver, tailnet login, public VNC or public resource port.
Proxmox TCP 80/443 and UDP 443 continue to serve live VM 130. This stream does not change them.

The selected Mend values for the later companion are
`MEND_SESSION_ENDPOINT_URL=https://<preview>.ts.net:8443`,
`MEND_BLOB_STORE_PUBLIC_URL=https://<preview>.ts.net:10000`, and `APP_URL=https://<preview>.ts.net`.
Keep Garage's internal endpoint `http://garage:3900` and bind the published channel and S3 ports to
loopback. TLS terminates in Funnel. Verify real authenticated Git CONNECT and presigned PUT/GET;
health alone does not test either route. Disable npm and Docker mirrors for Boat sessions in that
companion.

Leave the existing default runtime in place in this groundwork head. `DEFAULT_RUNTIME_ADAPTER=boat`
has no registered adapter and cannot admit sessions. The proposed `SEALANT_BOAT_CONFIG_FILE`,
`SEALANT_BOAT_API_KEY_FILE`, resource-Docker switch and tunnel service configuration are not
implemented settings here. Do not supply speculative settings as if they enabled the runtime.

The planned provider key delivery is a root-owned mode 0400 file under a root-owned mode 0700
directory, mounted read-only into the worker at `/run/secrets/boat-api-key`. (Superseded: the API
holds the key too, to open Boat sessions' control; see `boat-live-session-proof.md`.) The later file
loader must verify ownership, permissions and symlink policy. Keep the key out of Compose
environment values, logs, images, provider `env` and `setupScript`. This head does not need a
provider key for the admission-disabled control-plane checks.

## Check capacity and undo the preview

Measure actual guest memory as well as the configured 8 GB. During the future Ubuntu and Nix
lifecycle checks, require under 7 GiB used, measured as `MemTotal - MemAvailable`, and at least 1
GiB available throughout. Require no OOM or sustained swap thrashing. Initially keep test resources
within 512 MiB combined. Capacity has not been measured on this VM.

The operator's changes are limited to the new VM's Compose project, images, database migration,
Garage bucket and keys, Funnel listeners, and its dedicated Proxmox UDP range. The future resource
gateway adds a host service, socket and durable state only on that preview VM. Keep the deployment
cipher key and object ownership identities stable.

To stop this disabled preview, stop its Compose project and remove only its own Funnel listeners and
UDP forwarding rules. Preserve its volumes and database backup. Before any later rollback with live
Boat objects, disable new admission, then keep compatible reconciliation, credentials, assets,
snapshots and publication pins until every obligation is discharged. Stopping the controller or
enabling a provider TTL is not recovery or cleanup.

Automatic parking, chosen on 2026-11-05 and built afterwards, was cut on 2026-11-10: a stopped
session is drained and deleted, and resuming is a fresh VM from the project snapshot plus the
captured worktree. The actual Boat session box check follows the guest, receiver, resource tunnel,
runtime lifecycle and SDK-only Mend companion work.
