# Build internal native Boat snapshots

`BoatSnapshotBuilder` prepares Ubuntu 24.04 or pinned Nix on Boat's Ubuntu base. It saves one owned
snapshot and returns only after the source VM's deletion operation completes. It is an internal
builder. Boat remains absent from runtime registration, SDK selection, and worker image
reuse/reaping.

The live gate is incomplete. [The evidence record](./boat-native-snapshots-evidence.json) names
every owned object and separates passed checks from checks that were not reached. Do not register
Boat or claim native containment from these partial results.

## Acquire the exact runtime

Run from the repository root with existing offline-installed dependencies. The acquisition command
creates one small guest with a 15-minute TTL, `noEnv: true`, `monitoring: false`, and owned labels.
It extracts OCI files with skopeo and umoci in that guest. It does not execute an OCI workspace. It
deletes the guest and polls the exact deletion operation before returning.

```sh
boat_bundle_dir="$(mktemp -d -t boat-builder-impl.XXXXXX)"
BOAT_API_KEY="$(cat ~/.config/sealant-dev/boat-api-key)" \
  python3 packages/workspaces/boat-image/acquire-runtime.py "$boat_bundle_dir"
node packages/workspaces/boat-image/build-relay.mjs "$boat_bundle_dir/control-relay.cjs"
```

The authority is `packages/workspaces/src/images/boat/runtime-pin.json`. The source is
`ghcr.io/sealant-sh/sealantd-next:0.21.0-next.180@sha256:f3a2855e210d7357a12c466fac1fc180a4b4d8ab021e4c6f9812b2b2755214fc`.
The bundle parser checks the index, selected amd64 manifest, daemon and socat hashes. It hashes the
local relay bundle with its dependencies. A cached next177 binary cannot construct a bundle. The
extracted daemon reports `0.0.0`; its version output does not establish provenance.

Acquisition writes a private ownership journal before allocation and records the returned ID before
extraction. If cleanup fails, retain that journal and resolve its exact operation/VM. Never replace
an expired idempotency key with a new allocation or discover objects account-wide.

## Use the internal builder

Import `BoatSnapshotBuilder` from `packages/workspaces/src/images/boat/builder.ts` and
`VerifiedRuntimeBundle` from its sibling `runtime-bundle.ts`. Supply the existing `BoatApi`, a
verified bundle, a private journal directory and a UUID owner. The generic OCI builder contract has
no native snapshot variant.

- `build({ spec, signal, onProgress })` returns an exact `NativeSnapshotArtifact` or a typed error.
- `build({ spec, previous })` and `findPublished({ spec, previous })` check the recipe and the
  artifact's published durable journal, then check the provider's name, source, creation time and
  provider ID when supplied. They do not discover other publications.
- `remove(artifact)` checks the same ownership and provider identity immediately before removal.
- `cleanup(explicitJournalPath)` reconciles one interrupted attempt. It can run without runtime
  bytes. It never removes a published artifact implicitly.

Each attempt has a 0600 fsynced journal and its own kernel lock. Allocation retries use one recorded
key at most three times within a conservative 23-hour window. An ambiguous save response never
causes a second save POST. A missing snapshot after an ambiguous save retains the intent for later
explicit reconciliation. A cleanup deadline expires independently of cancellation.
`native-cleanup-pending` is failure, with the exact journal path, rather than build success.
Snapshot names fit 63 characters. Full recipe hashes remain in journals and receipts. The journal
retains the original safe failure code when failure cleanup begins.

Native installation shares package, harness, shell, person, dotfiles and boot content with the
Docker owner before Docker formatting. The Docker parity fixture covers 192 prior valid inputs.
Native installation preserves provider SSH and Ubuntu's loader. Boat's NodeSource npm is used when
its nodejs package conflicts with Ubuntu's separate npm package.

Ubuntu and Nix are the only families. Auto tries Ubuntu first, then Nix when catalog support
requires it. Explicit Arch/Fedora/custom and workspace Docker fail before allocation. Authenticated
build dotfiles fail with `native-dotfiles-tmpfs-unproven`. Public build dotfiles use the shared
installer; runtime dotfiles stay in boot metadata. Setup, startup and harness launches never execute
during image build.

## Run the serial live proof

Use a fresh output directory for each command. Run the next family only after the preceding
command's owned VM and saved snapshot have completed cleanup.

```sh
BOAT_API_KEY="$(cat ~/.config/sealant-dev/boat-api-key)" \
  pnpm exec tsx packages/workspaces/boat-image/native-proof.ts \
  ubuntu "$boat_bundle_dir" "$boat_bundle_dir/ubuntu-proof"
BOAT_API_KEY="$(cat ~/.config/sealant-dev/boat-api-key)" \
  pnpm exec tsx packages/workspaces/boat-image/native-proof.ts \
  nix "$boat_bundle_dir" "$boat_bundle_dir/nix-proof"
BOAT_API_KEY="$(cat ~/.config/sealant-dev/boat-api-key)" \
  pnpm exec tsx packages/workspaces/boat-image/native-proof.ts \
  ubuntu "$boat_bundle_dir" "$boat_bundle_dir/cancel-proof" cancel
```

The fixture attributes screen input to Mend commit `f0defb5753e6d489439be29f13e05ca585447900`,
`packages/domain/src/settings.ts`, `screenPackageIds`. Core has no production screen package list.
The Nix fixture supplements ffmpeg explicitly because Mend's missing request needs a later caller
fix. Ubuntu Chromium uses official snapshot 1735811, its complete release tree and verified
checksum. ARM has no verified archive and fails planning.

The runner checks receipt and runtime hashes after source deletion and cold clone. It exercises
native health/capabilities through the cookie-authenticated hosted relay, fake-environment harness
CLI versions, person sudo, the selected shell, public dotfiles, Xvnc, desktop, Chromium and ffmpeg.
The daemon runs as PID1 with private mount/PID namespaces and scoped proc. The private `/run` hides
outer systemd and D-Bus sockets, including `/var/run` aliases. Relay/provider services stay outside.
Nix's outer socket/service is masked; the daemon starts inside the namespace.

Person sudo is checked outside sealantd. The proof launches clone mode, which deliberately sets
no-new-privileges. Per-person daemon sudo requires owner-map admission and capture restore in the
later registration work. The Nix worker check drops to the person uid and compares the worker's
cgroup with PID1's cgroup. Native Nix readiness has a bounded 90-second budget for cold store pages.
Docker retains its existing 10-second budget.

The saved unit has no Install section or restart policy, and no launch descriptor or credentials. An
explicit admitted descriptor is required. The resume check holds admission and verifies that
lifecycle markers remain unchanged. Whole-unit stop must remove detached writers, screens and Nix
workers while the outer sentinel survives. Empty scope proves writer exclusion only. Core FINAL
preservation evidence remains the authority to delete a run's disk. Production capture/recovery,
credentials, provider-aware artifact retention and public registration follow in a separate change.

The runner writes `evidence.json`, private ownership records and any failed guest response. Check
the result and exact cleanup state. A partially executed live proof is not a pass for later gates.

## Inspect the current evidence

Exact next180 acquisition and extracted hashes passed. Ubuntu and Nix both saved snapshots,
completed source deletion, and cold-cloned their exact saved artifacts. Cold receipt/runtime hashes
and person sudo passed. The real cancellation probe completed exact-ID cleanup.

Nix's first native admission failed because its daemon socket did not become ready. The launcher
entered the private namespace, but health and capabilities through the hosted relay were not
reached. The later 90-second native readiness budget has not been verified live.

The latest Ubuntu install did not reach save. Its failure response was not captured before cleanup.
The provider reports deletion operation `bdop_875e15afda1345d4816722b06d3dc59f` for source
`bx_5fyw4fab` as `blocked`, stage `retrying`. GET for that exact sandbox returns 404. The attempt
journal retains this cleanup obligation. A 404 is not completed deletion. No new allocation follows
while this obligation remains unresolved.

Browser, desktop, ffmpeg, detached-writer cleanup, non-root Nix workers, empty cgroup events after
unit stop, outer sentinel survival, and held admission after provider resume remain unproved. The
runner contains those assertions, but they have not completed on the exact native daemon. The
earlier basic namespace diagnostic is not evidence for those gates or FINAL preservation.

Earlier fixture reports used an unverified Mend commit attribution. The fixture now uses verified
Mend commit `f0defb5753e6d489439be29f13e05ca585447900`, blob
`abc6af533dcb75d5d911ef767e8c4cdfb1fd95c0`. Its `screenPackageIds` body produces the same input
lists.
