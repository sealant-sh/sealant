# Boat native-build command transport

## Result

The final detached implementation passed the separately authorized full 22-package Ubuntu native
build. `install-recipe` returned exit code 0 after 416.114 seconds and 380 status reads. The build
produced a ready saved publication after 465.794 seconds. Its scratch VM was positively deleted, the
saved artifact was deleted through its original journal, same-journal cleanup succeeded, and
complete final inventories contained no sandboxes or snapshots. No third build was made.

The earlier streaming attempt failed after 478.215 seconds with an HTTP 200 `UND_ERR_SOCKET` and no
terminal result. That failure remains recorded below. It does not identify who closed the socket.
Native-build acceptance is now proven; the real Mend create/stop/resume proof remains for VM 131
session 5.

## Diagnosis and API contract

VM 131 run 4 failed after 313 seconds with `native-provider-transport_error`, without a command
result. Its original logs cannot establish whether the client or Boat cut the connection. No VM 131
access was used for this investigation.

A local HTTP fixture reproduced the client timer failure by lowering undici's ambient headers/body
timers to 20 ms and holding a response for 1.6 seconds. This exceeds the timer's coarse scheduling
interval. The original global-fetch code failed. The corrected request receives its result. A
negative control restoring a 20 ms transport timer also fails against the final detached
implementation.

Boat documents a 600-second synchronous cap, NDJSON streaming, and detached commands with status/log
reads. Detached processes are not subject to the synchronous cap. The live attempt proves that
streaming alone did not keep this build's connection alive. Its 478-second socket loss does not
identify whether Boat, an intermediary, the guest agent, or another network component closed it.

The final client sends a single detached start and retains the returned process ID. It polls that
exact ID once per second, with each read bounded to 15 seconds. A lost status response can be read
again. A lost start is ambiguous and is never replayed. Wrong IDs, lost tracking, inconsistent
status and truncated output refuse success. Only a terminal result permits the builder to proceed to
save.

The existing execution budget remains at most 600 seconds from the start request. Cancellation or
deadline expiry gets one independently bounded 15-second stop attempt for the known process. There
is no second stop attempt after a lost reply. A lost tracking handle is never used to signal a
potentially reused PID. The failure still reaches canonical exact VM cleanup. If the worker crashes,
the pre-existing durable build journal owns the scratch VM, which reconciliation deletes without
replaying construction. This change adds no detached-process recovery or command replay.

Every Boat request sets undici's headers/body timers to its HTTP budget through a composed
dispatcher. It borrows the existing pool, creates no extra pool, and changes no global dispatcher
settings in production.

References checked on 2026-11-08:

- https://docs.boat.dev/api/reference/agent/execute-sandbox-command.md
- https://docs.boat.dev/api/reference/agent/get-command-status.md
- https://docs.boat.dev/api/reference/agent/stop-command.md
- https://docs.boat.dev/long-running-tasks/background-commands.md

## Safe diagnostics

Failures retain `operation`, nullable HTTP `status`, and an allowlisted `causeClass`, including
nested `UND_ERR_HEADERS_TIMEOUT`, `UND_ERR_BODY_TIMEOUT` and `UND_ERR_SOCKET`. A known construction
step is added for command failures. These fields survive NativeBuildError, the version-1 build
journal, catalog translation, and the worker's error message and failed-job row. Existing journals
remain readable. Raw exception messages, URLs, command text, stacks and authentication values are
excluded. Earlier bounded/redacted command-output diagnostics remain when an actual result arrives.

## Verification

The detached HTTP regression first failed against the streaming implementation. It models a dropped
long-lived stream and succeeds through one detached start and two status reads. Other controls cover
delayed headers/body, split UTF-8, lost status reads, nonzero exit, wrong IDs, lost tracking,
truncation, oversized output, lost start, cancellation, a lost stop response and an actual 31-second
execution deadline. Property controls exercise cause redaction and serialized round trips. Builder
HTTP fixtures and real Postgres build jobs verify diagnostics from both start and status failures,
failed-job persistence and positive exact scratch deletion.

Commands:

```sh
pnpm --filter @sealant/workspaces exec vitest run src/runtime/boat/api.test.ts src/images/boat/command-diagnostics.test.ts src/images/boat/builder.test.ts
SEALANT_BOAT_RUNTIME_BUNDLE=<verified-bundle> pnpm --filter @sealant/workspaces exec vitest run --config vitest.e2e.config.ts src/images/boat/builder.e2e.ts
SEALANT_TEST_DATABASE_URL=<disposable-postgres> SEALANT_BOAT_RUNTIME_BUNDLE=<verified-bundle> pnpm --filter @sealant/workspaces exec vitest run src/worker/native-publication.db.test.ts -t 'logs safe'
pnpm typecheck --force
pnpm lint --force
```

The final focused run passed 108 tests, the builder HTTP run passed 11, and the selected Postgres
run passed four. Forced typecheck and lint passed all 20 tasks each. `pnpm format:fix` ran;
unrelated baseline formatter rewrites were excluded. Both owned Postgres containers and the copied
runtime bundle were removed. The original runtime bundle remains intact.

## Live evidence and exact cleanup

The live source was local commit `82bb1756a8ebb3d7e367fbd12e285d3b2111fd16`. It used all 22 supplied
catalog package IDs, Ubuntu and pinned sealantd next.180. Launch-only endpoint/credential values
were omitted. The recipe and guest guards were unchanged. No saved publication was created or
withdrawn.

- Scratch VM: `bx_qr762f49`, labelled `sealant-dev=boat-stream`.
- Build: `cf68a370-fac0-4b51-95af-11b8b79a76cd`.
- Reserved publication identity: `6f0057b0-89fe-471f-8dbe-dc8b933cf1e1`.
- Install duration: 478.215 seconds; total build result: 496.014 seconds.
- Failure: `native-provider-transport_error`.
- Provider diagnostic: `execute`, HTTP 200, `UND_ERR_SOCKET`, step `install-recipe`.
- Positive deletion receipt: `bdop_627b1366eaba44ec87e3e2abdf76b73c`.
- Completed journal: allocation `deleted`, save `none`.
- Same-journal cleanup: success.
- Complete final Boat inventories: `sandboxes: []`, `snapshots: []`, `pages: 1`.
- A read of the deleted VM's command history returned HTTP 404.

Safe operations and original journals are retained locally under
`.audit/boat-long-command-transport-20261108/live-1/`. The credential was read only through the
production file loader in a mapped-root namespace. Its mode was temporarily tightened to 0400 and
restored to 0600. Its bytes were never printed, copied, or passed in an environment variable or
argument. No VM 131 writes occurred.

## Detached live acceptance

Source: `05ce0e85`, with the final detached implementation from `ac891ddb`. Subsequent #477 changes
only rename a test-local PID. The recovery layer changes failed-journal metadata, not this
successful construction path. The runner used the same 22-package Ubuntu recipe and pinned sealantd
next.180. It counted actual HTTP status requests with Node's undici diagnostics channel, without
recording headers, arguments, output or key bytes.

- Scratch VM: `bx_rg2a773m`, labelled `sealant-dev=boat-stream`.
- Build: `6c15cf4b-5974-4955-9f47-9719b41da71b`.
- Reserved publication: `5b3765e5-80be-402c-8039-ebff95a4e790`.
- `install-recipe`: 416.114 seconds, 380 status polls, exit code 0, `timedOut: false`.
- Build through ready saved publication: 465.794 seconds.
- Saved snapshot: `585ea12b-dc09-4b2e-aa09-4040c8be54b5`, subsequently deleted.
- Positive scratch deletion: `bdop_f2444f335d4c4ab1ab978467ab160706`.
- Final journal: phase `published`, allocation `deleted`, exact artifact removal `complete`.
- Artifact deletion and same-journal cleanup: success.
- Complete final inventories: `sandboxes: []`, `snapshots: []`, `pages: 1`.

Safe evidence is retained locally under `.audit/boat-detached-acceptance-20261108/live/`. The key
was read only by the production file loader, never printed, copied, or passed in an environment
variable or argument. Its original mode was restored. No VM 131 access, writes or third build.

A new Mend preview must bundle the changed sealant worker. The transport layer alone needs no
migration. The stacked [failed-build recovery](boat-failed-build-recovery.md) layer adds a migration
and restores ordinary acquisition for run 4's quarantined recipe without a manual DB reset. The real
session proof still gates admission; a successful native build adds no claim for readiness, resource
reach or stop/resume.
