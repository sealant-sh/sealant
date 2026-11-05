# Build internal native Boat snapshots

`BoatSnapshotBuilder` prepares Ubuntu 24.04 or pinned Nix on Boat's Ubuntu base. It saves one owned
snapshot and returns only after the source VM's deletion operation completes. It is an internal
builder. Boat remains absent from runtime registration, SDK selection, and worker image
reuse/reaping.

The complete normal Ubuntu and Nix live proofs passed on 2026-11-05.
[The evidence record](./boat-native-snapshots-evidence.json) names every owned object, retains
failed diagnostic attempts, and records cleanup lists after each proof. Runtime registration remains
a separate unit.

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
Deletion intent is persisted after live ownership validation and before DELETE. Reconciliation
replays that exact VM ID to recover a lost response and polls the returned operation. A hidden VM
with GET 404 does not discharge the obligation. The saved-snapshot API has no labels field, so saved
names carry `sealant-dev-boat-stream-` and the full attempt UUID. Their source VMs carry the
`sealant-dev=boat-stream` label. Snapshot names fit 63 characters. Full recipe hashes remain in
journals and receipts. The journal retains the original safe failure code when failure cleanup
begins.

Native installation shares package, harness, shell, person, dotfiles and boot content with the
Docker owner before Docker formatting. The Docker parity fixture covers 192 prior valid inputs.
Native installation preserves provider SSH and Ubuntu's loader. Boat's NodeSource npm is used when
its nodejs package conflicts with Ubuntu's separate npm package.

Ubuntu and Nix are the only families. Auto tries Ubuntu first, then Nix when catalog support
requires it. Explicit Arch/Fedora/custom and workspace Docker fail before allocation. Authenticated
build dotfiles fail with `native-dotfiles-tmpfs-unproven`. Public build dotfiles use the shared
installer; runtime dotfiles stay in boot metadata. Inline credentials, query parameters, and
fragments in dotfiles URLs fail with `native-dotfiles-unsafe-url` before allocation in either phase.
SSH usernames remain allowed. Setup, startup and harness launches never execute during image build.

## Run the serial live proof

Use a fresh output directory for each command. Run the next family only after the preceding
command's owned VM and saved snapshot have completed cleanup and both account lists confirm their
absence.

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

After each proof, audit both lists. These are read-only checks; cleanup uses the exact ownership
journal and never discovers deletion targets from the account list.

```sh
BOAT_API_KEY="$(cat ~/.config/sealant-dev/boat-api-key)" python3 - <<'PY'
import json, os, urllib.request
for endpoint, field in [('sandboxes', 'sandboxes'), ('saved-snapshots', 'snapshots')]:
    request = urllib.request.Request(
        'https://boat.dev/api/v1/' + endpoint,
        headers={'Authorization': 'Bearer ' + os.environ['BOAT_API_KEY']},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        items = json.load(response)[field]
    print(endpoint, [{k: x[k] for k in ['id', 'name'] if k in x} for x in items])
PY
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
outer systemd and D-Bus sockets, including `/var/run` aliases. A read-only bind of
`/etc/resolv.conf` preserves Ubuntu's resolver symlink target without exposing the manager sockets.
Relay/provider services stay outside. Nix's outer socket/service is masked; the daemon starts inside
the namespace.

Admission lives in `/var/lib/sealant/control/launch.json`. The launcher checks it again immediately
before exec. The proof starts the unit, verifies its systemd MainPID is `unshare`, then points the
relay at `/proc/<MainPID>/root/run/sealant/control.sock`. Direct outer bind aliases passed once but
failed on repeat cold Nix clones while the actual inner socket accepted connections. Namespace-root
resolution reaches the supervised unit's actual socket. Registration must recreate this mapping for
each unit start and keep the relay in its own cgroup.

Person sudo is checked outside sealantd. The proof launches clone mode, which deliberately sets
no-new-privileges. Per-person daemon sudo requires owner-map admission and capture restore in the
later registration work. The Nix worker check drops to the person uid and compares the worker's
cgroup with PID1's cgroup. It builds a derivation using the installed bash/coreutils closure,
without fetching nixpkgs again. Root and person DNS are checked separately. Native Nix readiness
allows 90 seconds, with 15 seconds per client query. A diagnostic cold clone showed major page
faults and disk waits during startup; a successful query took 3.14 seconds and exceeded the old
two-second limit. On failure, the native helper records resolved binaries, daemon PID state, cgroup,
log tail, and exit status when available. Docker output remains unchanged.

The saved unit has no Install section or restart policy, and no launch descriptor or credentials. An
explicit admitted descriptor is required. The resume check holds admission, explicitly attempts a
start, waits for MainPID zero and the held-admission exit, then verifies lifecycle markers remain
unchanged. A fixed sleep is insufficient while resumed files are loading. Whole-unit stop must
remove detached writers, screens and Nix workers while the outer sentinel and relay survive. The
proof accepts `populated 0` or complete cgroup removal after stop, with systemd MainPID zero. Linux
refuses to remove a populated cgroup. This proves writer exclusion only. Core FINAL preservation
evidence remains the authority to delete a run's disk. Production capture/recovery, credentials,
provider-aware artifact retention and public registration follow in a separate change.

The runner writes `evidence.json`, private ownership records and any failed guest response. Check
the result and exact cleanup state. A partially executed live proof is not a pass for later gates.

## Inspect the completed evidence

The complete normal proofs are `/tmp/boat-native-proof.EtvYaT/nix/evidence.json` and
`/tmp/boat-native-proof.A5r7oV/ubuntu/evidence.json`. Both used the exact next180 bundle. Each built
and saved its environment, confirmed source deletion, cold-cloned the saved artifact, verified
receipt/runtime hashes, and exercised explicit artifact reuse. Real cancellation cleanup passed in
the earlier cancellation proof.

Both cold clones passed native PID1, hidden outer manager sockets, DNS, cookie-hosted control
health/capabilities, fake-environment CLI versions, selected shell, public dotfiles and person sudo
outside clone mode. Ubuntu ran Xvnc, XFCE, pinned Chromium and ffmpeg. Nix ran Xvnc, Openbox,
Chromium and ffmpeg, then built a non-root Nix worker from the installed bash/coreutils closure. Its
worker cgroup matched sealantd's. Full scope listings contained every expected writer, including
detached writers, screens and the Nix daemon.

Whole-unit stop removed each cgroup, set MainPID to zero, and left the outer sentinel and relay
alive. After provider stop/resume, the unit did not start automatically. An explicit start settled
with `session admission held`, status 1 and MainPID zero. Setup/startup markers remained unchanged
before and after that attempt.

Observed cold create-to-health times were 27.659 seconds for Ubuntu and 129.634 seconds for Nix.
These include receipt/runtime verification, the image probe, person/sentinel fixture setup,
admission and relay staging. The earlier transport-only spike measured 3.366 seconds. These are
single observations with different workloads, not a launch-latency distribution.

The failed attempts explain the final choices. Cold Nix disk waits exceeded the old daemon query
limit. Outer control-socket aliases were unreliable across full cold clones, while namespace-root
connections worked. Private `/run` hid Ubuntu's resolver target until its file was bound read-only.
Nix's wrapped Openbox process name invalidated the old process-name assertion. Screen readiness,
removed cgroup files and resumed admission all required condition-based checks. The evidence keeps
each failure distinct from the final passing proofs.

Every created VM and saved snapshot was removed. Both final account lists were empty at
2026-11-05T04:08:41Z. Nothing is retained in boat. Yiannis separately confirmed the old
`bx_5fyw4fab` / `bdop_875e15afda1345d4816722b06d3dc59f` record is resource-free and took provider
follow-up. Do not poll or retry it. Check the live sandbox list before treating a new delayed
deletion as a blocker.

Mend still needs a longer cold screen-readiness budget and an explicit Nix ffmpeg request. Its
current display wait is ten seconds; one cold Nix Xvnc start took about 46 seconds. The fixture
provenance is Mend commit `f0defb5753e6d489439be29f13e05ca585447900`, blob
`abc6af533dcb75d5d911ef767e8c4cdfb1fd95c0`. Core owns no production screen option expansion.

This unit does not prove FINAL capture preservation or per-person daemon sudo in clone mode.
Registration must integrate owner-map admission, capture/recovery, credentials and artifact
retention. Its preview is the first boat runtime box check.
