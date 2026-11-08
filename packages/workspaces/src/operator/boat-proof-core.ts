import { isDeepStrictEqual } from "node:util";

import {
  BoatAllocationRepo,
  BoatAllocationRepoLive,
  BoatExecutionRepo,
  BoatExecutionRepoLive,
  BoatTunnelRepo,
  boatTunnelRepoLayer,
  NativePublicationRepo,
  NativePublicationRepoLive,
  WorkspaceAttemptRepo,
  WorkspaceAttemptRepoLive,
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
import { BoatProofError, type BoatProofConfig, type ProofSession } from "./boat-live-check.js";

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
    boatTunnelRepoLayer,
    NativePublicationRepoLive,
    WorkspaceAttemptRepoLive,
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
    runtime: (session: ProofSession) =>
      runtime.runPromise(
        Effect.gen(function* () {
          if (session.sealantRunId === null) return undefined;
          const attempt = yield* (yield* WorkspaceAttemptRepo).getAttemptById(session.sealantRunId);
          if (attempt?.ownerUserId !== input.config.ownerId)
            return yield* Effect.fail(new BoatProofError("owner-mismatch"));
          const allocation = yield* (yield* BoatAllocationRepo).get(session.sealantRunId);
          if (allocation?.phase !== "bound" || allocation.target === null) return undefined;
          const target = allocation.target;
          if (target.deploymentId !== input.config.deploymentId)
            return yield* Effect.fail(new BoatProofError("deployment-mismatch"));
          const instance = yield* (yield* WorkspaceRuntimeInstanceRepo).getRuntimeInstanceByRunId(
            target.runId,
          );
          const execution = yield* (yield* BoatExecutionRepo).get(target.runId);
          const tunnel = yield* (yield* BoatTunnelRepo).get(target.runtimeInstanceId);
          const capture = yield* (yield* WorkspaceCaptureDrainRepo).getByRunId(target.runId);
          return {
            runId: target.runId,
            sandboxId: target.sandboxId,
            publicationId: target.sourceId,
            resourceSubnet: tunnel?.network?.subnet ?? null,
            ready:
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
              capture?.deletionState === "deleted" &&
              capture.custodyContract !== 3 &&
              tunnel?.released === true &&
              tunnel.removal?.completed === true &&
              isDeepStrictEqual(tunnel.binding.target, target),
          };
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
