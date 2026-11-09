import { isDeepStrictEqual } from "node:util";

import {
  BoatAllocationRepo,
  BoatAllocationRepoLive,
  BoatExecutionRepo,
  BoatExecutionRepoLive,
  BoatObservationRepo,
  BoatObservationRepoLive,
  BoatTunnelRepo,
  boatTunnelRepoLayer,
  NativePublicationRepo,
  NativePublicationRepoLive,
  WorkspaceAttemptRepo,
  WorkspaceAttemptRepoLive,
  WorkspaceRepo,
  WorkspaceRepoLive,
  WorkspaceBuildJobRepo,
  WorkspaceBuildJobRepoLive,
  WorkspaceCaptureDrainRepo,
  WorkspaceCaptureDrainRepoLive,
  WorkspaceRuntimeInstanceRepo,
  WorkspaceRuntimeInstanceRepoLive,
  makeSealantDBLayer,
} from "@sealant/db";
import { Effect, Layer, ManagedRuntime } from "effect";

import { BoatSnapshotBuilder } from "../images/boat/builder.js";
import { BoatNativeCatalog, boatNativeCatalogLayer } from "../images/boat/catalog.js";
import type { BoatApi } from "../runtime/boat/api.js";
import {
  BoatProofError,
  findProofFailure,
  type BoatProofConfig,
  type ProofSession,
  type BoatProofInventory,
} from "./boat-live-check.js";

/** A separate operator process, without a queue consumer or a guest-launch capability. */
export const makeBoatProofCore = (input: {
  readonly config: BoatProofConfig;
  readonly databaseUrl: string;
  readonly builderOwner: string;
  readonly journalDirectory: string;
  readonly api: BoatApi;
}) => {
  const DB = makeSealantDBLayer(input.databaseUrl);
  const Repos = Layer.mergeAll(
    BoatAllocationRepoLive,
    BoatExecutionRepoLive,
    BoatObservationRepoLive,
    boatTunnelRepoLayer,
    NativePublicationRepoLive,
    WorkspaceAttemptRepoLive,
    WorkspaceRepoLive,
    WorkspaceBuildJobRepoLive,
    WorkspaceCaptureDrainRepoLive,
    WorkspaceRuntimeInstanceRepoLive,
  ).pipe(Layer.provide(DB));
  const Catalog = boatNativeCatalogLayer({
    deploymentId: input.config.deploymentId,
    builder: new BoatSnapshotBuilder({
      api: input.api,
      owner: input.builderOwner,
      journalDirectory: input.journalDirectory,
    }),
  }).pipe(Layer.provide(DB));
  const runtime = ManagedRuntime.make(Layer.merge(Repos, Catalog));
  const publication = (publicationId: string) =>
    Effect.gen(function* () {
      const record = yield* (yield* NativePublicationRepo).get(publicationId);
      if (
        record?.publication === null ||
        record?.publication === undefined ||
        record.ownership.key.deploymentId !== input.config.deploymentId ||
        record.publication.snapshot.owner !== input.builderOwner
      )
        return yield* Effect.fail(new BoatProofError("publication-ownership"));
      return { ownership: record.ownership, publication: record.publication };
    });
  return {
    dispose: () => runtime.dispose(),
    publication: (session: ProofSession) =>
      runtime.runPromise(
        Effect.gen(function* () {
          if (session.sealantWorkspaceId === null) return undefined;
          const workspace = yield* (yield* WorkspaceRepo).getWorkspaceById(
            session.sealantWorkspaceId,
          );
          if (workspace?.ownerUserId !== input.config.ownerId)
            return yield* Effect.fail(new BoatProofError("owner-mismatch"));
          if (workspace.latestRunId === null) return undefined;
          const attempt = yield* (yield* WorkspaceAttemptRepo).getAttemptById(
            workspace.latestRunId,
          );
          if (attempt?.ownerUserId !== input.config.ownerId)
            return yield* Effect.fail(new BoatProofError("owner-mismatch"));
          const job = yield* (yield* WorkspaceBuildJobRepo).getLatestJobByRunId(
            workspace.latestRunId,
          );
          if (job?.publicationId == null) return undefined;
          const record = yield* (yield* NativePublicationRepo).get(job.publicationId);
          if (
            record === undefined ||
            record.ownership.key.deploymentId !== input.config.deploymentId ||
            record.ownership.key.scope.kind !== "owner" ||
            record.ownership.key.scope.ownerUserId !== input.config.ownerId
          )
            return yield* Effect.fail(new BoatProofError("publication-ownership"));
          if (["quarantined", "withdrawn", "superseded"].includes(record.state))
            return yield* Effect.fail(new BoatProofError("native-build-failed"));
          return {
            publicationId: record.ownership.publicationId,
            runId: workspace.latestRunId,
            ready: record.state === "ready",
          };
        }),
      ),
    failure: (session: ProofSession) =>
      findProofFailure(session, input.config.ownerId, {
        workspace: (id) =>
          runtime.runPromise(Effect.flatMap(WorkspaceRepo, (repo) => repo.getWorkspaceById(id))),
        attempt: (id) =>
          runtime.runPromise(
            Effect.flatMap(WorkspaceAttemptRepo, (repo) => repo.getAttemptById(id)),
          ),
        runtime: (runId) =>
          runtime.runPromise(
            Effect.flatMap(WorkspaceRuntimeInstanceRepo, (repo) =>
              repo.getRuntimeInstanceByRunId(runId),
            ),
          ),
      }),
    runtime: (session: ProofSession) =>
      runtime.runPromise(
        Effect.gen(function* () {
          if (session.sealantRunId === null) return undefined;
          const attempt = yield* (yield* WorkspaceAttemptRepo).getAttemptById(session.sealantRunId);
          if (attempt?.ownerUserId !== input.config.ownerId)
            return yield* Effect.fail(new BoatProofError("owner-mismatch"));
          const allocation = yield* (yield* BoatAllocationRepo).get(session.sealantRunId);
          if (
            allocation?.target == null ||
            !["bound", "deleting", "deleted"].includes(allocation.phase)
          )
            return undefined;
          const target = allocation.target;
          if (target.deploymentId !== input.config.deploymentId)
            return yield* Effect.fail(new BoatProofError("deployment-mismatch"));
          const instance = yield* (yield* WorkspaceRuntimeInstanceRepo).getRuntimeInstanceByRunId(
            target.runId,
          );
          const execution = yield* (yield* BoatExecutionRepo).get(target.runId);
          const tunnel = yield* (yield* BoatTunnelRepo).get(target.runtimeInstanceId);
          const capture = yield* (yield* WorkspaceCaptureDrainRepo).getByRunId(target.runId);
          // Closed means Boat said the VM is gone and every obligation of it was discharged.
          const observed = yield* (yield* BoatObservationRepo).get(target.runtimeInstanceId);
          return {
            runId: target.runId,
            sandboxId: target.sandboxId,
            publicationId: target.sourceId,
            resourceSubnet: tunnel?.network?.subnet ?? null,
            ready:
              allocation.phase === "bound" &&
              instance?.adapter === "boat" &&
              instance.resourceId === target.sandboxId &&
              instance.status === "ready" &&
              instance.stopReason === null &&
              execution?.phase === "running" &&
              isDeepStrictEqual(execution.target, target) &&
              isDeepStrictEqual(tunnel?.binding.target, target) &&
              execution.admission !== null &&
              execution.isolation !== undefined &&
              tunnel?.network !== undefined,
            closed:
              instance?.adapter === "boat" &&
              instance.resourceId === target.sandboxId &&
              instance.status === "stopped" &&
              instance.removedAt !== null &&
              capture?.custodyContract !== 3 &&
              tunnel?.released === true &&
              observed?.presence === "absent" &&
              observed.sandboxId === target.sandboxId &&
              isDeepStrictEqual(tunnel.binding.target, target),
          };
        }),
      ),
    accountInventory: (inventory: BoatProofInventory): Promise<BoatProofInventory> =>
      runtime.runPromise(
        Effect.gen(function* () {
          const repo = yield* NativePublicationRepo;
          const retainedSnapshots: { publicationId: string; name: string }[] = [];
          let after: string | undefined;
          for (let page = 0; page < 100; page++) {
            const records = yield* repo.candidates(
              {
                deploymentId: input.config.deploymentId,
                scope: { kind: "owner", ownerUserId: input.config.ownerId },
              },
              200,
              after,
            );
            for (const record of records) {
              const saved = record.publication?.snapshot;
              if (
                record.state !== "ready" ||
                saved?.owner !== input.builderOwner ||
                !inventory.snapshots.includes(saved.identity.name)
              )
                continue;
              const observed = yield* Effect.promise(() =>
                input.api.getSnapshot(saved.identity.name),
              );
              if (!observed.ok || observed.value.status !== "ready") continue;
              const { status: _status, ...identity } = observed.value;
              if (isDeepStrictEqual(identity, saved.identity))
                retainedSnapshots.push({
                  publicationId: record.ownership.publicationId,
                  name: saved.identity.name,
                });
            }
            if (records.length < 200) return { ...inventory, retainedSnapshots };
            after = records.at(-1)?.ownership.publicationId;
          }
          return yield* Effect.fail(new BoatProofError("publication-inventory-pagination"));
        }),
      ),
    snapshotName: (id: string) =>
      runtime.runPromise(
        publication(id).pipe(
          Effect.map((record) => {
            return record.publication.snapshot.identity.name;
          }),
        ),
      ),
    withdraw: (id: string) =>
      runtime.runPromise(
        Effect.gen(function* () {
          const record = yield* publication(id);
          yield* (yield* BoatNativeCatalog).withdraw(record.ownership);
        }),
      ),
  };
};
