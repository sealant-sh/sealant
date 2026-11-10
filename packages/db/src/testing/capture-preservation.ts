import { randomUUID } from "node:crypto";

import { nativePublicationSchema } from "@sealant/validators";
import { eq, sql } from "drizzle-orm";
import { Effect, Exit } from "effect";

import type { DB } from "../client.js";
import { markCurrentWriter } from "../repositories/workspace-capture-drains.js";
import {
  boatSnapshotAllowanceObservations,
  captureExecutorIncarnations as incarnations,
  captureParkingCloses as closes,
  capturePreservationOperations as operations,
  capturePreservationConsumers as consumers,
  capturePreservationReceipts as receipts,
  captureRecoveryCreates as creates,
  captureRecoveryArtifacts as artifacts,
  captureRetentionEpisodes as episodes,
  captureSandboxRemovals as removals,
} from "../schema/capture-preservation.js";
import { nativePublications, nativePublicationConsumers } from "../schema/native-publications.js";
import {
  workspaceCaptureDrains as roots,
  workspaceRuntimeInstances,
} from "../schema/workspace-build-jobs.js";

const hash = "a".repeat(64);

export const recordSettledParkingBoundary = (db: DB, runId: string) =>
  db.transaction((tx) =>
    Effect.gen(function* () {
      yield* markCurrentWriter(tx);
      yield* tx
        .update(roots)
        .set({
          lastStatus: {
            complete: false,
            incompleteReason: "ship-failed",
            pending: 1,
            fenced: false,
          },
          lastStatusAt: sql`now()`,
          lastStatusRecordedAt: sql`now()`,
          unreachableSince: null,
        })
        .where(eq(roots.runId, runId));
    }),
  );

export const seedUnattributedParkingReceipt = (
  db: DB,
  runId: string,
  operationId: string,
  sandboxId: string,
) =>
  db.transaction((tx) =>
    Effect.gen(function* () {
      yield* markCurrentWriter(tx);
      yield* tx.insert(receipts).values({
        runId,
        id: randomUUID(),
        operationId,
        sandboxId,
        kind: "removal-completed",
        digest: hash,
        observedAt: sql`now()`,
      });
    }),
  );

export const rejectsUnenrolledParkingPointer = (db: DB, runId: string) =>
  db.transaction((tx) =>
    Effect.gen(function* () {
      yield* markCurrentWriter(tx);
      const result = yield* tx
        .transaction((nested) =>
          nested
            .update(roots)
            .set({ currentIncarnationId: randomUUID() })
            .where(eq(roots.runId, runId)),
        )
        .pipe(Effect.exit);
      if (Exit.isSuccess(result))
        return yield* Effect.fail(
          new Error("unenrolled pointer accepted before deferred foreign key"),
        );
      return true;
    }),
  );

export const seedParkingSource = (db: DB, runId: string, retainedAt?: Date) =>
  Effect.gen(function* () {
    const publicationId = randomUUID();
    const buildId = randomUUID();
    const sandboxId = `bx_test_${randomUUID()}`;
    const runtime = {
      source: `ghcr.io/sealant-sh/sealantd-next:test@sha256:${hash}`,
      platform: "linux/amd64",
      manifest: hash,
      sealantd: hash,
      sealantctl: hash,
    };
    const publication = nativePublicationSchema.parse({
      kind: "boat-native",
      publicationId,
      snapshot: {
        kind: "boat-saved-snapshot",
        owner: publicationId,
        build: buildId,
        recipeHash: hash,
        receiptHash: hash,
        runtime,
        identity: {
          name: `fixture-${publicationId}`,
          sourceSandboxId: "bx_23456789",
          createdAt: "2026-11-05T00:00:00Z",
          snapshotId: "fixture-image",
        },
      },
      evidence: {
        imageProbe: {
          version: 1,
          tools: {
            sudo: true,
            sudoSetuid: true,
            useradd: true,
            groupadd: true,
            setfacl: true,
            getfacl: true,
            setpriv: true,
          },
          sudoersMend: true,
          sudoersIncludesDir: true,
          noNewPrivileges: false,
          passwdWritable: true,
          mendGroup: "present",
          reservedIdsInUse: [],
          personEnv: true,
          sharedDirs: [],
          sealantd: null,
        },
        receiptHash: hash,
        receipt: "synthetic",
        runtime,
        assetsHash: hash,
        recipeHash: hash,
        daemonRecovery: "unknown",
        executorRecovery: "unverified",
      },
    });
    yield* db.insert(nativePublications).values({
      id: publicationId,
      buildId,
      keyHash: randomUUID(),
      keyPayload: {},
      deploymentId: "parking-test",
      scopeKind: "owner",
      scopeId: "synthetic",
      recipeHash: hash,
    });
    yield* db
      .insert(nativePublicationConsumers)
      .values({ runId, runtimeInstanceId: runId, publicationId, state: "retained" });
    yield* db.insert(workspaceRuntimeInstances).values({
      runId,
      adapter: "boat",
      status: "ready",
      resourceId: sandboxId,
      reference: sandboxId,
      publicationId,
      publication,
    });
    yield* db.insert(roots).values({
      runId,
      captureTokenSealed: "synthetic-sealed-value",
      ...(retainedAt === undefined ? {} : { retainedAt }),
    });
    return {
      runId,
      deploymentId: "parking-test",
      accountScope: `personal-test-${randomUUID()}`,
      sandboxId,
      diskBindingId: randomUUID(),
      allocationOperationId: randomUUID(),
      publicationId,
      captureLaunchId: randomUUID(),
      guestEpoch: randomUUID(),
      guestManifestHash: hash,
    };
  });

export const expireParkingClaim = (db: DB, runId: string) =>
  db.transaction((tx) =>
    Effect.gen(function* () {
      yield* markCurrentWriter(tx);
      yield* tx
        .update(roots)
        .set({ preservationClaimUntil: sql`now() - interval '1 second'` })
        .where(sql`${roots.runId} = ${runId} and ${roots.preservationClaimToken} is not null`);
    }),
  );

export const resetIssuedParkingOperation = (db: DB, operationId: string) =>
  db.transaction((tx) =>
    Effect.gen(function* () {
      yield* markCurrentWriter(tx);
      yield* tx
        .update(operations)
        .set({ state: "prepared", issuedAt: null, issuedFence: null })
        .where(eq(operations.id, operationId));
    }),
  );

export const backdateUnenrolledParkingRetention = (db: DB, runId: string) =>
  db
    .update(roots)
    .set({ retainedAt: sql`now() - interval '301 seconds'` })
    .where(sql`${roots.runId} = ${runId} and ${roots.custodyContract} is null`);

export const makeParkingActionDue = (db: DB, runId: string) =>
  db.transaction((tx) =>
    Effect.gen(function* () {
      yield* markCurrentWriter(tx);
      yield* tx
        .update(roots)
        .set({ nextPreservationActionAt: sql`now() - interval '1 second'` })
        .where(eq(roots.runId, runId));
    }),
  );

export const oldParkingWriter = (db: DB, runId: string, state: "stopped" | "gone" | "discarded") =>
  db.transaction((tx) =>
    Effect.gen(function* () {
      yield* tx.execute(sql`select set_config('sealant.capture_ledger', '2', true)`);
      yield* tx
        .update(roots)
        .set({ state, retainedAt: null, captureTokenSealed: null, retentionEpisodeId: null })
        .where(eq(roots.runId, runId));
    }),
  );

export const rewriteParkingSource = (db: DB, runId: string) =>
  db.transaction((tx) =>
    Effect.gen(function* () {
      yield* markCurrentWriter(tx);
      yield* tx
        .update(workspaceRuntimeInstances)
        .set({ resourceId: "different-sandbox" })
        .where(eq(workspaceRuntimeInstances.runId, runId));
    }),
  );

export const releaseParkingPublication = (db: DB, runId: string) =>
  db
    .update(nativePublicationConsumers)
    .set({ state: "released", releasedAt: sql`now()` })
    .where(eq(nativePublicationConsumers.runId, runId));

export const parkingRows = (db: DB, runId: string) =>
  Effect.gen(function* () {
    const [root] = yield* db.select().from(roots).where(eq(roots.runId, runId));
    const episode = yield* db.select().from(episodes).where(eq(episodes.runId, runId));
    const effects = yield* db.select().from(operations).where(eq(operations.runId, runId));
    const sources = yield* db.select().from(incarnations).where(eq(incarnations.runId, runId));
    const [pin] = yield* db
      .select()
      .from(nativePublicationConsumers)
      .where(eq(nativePublicationConsumers.runId, runId));
    return { root, episode, effects, sources, pin };
  });

export const seedIssuedParkingClose = (db: DB, runId: string) =>
  db.transaction((tx) =>
    Effect.gen(function* () {
      yield* markCurrentWriter(tx);
      const [root] = yield* tx.select().from(roots).where(eq(roots.runId, runId));
      const [source] = yield* tx.select().from(incarnations).where(eq(incarnations.runId, runId));
      const [episode] = yield* tx.select().from(episodes).where(eq(episodes.runId, runId));
      if (root === undefined || source === undefined || episode === undefined)
        throw new Error("parking fixture not enrolled");
      const id = randomUUID();
      yield* tx.insert(operations).values({
        runId,
        id,
        kind: "close-writer",
        episodeId: episode.id,
        incarnationId: source.id,
        state: "issued",
        requestDigest: hash,
        evidenceVersion: root.evidenceVersion,
        issuedFence: root.preservationClaimFence,
        issuedAt: sql`now()`,
        nextObservationAt: sql`now()`,
      });
      yield* tx.insert(closes).values({
        runId,
        operationId: id,
        diskBindingId: source.diskBindingId,
        guestEpoch: source.guestEpoch,
        guestManifestHash: source.guestManifestHash,
        policyRevision: episode.policyRevision,
      });
      return { operationId: id, sandboxId: source.sandboxId };
    }),
  );

export const seedParkingRemoval = (db: DB, runId: string, verified: boolean) =>
  db.transaction((tx) =>
    Effect.gen(function* () {
      yield* markCurrentWriter(tx);
      const [root] = yield* tx.select().from(roots).where(eq(roots.runId, runId));
      const [source] = yield* tx.select().from(incarnations).where(eq(incarnations.runId, runId));
      const [episode] = yield* tx.select().from(episodes).where(eq(episodes.runId, runId));
      if (root === undefined || source === undefined || episode === undefined)
        throw new Error("parking fixture not enrolled");
      const closeId = randomUUID();
      const artifactId = randomUUID();
      const id = randomUUID();
      const providerOperationId = `bdop_test_${randomUUID()}`;
      yield* tx.insert(operations).values({
        runId,
        id: closeId,
        kind: "close-writer",
        episodeId: episode.id,
        incarnationId: source.id,
        state: "settled",
        requestDigest: hash,
        evidenceVersion: root.evidenceVersion,
        issuedFence: 1,
        issuedAt: sql`now() - interval '2 seconds'`,
        settledAt: sql`now() - interval '1 second'`,
      });
      yield* tx.insert(closes).values({
        runId,
        operationId: closeId,
        diskBindingId: source.diskBindingId,
        guestEpoch: source.guestEpoch,
        guestManifestHash: source.guestManifestHash,
        policyRevision: episode.policyRevision,
      });
      yield* tx.insert(artifacts).values({
        runId,
        id: artifactId,
        episodeId: episode.id,
        sourceIncarnationId: source.id,
        accountScope: source.accountScope,
        name: `slnt-rp-${randomUUID()}`,
        snapshotId: "snapshot_exact",
        state: verified ? "verified" : "saving",
        ...(verified
          ? {
              closeReceiptId: randomUUID(),
              privateScopeReceiptId: randomUUID(),
              namespaceReceiptId: randomUUID(),
              capsuleVerificationReceiptId: randomUUID(),
              archiveHash: hash,
              archiveBytes: 1024,
              verifiedAt: sql`now()`,
            }
          : {}),
      });
      yield* tx.insert(operations).values({
        runId,
        id,
        kind: "remove-sandbox",
        episodeId: episode.id,
        incarnationId: source.id,
        state: "issued",
        requestDigest: hash,
        evidenceVersion: root.evidenceVersion,
        issuedFence: 1,
        issuedAt: sql`now()`,
        nextObservationAt: sql`now()`,
      });
      yield* tx.insert(removals).values({
        runId,
        operationId: id,
        sandboxId: source.sandboxId,
        basis: "verified-recovery-custody",
        artifactId,
        closeOperationId: closeId,
        resourceRevocationReceiptId: randomUUID(),
        providerOperationId,
      });
      return { operationId: id, providerOperationId, sandboxId: source.sandboxId };
    }),
  );

export const seedMissingParkingDetail = (db: DB, runId: string) =>
  db.transaction((tx) =>
    Effect.gen(function* () {
      yield* markCurrentWriter(tx);
      const [root] = yield* tx.select().from(roots).where(eq(roots.runId, runId));
      if (
        root?.currentIncarnationId === null ||
        root?.retentionEpisodeId === null ||
        root === undefined
      )
        throw new Error("parking fixture not enrolled");
      yield* tx.insert(operations).values({
        runId,
        id: randomUUID(),
        kind: "save-snapshot",
        episodeId: root.retentionEpisodeId,
        incarnationId: root.currentIncarnationId,
        requestDigest: hash,
        evidenceVersion: root.evidenceVersion,
      });
    }),
  );

export const seedParkingAllowance = (db: DB, accountScope: string, stale: boolean) =>
  db.insert(boatSnapshotAllowanceObservations).values({
    accountScope,
    included: 10,
    used: 12,
    extra: 2,
    extraDailyDollars: 0.112,
    observedAt: stale ? sql`now() - interval '301 seconds'` : sql`now()`,
  });

export const seedUnknownParkingRecovery = (db: DB, runId: string, removalOperationId: string) =>
  db.transaction((tx) =>
    Effect.gen(function* () {
      yield* markCurrentWriter(tx);
      const [root] = yield* tx.select().from(roots).where(eq(roots.runId, runId));
      const [artifact] = yield* tx.select().from(artifacts).where(eq(artifacts.runId, runId));
      if (
        root?.retentionEpisodeId === null ||
        root?.currentIncarnationId === null ||
        root === undefined ||
        artifact === undefined
      )
        throw new Error("missing recovery fixture");
      const id = randomUUID();
      const destinationIncarnationId = randomUUID();
      const destinationRuntimeInstanceId = randomUUID();
      yield* tx.insert(operations).values({
        runId,
        id,
        kind: "create-recovery",
        episodeId: root.retentionEpisodeId,
        incarnationId: root.currentIncarnationId,
        state: "unknown",
        requestDigest: hash,
        evidenceVersion: root.evidenceVersion,
        issuedAt: sql`now()`,
        issuedFence: 1,
        nextObservationAt: sql`now()`,
      });
      yield* tx.insert(creates).values({
        runId,
        operationId: id,
        artifactId: artifact.id,
        sourceRemovalOperationId: removalOperationId,
        destinationIncarnationId,
        destinationRuntimeInstanceId,
        createKey: randomUUID(),
      });
      yield* tx.insert(consumers).values({ runId, operationId: id, artifactId: artifact.id });
      return { operationId: id, destinationIncarnationId, destinationRuntimeInstanceId };
    }),
  );

export const seedHeldParkingChild = (
  db: DB,
  runId: string,
  reservation: {
    readonly operationId: string;
    readonly destinationIncarnationId: string;
    readonly destinationRuntimeInstanceId: string;
  },
) =>
  db.transaction((tx) =>
    Effect.gen(function* () {
      yield* markCurrentWriter(tx);
      const [parent] = yield* tx.select().from(incarnations).where(eq(incarnations.runId, runId));
      const [artifact] = yield* tx.select().from(artifacts).where(eq(artifacts.runId, runId));
      if (parent === undefined || artifact === undefined) throw new Error("missing child fixture");
      const sandboxId = `bx_child_${randomUUID()}`;
      yield* tx.insert(incarnations).values({
        runId,
        id: reservation.destinationIncarnationId,
        runtimeInstanceId: reservation.destinationRuntimeInstanceId,
        deploymentId: parent.deploymentId,
        accountScope: parent.accountScope,
        sandboxId,
        diskBindingId: randomUUID(),
        allocationOperationId: reservation.operationId,
        publicationId: parent.publicationId,
        captureLaunchId: parent.captureLaunchId,
        guestEpoch: randomUUID(),
        guestManifestHash: parent.guestManifestHash,
        parentIncarnationId: parent.id,
        sourceArtifactId: artifact.id,
      });
      return sandboxId;
    }),
  );
