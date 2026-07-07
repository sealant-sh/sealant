# Sealant — Engineering Roadmap

> **Status:** Working draft, 2026-07-07. This is the sequenced engineering plan for the product
> definition in `PRODUCT.md` ("what we will build and why"). Read that first; this file is the "in
> what order, and what exactly changes." Grounded in a code survey of the repo as of `v0.5.1`.
> `SEALANT-PLAN.md` §12 is superseded: its near-term items 1–3 (fluent SDK, run inspector read side,
> telemetry integrity) have shipped; item 4 (lifecycle close-out) is Milestone 1 here.

## Shape of the plan

Four milestones, each cut as a tagged minor release with a demo-able story. Sequencing logic:

1. **Lifecycle first** — smallest, fully self-contained, and it unblocks real self-hosting (today
   containers leak forever). Every primitive it needs already exists in the code as a private
   helper; this is wiring, not invention.
2. **Profiles second** — finishing profiles builds the _launch-time revision resolution + snapshot_
   machinery that context injection reuses. Doing profiles first means the context library lands on
   a proven path instead of inventing one.
3. **Context library in two halves** — author + inject first (useful on day one: hand-authored
   conventions injected into every run), capture second (the flywheel: runs producing context).
   Splitting them de-risks the injection mechanics before building extraction on top.

| Milestone                             | Release | Story                                                                                        |
| ------------------------------------- | ------- | -------------------------------------------------------------------------------------------- |
| M1 — Lifecycle close-out              | 0.6.0   | Workspaces stop, expire, and get reaped. Self-hosting doesn't leak.                          |
| M2 — Profiles, finished               | 0.7.0   | Launch from a profile. Reusable, versioned environments; snapshot-on-launch reproducibility. |
| M3 — Context library: author + inject | 0.8.0   | Agents boot warm. Hand-authored context, injected at launch, stamped into the record.        |
| M4 — Context capture: close the loop  | 0.9.0   | Runs produce context. The record becomes raw material for the library.                       |

---

## M1 — Workspace lifecycle close-out (0.6.0)

**Today:** `RuntimeAdapter` has only `supports()` + `launch()`
(`packages/workspaces/src/runtime/runtime-adapter.ts`). The SDK's `workspace.stop/restart/expire`
reject `SealantNotImplementedError` locally in the facade (`packages/sdk/src/facade/workspace.ts`).
No API endpoint exists. Nothing ever writes the (already-reserved) `"stopped"` status, and
`resolveWorkspaceStatus()` (`packages/workspaces/src/api/workspace.ts`) has no branch for it. The
container handle store is complete (`workspace_runtime_instances.resource_id`/`reference`), the
teardown primitive exists privately (`forceRemoveContainer` in `docker-runtime-adapter.ts`), and a
`setInterval` reaper pattern already runs in the worker (`apps/worker/src/workers/workspaces.ts`).

**Build, in order:**

1. **Adapter surface** — add `stop(input)` to `RuntimeAdapter`; Docker impl promotes the existing
   `forceRemoveContainer` / `inspectContainerState` privates. Workspaces are ephemeral, so stop =
   remove (`docker rm -f`), idempotent, error-tolerant. k8s/k3s adapters throw, same as `launch`.
2. **Status writes** — `WorkspaceRuntimeInstanceRepo` gains `markStopped` (+ `stopReason`:
   `user | expired | failed`); add the `"stopped"` branch to `resolveWorkspaceStatus()`; emit the
   already-reserved `runtime.stopped` event from `listWorkspaceEvents`.
3. **API** — `POST /v1/workspaces/:id/stop` and `POST /v1/workspaces/:id/restart` in
   `packages/api-contracts` + `apps/api/src/routes/workspaces/`. Restart = fresh container from the
   already-published image (no filesystem carry-over — that's the out-of-scope persistence work),
   recorded as a new attempt linked with the existing `restart`-style relation on
   `workspace_run_links`. Deterministic `sealant-<runId>` naming + find-or-adopt already make
   relaunch safe.
4. **SDK** — replace the three facade rejections with real effect ops
   (`packages/sdk/src/effect/operations.ts`); `expire(ttl)` sets the expiry column (below) rather
   than stopping inline.
5. **TTL + reaper** — `expiresAt` on `workspaces` (nullable; set from a new
   `SEALANT_WORKSPACE_DEFAULT_TTL` env or per-create override, in `packages/validators/src/env.ts`);
   a second reaper tick alongside the build-job reaper scans `listRunningDockerInstances` for
   expired/orphaned instances and stops them. Reuse the `swallowingFailure` cleanup idiom from
   `process-workspace-build-job.ts`.
6. **Web UI** — stop button on workspace list + detail (the docs page already notes "no stop/delete
   in UI" as a gap).

**Done when:** a self-host install can run for a week without accumulating dead containers; SDK
`stop/restart/expire` work end to end; `what-ships-today.md` moves lifecycle from Planned to
Shipped.

**Explicitly not in M1:** image/registry GC (nothing deletes published images today — worth a
follow-up issue, not a blocker), k8s adapters, `DELETE /workspaces/:id` (archival exists via
`archivedAt`; hard delete is a separate decision).

---

## M2 — Profiles, finished (0.7.0)

**Today:** the schema is rich and done — `profiles` / `profile_revisions` (version + fingerprint +
`configPatch: Partial<NewWorkspaceSpec>`) with child env/secret/SSH tables, and `ProfileRepo` has
the full transaction helpers (`createProfileRevisionGraph`, `setActiveProfileRevision`) — **with
zero non-test callers**. Only three credential-binding endpoints exist. Every profile UI page except
`$profileId/agents.tsx` renders hardcoded mock data; the create form has no submit handler.
`profileRevisionId` columns on workspaces/attempts are dead plumbing — nothing populates them, and
the `profileConfigSnapshot` column on `workspace_attempt_snapshots` is always NULL. A profile
contributes exactly one thing to a launch today: connected-account credential refs, via
`credentials.profileId`, reachable only from API/CLI.

**Build, in order:**

1. **Profile + revision CRUD API** — create/update/archive profile; create revision (env vars,
   secret bindings, SSH settings, `configPatch`); set active revision. The repo layer exists; this
   is contracts (`packages/api-contracts/src/core-api/profiles.ts`) + module + validators.
2. **Minimal secrets CRUD** — profile secret bindings are unusable without named secrets. `secrets`
   / `secret_versions` tables (AES-encrypted) exist; add create/list/rotate endpoints. Scope to what
   profile bindings need — full secrets management UX stays a later round.
3. **Launch wiring** (the heart of M2) — promote `profileId` to a first-class field on
   `createWorkspace` (today it hides inside `credentials`). In `workspaces.module.ts`: resolve the
   active revision → merge `configPatch` under the request spec (request wins) → apply env vars,
   secret bindings, SSH settings, credential bindings → pass `profileRevisionId` down to
   `createQueuedAttempt`/`createWorkspace` (the optional repo inputs already exist) → write the
   resolved profile config into `profileConfigSnapshot` in `setAttemptSnapshot`. While there, fix
   the snapshot to store genuinely distinct `userSpecPayload` vs `resolvedSpecPayload` (today all
   three columns get the same value).
4. **SDK + CLI** — `profile` option on `workspaces.create`; `sealant profiles create/edit` next to
   the existing `list`/`bind`.
5. **Web UI** — replace the mock list/detail/env/secrets/setup pages with live data; wire the
   create/edit forms; add a profile picker to the workspace launch form. Read `apps/web/DESIGN.md`
   first.

**Done when:** `launch = profile + per-run overrides` is real — a workspace created from a profile
carries `profileRevisionId` on its attempt, its snapshot shows the resolved config, and rerunning
from the snapshot reproduces the environment. Profiles UI moves Preview → Shipped.

**Decision to make early:** precedence rules when request spec and profile `configPatch` collide
(proposal: per-field request-wins, document in the contract). Repository profiles
(`repository_profiles`, the parallel richer family) stay dormant this round — user profiles only.

---

## M3 — Context library: author + inject (0.8.0)

**Today:** zero context-library code. The seams it needs all exist: the revision pattern to mirror
(`profiles`/`profile_revisions` — version, fingerprint, active-revision pointer), the provenance
slot (`workspace_attempt_snapshots`, alongside `profileConfigSnapshot`), file-into-workspace
mechanisms (git `sources.inputs`, `lifecycle.setup` steps run by `sealantd boot`, and post-launch
credential-file injection via `docker exec`), and the SDK lowering point (`CreateOptions` →
`buildCreateWorkspaceRequest` in `packages/sdk/src/internal/blueprint.ts`).

**Build, in order:**

1. **Design spike: injection mechanics** (timeboxed, before any schema lands) — decide how items
   materialize. Working proposal: write items as files into a well-known dir
   (`/workspace/.sealant/context/<slug>.md`) at launch, generalizing the credential-file injection
   path (post-launch `docker exec`, already proven) into a generic file-injection input on
   `RuntimeAdapterLaunchInput`; then per-harness adapters make the context _discoverable_ (e.g.
   reference from the harness's native memory file). Prompt-prepend stays a per-run option, not the
   primary mechanism. Output of the spike: a one-page decision note in `docs/`.
2. **Data model** — `context_items` (owner-scoped, slug, kind: `instruction | learning`, status,
   `activeRevisionId`) + `context_item_revisions` (version, fingerprint, body, `changeSummary`,
   provenance: nullable `sourceRunId`) + `context_sets` / members. Deliberately a mirror of the
   profiles pattern; reuse its repo-layer idioms.
3. **CRUD API + library UI** — author, edit (new revision), archive, browse/search; group into named
   context sets. This is the hand-authored half of the thesis and is independently useful.
4. **Injection** — `context` option on SDK `workspaces.create` (items and/or sets, optional revision
   pinning) → contract field → launch path resolves revisions, materializes files (per the spike),
   and stamps the resolved set into a new `contextConfigSnapshot` on `workspace_attempt_snapshots`.
   Profiles get a `contextSet` reference in their revision config so M2's launch wiring carries it
   automatically.
5. **Record provenance UI** — the run inspector shows "context injected: these N items at these
   revisions," linking back to the library. The record must show exactly what context produced the
   run — this is the reproducibility half of the promise.

**Done when:** `sealant.workspaces.create({repository, harness, context: ["backend-conventions"]})`
boots a harness that demonstrably knows the conventions, and the run record shows precisely which
context revisions were in play.

---

## M4 — Context capture: close the loop (0.9.0)

**Today (after M3):** context flows in but not out. Runs already end with a captured diff,
`changedFiles`, and full telemetry — the extraction raw material exists.

**Build, in order:**

1. **Harness-assisted capture** — opt-in flag on `harness.run()`: after the main prompt completes,
   run a capture pass ("write what you learned that a future run should know") whose output lands as
   a _draft_ context item revision with `sourceRunId` provenance. Draft, not live: capture quality
   will be uneven; a human promotes drafts to the active revision.
2. **Curation from the record** — in the run inspector, select from the record (a command, an
   explanation, a diff hunk) → "save as context item / new revision of existing item."
3. **Provenance both ways in the library UI** — for each item: which runs it came from, which runs
   used it. This is the visible proof of the flywheel.
4. **Per-run context overrides** — extra items on `harness.run()` itself (not just launch), for
   "this task needs this doc" without a new workspace.

**Done when:** the loop in `PRODUCT.md` is demo-able end to end: run → capture learning → inject
into next run → next run visibly benefits, all with provenance in the record.

---

## Cross-cutting rules (every milestone)

- **Truthfulness:** `apps/docs/contents/introduction/what-ships-today.md` is the single source of
  truth for shipped/preview/mock/planned and gets updated in the same PR that changes a surface's
  status.
- **Releases:** each milestone cuts a `vX.Y.0` tag (the tag drives images + npm). SDK/api-contracts
  changes ship with changesets so the CHANGELOGs stay honest.
- **No new scope from the out-of-scope list** (`PRODUCT.md`): no filesystem persistence, no
  interactive sessions, no k8s, no control-plane auth this round. If a milestone appears to need one
  of these, that's a design smell — stop and rethink.
- **Mock-data debt:** the repositories and registry UI mocks are not in these milestones, but no
  _new_ mock surfaces get added. New UI is wired or it doesn't merge.
