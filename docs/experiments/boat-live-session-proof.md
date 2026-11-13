# Ordinary Boat sessions and the preview proof

Boat is off by default and registered like MicroVM: a deployment that configures it serves it. Boat
runs in the deployment owner's own Boat account, as MicroVM runs in their own AWS account, so there
is no per-owner list: whoever may create workspaces on the deployment can launch Boat VMs on that
account. A request reaches Boat only by naming `target.runtime.family: "boat"` (Mend names it on
every Boat request); `auto` follows the deployment default. The worker registers the Boat adapter
only where its builder is configured, and then requires allocation, authenticated readiness, FINAL
close and resource reconciliation to be assembled. A deployment without Boat answers a Boat request
with `unsupported-runtime`, as for any runtime it did not configure. Capture sources are supported;
inline dotfiles archives are currently refused. Native image preflight can return unknown while
construction still runs through the ordinary native publication owner.

The ordinary adapter stages the real launch material and credential revision pins, waits for
authenticated readiness, and opens interactive control directly. The API holds the deployment's Boat
key the way it holds AWS credentials for MicroVM: each interactive connection reads the run's sealed
bearer, checks the VM's ownership labels, asks Boat for a fresh hosted cookie and is rechecked
against Stop and current execution ownership.

Ordinary Stop uses canonical FINAL capture, positive provider deletion and gateway cleanup before
releasing the UDP slot and native publication consumer. Reconciliation finishes publication release
if the worker crashes after recording the stopped runtime. Resume creates a fresh VM from the
project publication and restores Mend's captured worktree. Mend's existing idle Stop uses this same
path.

Snapshot parking, which also kept installed packages and disk state outside the captured worktree,
was cut. Installed packages, home files and caches outside the captured worktree do not survive a
Stop.

## Worker configuration on VM 131

Use a Mend build bundling this sealant branch, including the new
`20261108010038_boat_interactive_control` migration and `boat-assets` beside `dist/`. The gateway
built from #471 remains suitable; this layer does not change `boat-tunnel`.

The operator supplies names and values privately:

- Both API and worker: `SEALANT_CREDENTIALS_KEY`,
  `SEALANT_BOAT_API_KEY_FILE=/run/secrets/boat-api-key` (or `SEALANT_BOAT_API_KEY`) and
  `SEALANT_BOAT_DEPLOYMENT_ID`. Given the deployment id, the API refuses to start without the Boat
  key and names the settings; given neither, it refuses Boat requests at create.
- Worker: `SEALANT_BOAT_GATEWAY_HOST_ID`, `SEALANT_BOAT_GATEWAY_RELAY_HOST`,
  `SEALANT_BOAT_GATEWAY_IMAGE`, `SEALANT_BOAT_BUILDER_OWNER`,
  `SEALANT_BOAT_STATE_DIRECTORY=/var/lib/sealant/boat`. The builder settings are what register the
  Boat adapter; with either one set, the worker refuses to start without the rest.
- `SEALANT_BOAT_GATEWAY_ENDPOINT` is retired: every tunnel is carried over HTTPS to the relay host.
  The worker ignores it, so it can be removed.
- `SEALANT_BOAT_ADMISSION_OWNER_IDS` is retired. The API and the worker ignore it, so it can be
  removed.
- `SEALANT_BOAT_AUTOMATIC_PARKING` and `SEALANT_BOAT_PARKING_DELAY_SECONDS` are retired. The worker
  ignores them, so they can be removed.
- Mount the persistent native-build journal directory at `/var/lib/sealant/boat`. The builder owner
  UUID must survive worker restarts. Mount the secret directory read-only at `/run/secrets` in both
  the API and the worker, owned by root with mode 0700, containing the root-owned, regular,
  single-link 0400 key file. Symlink components and simultaneous `SEALANT_BOAT_API_KEY` and file
  settings are refused. The loader never copies key bytes to environment variables or diagnostics.

The container still needs the ordinary resource/Docker configuration from the existing runbook.
Public Mend session and Garage URLs must use the approved Funnel paths on 8443 and 10000; 443 is the
Mend origin. No UDP port needs to reach the gateway host: its ports (61000–61511) are published on
the relay host address only. This change makes no networking or compose edits. Boat runs in the
deployment's own Boat account, so the API and the worker both hold its key; this supersedes the
worker-only isolation that [sealant-sh/mend#1523](https://github.com/sealant-sh/mend/issues/1523)
asked for.

## Checked-in proof command

The checker uses a dedicated Mend account token, a project with a linked TCP resource, and a
connected Codex account. It launches protocol mode with no inference prompt, opens real Mend shell
processes using server-issued upgrade tickets, and writes a unique worktree file. It requires the
linked resource's name to resolve inside the exact tunnel subnet and accept a TCP connection. It
then waits for Mend's actual idle Stop, checks FINAL/deletion/slot-release records in sealant, reads
the captured file through Mend, resumes in a different VM, verifies its bytes, and stops. No
synthetic launch token, SQL timestamp edits, bootstrap or queue consumer is used.

Build the separate checker container from the same exact sealant revision as the worker:

```sh
docker build --target builder -f apps/worker/Dockerfile -t boat-session-proof:REVISION .
```

The existing builder target contains the checked-in TypeScript and frozen dependencies. Its worker
process is not started. The checker needs no Docker socket, privileged mode or host network. The
operator exports the named variables in the invoking shell without printing their values.
`PREVIEW_NETWORK` is the preview database's existing Docker network. `MEND_URL` is the public 443
origin. The resource name and port refer to the dedicated project's linked resource. `MEND_TOKEN` is
the dedicated person's real Mend token. The checker needs only `DATABASE_URL`, not the credential
cipher, because it never decrypts launch material. The state mount is the same persistent journal
the bundled worker uses.

This is the exact run template, with operator-supplied image revision and network:

```sh
docker run --name boat-session-proof --rm --network "$PREVIEW_NETWORK" \
  --env DATABASE_URL --env MEND_URL --env MEND_TOKEN \
  --env BOAT_PROOF_PROJECT_ID --env BOAT_PROOF_OWNER_ID \
  --env BOAT_PROOF_RESOURCE_HOST --env BOAT_PROOF_RESOURCE_PORT \
  --env SEALANT_BOAT_DEPLOYMENT_ID --env SEALANT_BOAT_BUILDER_OWNER \
  --env SEALANT_BOAT_STATE_DIRECTORY=/var/lib/sealant/boat \
  --env SEALANT_BOAT_API_KEY_FILE=/run/secrets/boat-api-key \
  --mount type=bind,src=/root/boat-proof/secrets,dst=/run/secrets,readonly \
  --mount type=bind,src=/root/boat-proof/state,dst=/var/lib/sealant/boat \
  --mount type=bind,src=/root/boat-proof/evidence,dst=/proof \
  boat-session-proof:REVISION \
  pnpm exec tsx packages/workspaces/scripts/boat-live-check.ts run /proof/session-1
```

The evidence parent directory must already exist. The run directory must be new. The checker fsyncs
both the ledger and its directory entries before sending create. It never automatically retries
create, launch or resume. Native construction has its own 30-minute budget. After the current
attempt's publication is observed ready in sealant, authenticated readiness gets a fresh 12 minutes,
including on resume. The in-flight Mend HTTP request allows both budgets and is cancelled when a
phase expires. The ledger records `publication-ready` and `readiness-budget` separately.
`BOAT_PROOF_BUILD_BUDGET_MS` may select a 1–60 minute construction budget. Shell execution has 60
seconds, actual idle Stop has 20 minutes, and FINAL cleanup has five minutes.
`BOAT_PROOF_IDLE_BUDGET_MS` may select a 1–30 minute idle budget. Configure Mend's real idle-stop
setting to fit the selected budget; do not edit session timestamps.

For interrupted cleanup, repeat the same container command with `cleanup /proof/session-1` instead
of `run /proof/session-1`. It reuses only the recorded session, exact publication and original
native build journal; it does not allocate or resume. Unknown effects remain obligations. Complete
baseline and final census reads every sandbox cursor page and the documented unpaginated personal
saved-snapshot list. Every VM must be absent. A snapshot may remain only when a ready publication
for the configured deployment and owner records the exact same immutable provider identity and
builder owner. The ledger records those retained publication IDs and snapshot names separately.
Changed, unexplained or unready snapshots still refuse the census. Objects outside the proof are
never deleted.

The checker preserves ready catalog publications so another session can reuse them. Other recorded
proof publications use the existing withdrawal path, which refuses active consumers, changed build
identity or active claims. Normal seven-day/ten-plan cache retention remains unchanged. A failure
records the final census and keeps cleanup obligations visible.

The snapshot probe separately requests the saved-snapshot list and exact saved snapshot without
credentials and with an invalid key. It records HTTP status and only explicit visibility fields from
the authenticated API. 401/403 means those negative requests were refused; it does not establish
cross-account privacy. Missing visibility fields remain unknown. It never stores API keys, launch
credentials, terminal tickets, signed URLs, shell output or user file bytes in the ledger.

## Proof limits

Local tests execute the emitted Python through a real HTTP/WebSocket Mend-protocol fixture and real
TCP listener. The worker regression starts with repository-created queued attempts and build jobs in
disposable PostgreSQL. It builds a publication, launches through the real Boat adapter and
allocation owner, reaches authenticated readiness, writes an edit through interactive control,
completes FINAL with positive deletion and slot release, then restores the edit into a fresh VM and
closes it. Boat's API, guest receiver and resource gateway are local fixtures. The pinned daemon and
its control relay run in owned Docker containers, and capture data crosses the local session
channel. CI stages the exact pinned bundle and runs this proof explicitly.

Run 5's pending consumer pin does not block another attempt from reusing its ready publication. The
regression creates that state through a failed launch and verifies reuse. The old pin still blocks
publication retirement; this fix does not release it or add a sweep. Both successfully closed runs
release their own pins. The pending runtime now records the chosen adapter before dispatch, and
allocation keeps the existing matching row and launch lease. A foreign runtime binding still fails
before a provider create.

These establish local behavior only. Session 6 still needs the deployed Mend worker and real Boat
proof. This fix requires a new sealant pin in the Mend preview and a checker image rebuilt from the
same revision. It adds no migration. No VM 131 writes, key reads, provider calls or allocations were
made for this fix.
