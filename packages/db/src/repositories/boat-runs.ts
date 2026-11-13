import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  boatExecutionTargetSchema,
  boatRunInputSchema,
  boatRunIsolationSchema,
  boatRunSchema,
  nativeConsumerStateSchema,
  nativePublicationKeySchema,
  nativePublicationSchema,
  type BoatExecutionTarget,
  type BoatRun,
  type BoatRunInput,
  type BoatRunIsolation,
} from "@sealant/validators";
import { and, asc, eq, exists, gt, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";

import { SealantDB } from "../client.js";
import { boatAccounts } from "../schema/boat-accounts.js";
import { boatRuns, type BoatRunRow } from "../schema/boat-runs.js";
import { boatTunnels } from "../schema/boat-tunnels.js";
import { nativePublications, nativePublicationConsumers } from "../schema/native-publications.js";
import {
  workspaceCaptureDrains,
  workspaceRuntimeInstances,
  workspaceRuntimeInstanceStatusValues,
} from "../schema/workspace-build-jobs.js";
import { createWalletOf, installCreateWallet, recordedWallet } from "./boat-wallets.js";

/** Safe failure codes: no ciphertext, provider body or launch material. */
export class BoatRunStoreError extends Error {
  readonly _tag = "BoatRunStoreError";
  constructor(
    readonly code:
      | "unavailable"
      | "invalid-record"
      | "binding-conflict"
      | "pin-unavailable"
      | "stale-transition"
      | "run-stopped"
      | "target-conflict"
      | "account-unavailable",
  ) {
    super(`Boat run store: ${code}`);
  }
}

type Failing<A> = Effect.Effect<A, BoatRunStoreError>;

/**
 * The one row of a Boat run. Every transition is one guarded UPDATE: what must hold is in its WHERE
 * clause, so of two callers one writes and the other sees that it did not. Nothing here calls
 * Boat; every provider effect happens outside these statements. There is no delete, no reset and
 * no way to move a run to another VM.
 *
 * A transition fails `stale-transition` when its guard did not hold. Where an identical
 * transition already happened, it succeeds with the stored row.
 */
export interface BoatRunRepoService {
  readonly get: (runId: string) => Failing<BoatRun | undefined>;
  /**
   * The one run a deployment holds for a VM: `(deployment_id, sandbox_id)` is unique. What a caller
   * that knows only the VM reads, since the runtime row's `reference` is rewritten to
   * `boat:<sandbox>` and names no run.
   */
  readonly getBySandbox: (input: {
    readonly deploymentId: string;
    readonly sandboxId: string;
  }) => Failing<BoatRun | undefined>;
  /**
   * Which runs, of any deployment of this install, name a VM: what a caller that knows only the VM
   * reads to find the account whose key answers for it. Boat's VM ids are its own and unique, so
   * this is one run, or none; more than one is a conflict for the caller to refuse.
   */
  readonly locateSandbox: (sandboxId: string) => Failing<
    readonly {
      readonly runId: string;
      readonly deploymentId: string;
      readonly accountId: string | null;
    }[]
  >;
  readonly list: (input: {
    readonly deploymentId: string;
    readonly limit: number;
    readonly after?: string;
  }) => Failing<readonly string[]>;
  /**
   * The live runs of a deployment that hold a tunnel on one gateway host: bound, not launched
   * without resources, their run active, their tunnel reservation there unreleased. Ended runs are
   * never read, so a page costs the same however many runs the deployment has had. Same order and
   * cursor as `list`.
   */
  readonly listTunnelled: (input: {
    readonly deploymentId: string;
    readonly gatewayHostId: string;
    readonly limit: number;
    readonly after?: string;
  }) => Failing<readonly string[]>;
  /**
   * The runs of a deployment that hold a sealed bearer for a VM Boat may still have. Same order
   * and cursor as `list`.
   */
  readonly listBearing: (input: {
    readonly deploymentId: string;
    readonly limit: number;
    readonly after?: string;
  }) => Failing<readonly string[]>;
  /**
   * The runs whose create is not resolved: no VM on record and no absence committed (reserved,
   * issued, or held without a VM). Everything the VM sweep can change is one of them; a run with a
   * VM, and one Boat no longer has, is never read. Same order and cursor as `list`.
   */
  readonly listUnresolved: (input: {
    readonly deploymentId: string;
    readonly limit: number;
    readonly after?: string;
  }) => Failing<readonly string[]>;
  /**
   * The runs with something left to settle, which is everything the convergence sweep can change.
   * A run is one of them while any of these holds, each read from the column its own writer sets:
   *
   *  - Boat's absence of its VM is not committed (`absent_at` is null): it may hold a VM.
   *  - Its tunnel slot is not released (`boat_tunnels.released_at` is null).
   *  - Its publication pin is not released (`native_publication_consumers.state`).
   *  - Its stop is not recorded: its runtime row is stopping or failed, and not `stopped`.
   *  - It never had a VM and its capture record is not ended.
   *
   * A run with none of them is settled. An ended run that had a VM is never read again, however
   * many the deployment has had; of the ones that never had a VM, the capture record is read by
   * its key. Same order and cursor as `list`.
   */
  readonly listUnsettled: (input: {
    readonly deploymentId: string;
    readonly limit: number;
    readonly after?: string;
  }) => Failing<readonly string[]>;
  readonly isActive: (runId: string) => Failing<boolean>;
  /**
   * A live launch owns this run and its VM: its runtime row is pending and names a launch owner
   * whose lease has not lapsed (by the database clock). Sweeps leave it alone until the launch
   * finishes or its lease lapses; only then do they adopt it.
   */
  readonly launchInFlight: (runId: string) => Failing<boolean>;
  /**
   * How long ago create was issued, by the database's clock, in milliseconds. `undefined`: create
   * was never issued.
   */
  readonly createAgeMs: (runId: string) => Failing<number | undefined>;

  /**
   * Reserves the run's row, its key and its disk lineage, under the run's publication pin. A
   * second reservation of the same run returns the first; one that names another source or
   * workspace fails `binding-conflict`.
   */
  readonly reserve: (input: BoatRunInput, manifestDigest: string) => Failing<BoatRun>;
  /**
   * Whether a launch asks for exactly what the run was reserved for: the same deployment,
   * workspace, launch attempt, publication (its whole record), image scope, source kind and
   * resources. Retries may not substitute another source or run.
   */
  readonly sameLaunch: (input: BoatRunInput, manifestDigest: string) => Failing<boolean>;
  /**
   * Issues create: `create_issued_at` is the database's `now()`. Only the caller this succeeds
   * for may send create; everyone else only discovers, or replays under the same key.
   */
  readonly issueCreate: (runId: string) => Failing<BoatRun>;
  /** Records the VM Boat made, or one found carrying the run's labels. A run never changes VM. */
  readonly adopt: (runId: string, sandboxId: string) => Failing<BoatRun>;
  readonly hold: (
    runId: string,
    reason: NonNullable<BoatRun["heldReason"]>,
    conflictingSandboxes?: readonly string[],
  ) => Failing<BoatRun>;
  /**
   * Boat returned the exact labelled VM. `created`: Boat reported it past creation, so from now on
   * a 404 for it can only mean it is gone. Returns the stored row: an absence another observer
   * committed first stands.
   */
  readonly seen: (runId: string, sandboxId: string, created: boolean) => Failing<BoatRun>;
  /**
   * Boat answered a typed 404 for the VM. It is absence only for a VM seen past creation: without
   * that nothing is written. Returns the stored row; the first absence stands.
   */
  readonly recordNotFound: (runId: string, sandboxId: string) => Failing<BoatRun>;
  /**
   * Boat holds no VM for the run: create was never issued, or Boat definitively refused it under
   * the run's key. Only for a run with no VM on record.
   */
  readonly recordNeverCreated: (runId: string) => Failing<BoatRun>;
  /** Binds the VM's current boot as the run's target. Refused once the run is fenced or deleting. */
  readonly bind: (runId: string, target: BoatExecutionTarget) => Failing<BoatRun>;
  /** Reserves the bind exchange. A replay returns the first reservation, never a second key. */
  readonly beginExchange: (
    target: BoatExecutionTarget,
    exchange: {
      readonly exchangeId: string;
      readonly publicKey: string;
      readonly sealedExchange: string;
    },
  ) => Failing<BoatRun>;
  /** Seals the exchanged bearer and erases the exchange's private key. */
  readonly sealControl: (
    runId: string,
    exchangeId: string,
    sealedControl: string,
  ) => Failing<BoatRun>;
  /** Freezes the launch: its operation, digest and sealed material. Later calls change nothing. */
  readonly stage: (
    runId: string,
    admission: {
      readonly operationId: string;
      readonly epoch: number;
      readonly digest: string;
      readonly docker: boolean;
      readonly sealedLaunch: string;
    },
  ) => Failing<BoatRun>;
  /** Freezes the isolation receipts before the launch is pushed. Changed receipts never replace them. */
  readonly isolate: (runId: string, isolation: BoatRunIsolation) => Failing<BoatRun>;
  /** Issues the launch push. Refused once the run is fenced: fence and push compete on the row. */
  readonly issueLaunch: (runId: string) => Failing<BoatRun>;
  /** The agent acknowledged the launch. */
  readonly acceptLaunch: (runId: string) => Failing<BoatRun>;
  /**
   * Irreversible: nothing can start on the run's VM again. With no launch issued, nothing ever
   * ran on it, and the sealed bearer and launch are erased. With one issued, its daemon is left as
   * it is and its bearer kept, for FINAL. Returns the stored row, which says which.
   */
  readonly fence: (runId: string) => Failing<BoatRun>;

  /**
   * Claims the first DELETE for `claimMs`, by the database's clock: only for a run that is stopping
   * or failed, whose VM nothing can start on again. A VM never bound is fenced by the same
   * statement. `undefined`: another call holds the claim, Boat's deletion operation is on record,
   * or Boat no longer has the VM.
   */
  readonly claimDeletion: (runId: string, claimMs: number) => Failing<BoatRun | undefined>;
  /** Gives up a claim whose DELETE request ended without Boat's answer. Only its own claim. */
  readonly lapseDeletionClaim: (run: BoatRun) => Failing<void>;
  /**
   * Records Boat's deletion operation for the VM. One operation per VM: another id, or another
   * VM, fails `target-conflict`. `completed` records the operation's completion and the VM's absence in
   * the same statement. A row already absent is returned as it is.
   */
  readonly recordDeletion: (
    runId: string,
    operation: {
      readonly id: string;
      readonly sandboxId: string;
      readonly completed: boolean;
    },
  ) => Failing<BoatRun>;
}

/** A run has one row. This layer has no delete, replacement or release operation. */
export class BoatRunRepo extends Context.Service<BoatRunRepo, BoatRunRepoService>()(
  "@sealant/db/BoatRunRepo",
) {}

const stale = () => new BoatRunStoreError("stale-transition");
/**
 * What an absence writes: when and how sealant knows, and it clears the hold and the sealed launch.
 */
const absent = (basis: NonNullable<BoatRun["absentBasis"]>) => ({
  absentAt: sql`now()`,
  absentBasis: basis,
  heldReason: null,
  conflictingSandboxes: [],
  sealedLaunch: null,
  sealedExchange: null,
});

const make: Effect.Effect<BoatRunRepoService, never, SealantDB> = Effect.gen(function* () {
  const db = yield* SealantDB;
  const boundary = <A>(effect: Effect.Effect<A, unknown>): Failing<A> =>
    effect.pipe(
      Effect.mapError((error) =>
        error instanceof BoatRunStoreError ? error : new BoatRunStoreError("unavailable"),
      ),
    );
  // The wallet a run was made in is the account's to read (`boat-wallets.ts`), not the run's.
  const parsed = ({ boatWallet: _wallet, boatWalletState: _state, ...row }: BoatRunRow) =>
    Effect.try({
      try: () => boatRunSchema.parse(row),
      catch: () => new BoatRunStoreError("invalid-record"),
    });
  const one = (rows: readonly BoatRunRow[]) =>
    rows[0] === undefined ? Effect.succeed(undefined) : parsed(rows[0]);
  const get = Effect.fn("BoatRunRepo.get")(function* (runId: string) {
    return yield* one(yield* db.select().from(boatRuns).where(eq(boatRuns.runId, runId)));
  });
  const required = (runId: string) =>
    get(runId).pipe(
      Effect.flatMap((run) => (run === undefined ? Effect.fail(stale()) : Effect.succeed(run))),
    );
  /** The run's runtime row is Boat's own row for it. */
  const runtimeOf = (...conditions: Parameters<typeof and>) =>
    exists(
      db
        .select({ one: sql`1` })
        .from(workspaceRuntimeInstances)
        .where(
          and(
            eq(workspaceRuntimeInstances.runId, boatRuns.runId),
            eq(workspaceRuntimeInstances.adapter, "boat"),
            // The runtime row keeps the publication id as text.
            sql`${workspaceRuntimeInstances.publicationId} = ${boatRuns.publicationId}::text`,
            ...conditions,
          ),
        ),
    );
  /** A VM is deleted only for a run that is stopping or failed, and that names this VM. */
  const stopping = runtimeOf(
    eq(workspaceRuntimeInstances.resourceId, boatRuns.sandboxId),
    sql`(${workspaceRuntimeInstances.stopReason} is not null or ${workspaceRuntimeInstances.status} = 'failed')`,
  );
  /** Nothing can start on the VM again: never bound (the claim fences it), or fenced. */
  const cannotStart = or(isNull(boatRuns.target), isNotNull(boatRuns.fencedAt));
  const page = (input: { readonly limit: number }) =>
    Number.isInteger(input.limit) && input.limit >= 1 && input.limit <= 100
      ? Effect.void
      : Effect.fail(new BoatRunStoreError("invalid-record"));

  const getBySandbox = Effect.fn("BoatRunRepo.getBySandbox")(function* (
    input: Parameters<BoatRunRepoService["getBySandbox"]>[0],
  ) {
    return yield* one(
      yield* db
        .select()
        .from(boatRuns)
        .where(
          and(
            eq(boatRuns.deploymentId, input.deploymentId),
            eq(boatRuns.sandboxId, input.sandboxId),
          ),
        ),
    );
  });
  const locateSandbox = Effect.fn("BoatRunRepo.locateSandbox")(function* (sandboxId: string) {
    return yield* db
      .select({
        runId: boatRuns.runId,
        deploymentId: boatRuns.deploymentId,
        accountId: boatRuns.accountId,
      })
      .from(boatRuns)
      .where(eq(boatRuns.sandboxId, sandboxId))
      .limit(2);
  });
  const list = Effect.fn("BoatRunRepo.list")(function* (
    input: Parameters<BoatRunRepoService["list"]>[0],
    ...conditions: Parameters<typeof and>
  ) {
    yield* page(input);
    const rows = yield* db
      .select({ id: boatRuns.runId })
      .from(boatRuns)
      .where(
        and(
          eq(boatRuns.deploymentId, input.deploymentId),
          input.after === undefined ? undefined : gt(boatRuns.runId, input.after),
          ...conditions,
        ),
      )
      .orderBy(asc(boatRuns.runId))
      .limit(input.limit);
    return rows.map((row) => row.id);
  });
  const active = and(
    eq(workspaceRuntimeInstances.adapter, "boat"),
    inArray(workspaceRuntimeInstances.status, ["pending", "running", "ready"]),
    isNull(workspaceRuntimeInstances.stopReason),
  );
  const listTunnelled = Effect.fn("BoatRunRepo.listTunnelled")(function* (
    input: Parameters<BoatRunRepoService["listTunnelled"]>[0],
  ) {
    yield* page(input);
    const rows = yield* db
      .select({ id: boatRuns.runId })
      .from(boatRuns)
      .innerJoin(boatTunnels, eq(boatTunnels.runtimeInstanceId, boatRuns.runId))
      .innerJoin(workspaceRuntimeInstances, eq(workspaceRuntimeInstances.runId, boatRuns.runId))
      .where(
        and(
          eq(boatRuns.deploymentId, input.deploymentId),
          // Bound, and neither held, deleting nor gone.
          isNotNull(boatRuns.target),
          isNull(boatRuns.deletionClaimedAt),
          isNull(boatRuns.deletionOperationId),
          isNull(boatRuns.absentAt),
          isNull(boatRuns.resources),
          eq(boatTunnels.gatewayHostId, input.gatewayHostId),
          isNull(boatTunnels.releasedAt),
          // The same active run `isActive` reads.
          active,
          input.after === undefined ? undefined : gt(boatRuns.runId, input.after),
        ),
      )
      .orderBy(asc(boatRuns.runId))
      .limit(input.limit);
    return rows.map((row) => row.id);
  });
  const listUnsettled = Effect.fn("BoatRunRepo.listUnsettled")(function* (
    input: Parameters<BoatRunRepoService["listUnsettled"]>[0],
  ) {
    yield* page(input);
    // Five sets, each read through an index of its own and cut to a page before they are merged:
    // the page of their union is within the union of their pages. The first four read no settled
    // run; the last reads the runs that never had a VM.
    const paged = and(
      eq(boatRuns.deploymentId, input.deploymentId),
      input.after === undefined ? undefined : gt(boatRuns.runId, input.after),
    );
    const present = db
      .select({ id: boatRuns.runId })
      .from(boatRuns)
      .where(and(paged, isNull(boatRuns.absentAt)))
      .orderBy(asc(boatRuns.runId))
      .limit(input.limit);
    const tunnelled = db
      .select({ id: boatRuns.runId })
      .from(boatTunnels)
      .innerJoin(boatRuns, eq(boatRuns.runId, boatTunnels.runtimeInstanceId))
      .where(and(paged, isNull(boatTunnels.releasedAt)))
      .orderBy(asc(boatRuns.runId))
      .limit(input.limit);
    const pinned = db
      .select({ id: boatRuns.runId })
      .from(nativePublicationConsumers)
      .innerJoin(boatRuns, eq(boatRuns.runId, nativePublicationConsumers.runId))
      .where(and(paged, ne(nativePublicationConsumers.state, "released")))
      .orderBy(asc(boatRuns.runId))
      .limit(input.limit);
    const unstopped = db
      .select({ id: boatRuns.runId })
      .from(workspaceRuntimeInstances)
      .innerJoin(boatRuns, eq(boatRuns.runId, workspaceRuntimeInstances.runId))
      .where(
        and(
          paged,
          eq(workspaceRuntimeInstances.adapter, "boat"),
          // Every status but `stopped`, named so the (adapter, status) index reads them.
          inArray(
            workspaceRuntimeInstances.status,
            workspaceRuntimeInstanceStatusValues.filter((status) => status !== "stopped"),
          ),
          or(
            isNotNull(workspaceRuntimeInstances.stopReason),
            eq(workspaceRuntimeInstances.status, "failed"),
          ),
        ),
      )
      .orderBy(asc(boatRuns.runId))
      .limit(input.limit);
    const unended = db
      .select({ id: boatRuns.runId })
      .from(boatRuns)
      .where(
        and(
          paged,
          isNull(boatRuns.sandboxId),
          // Not what the sweep leaves a launch with no VM as: gone (discarded, if its owner
          // asked), not retained, its capture token cleared. Read as a value per run, by the
          // record's key: a join here is planned as a scan of every capture record there is.
          sql`(select ${workspaceCaptureDrains.retainedAt} is not null or ${workspaceCaptureDrains.captureTokenSealed} is not null or ${workspaceCaptureDrains.state} is distinct from (case when ${workspaceCaptureDrains.discardRequestedAt} is null then 'gone' else 'discarded' end) from ${workspaceCaptureDrains} where ${workspaceCaptureDrains.runId} = ${boatRuns.runId})`,
        ),
      )
      .orderBy(asc(boatRuns.runId))
      .limit(input.limit);
    const rows = yield* present
      .union(tunnelled)
      .union(pinned)
      .union(unstopped)
      .union(unended)
      .orderBy((fields) => asc(fields.id))
      .limit(input.limit);
    return rows.map((row) => row.id);
  });
  const isActive = Effect.fn("BoatRunRepo.isActive")(function* (runId: string) {
    const [row] = yield* db
      .select({ id: workspaceRuntimeInstances.runId })
      .from(workspaceRuntimeInstances)
      .where(and(eq(workspaceRuntimeInstances.runId, runId), active));
    return row !== undefined;
  });
  const launchInFlight = Effect.fn("BoatRunRepo.launchInFlight")(function* (runId: string) {
    const [row] = yield* db
      .select({ id: workspaceRuntimeInstances.runId })
      .from(workspaceRuntimeInstances)
      .where(
        and(
          eq(workspaceRuntimeInstances.runId, runId),
          eq(workspaceRuntimeInstances.status, "pending"),
          // Boat launches always name their owner; its lease is read by the database clock.
          isNotNull(workspaceRuntimeInstances.launchOwner),
          gt(workspaceRuntimeInstances.launchLeaseExpiresAt, sql`now()`),
        ),
      );
    return row !== undefined;
  });
  const createAgeMs = Effect.fn("BoatRunRepo.createAgeMs")(function* (runId: string) {
    const [row] = yield* db
      .select({
        age: sql<
          string | null
        >`(extract(epoch from (now() - ${boatRuns.createIssuedAt})) * 1000)::text`,
      })
      .from(boatRuns)
      .where(eq(boatRuns.runId, runId));
    return row?.age == null ? undefined : Number(row.age);
  });

  const reserve = Effect.fn("BoatRunRepo.reserve")(function* (
    raw: BoatRunInput,
    manifestDigest: string,
  ) {
    const input = yield* Effect.try({
      try: () => boatRunInputSchema.parse(raw),
      catch: () => new BoatRunStoreError("invalid-record"),
    });
    const { consumer, publication, scope } = input;
    return yield* db.transaction(() =>
      Effect.gen(function* () {
        // A run under a stored account takes its row first, the row the account's removal takes
        // `for update`: no run is reserved under an account whose removal was asked.
        if (input.accountId !== undefined) {
          const [account] = yield* db
            .select({
              deploymentId: boatAccounts.deploymentId,
              removalRequestedAt: boatAccounts.removalRequestedAt,
              organization: boatAccounts.boatOrganization,
              keyKind: boatAccounts.keyKind,
            })
            .from(boatAccounts)
            .where(eq(boatAccounts.id, input.accountId))
            .for("share");
          if (
            account === undefined ||
            account.removalRequestedAt !== null ||
            account.deploymentId !== input.deploymentId
          )
            return yield* Effect.fail(new BoatRunStoreError("account-unavailable"));
        }
        // The wallet the run's VM is created in, and that every request about it names: the
        // account's pin, read under the row its wallet change takes `for update` (the install's own
        // key's from `boat_install`). An account whose wallet sealant has not resolved creates nothing.
        const wallet =
          input.accountId === undefined
            ? yield* installCreateWallet(db, input.deploymentId)
            : yield* Effect.map(
                db
                  .select({
                    organization: boatAccounts.boatOrganization,
                    keyKind: boatAccounts.keyKind,
                  })
                  .from(boatAccounts)
                  .where(eq(boatAccounts.id, input.accountId)),
                ([row]) => createWalletOf(row?.organization ?? null, row?.keyKind ?? null),
              );
        if (wallet.kind === "unresolved")
          return yield* Effect.fail(new BoatRunStoreError("account-unavailable"));
        // The catalog uses this same lock order for release and retirement.
        const [owner] = yield* db
          .select()
          .from(nativePublications)
          .where(eq(nativePublications.id, publication.publicationId))
          .for("update");
        const [pin] = yield* db
          .select()
          .from(nativePublicationConsumers)
          .where(
            and(
              eq(nativePublicationConsumers.runId, consumer.runId),
              eq(nativePublicationConsumers.runtimeInstanceId, consumer.runtimeInstanceId),
            ),
          )
          .for("update");
        if (
          owner === undefined ||
          pin === undefined ||
          owner.state !== "ready" ||
          !nativeConsumerStateSchema.safeParse(pin.state).success ||
          pin.state === "released" ||
          pin.publicationId !== publication.publicationId ||
          owner.deploymentId !== input.deploymentId ||
          !isDeepStrictEqual(
            nativePublicationSchema.safeParse(owner.publication).data,
            publication,
          ) ||
          !isDeepStrictEqual(
            nativePublicationKeySchema.safeParse(owner.keyPayload).data?.scope,
            scope,
          )
        )
          return yield* Effect.fail(new BoatRunStoreError("pin-unavailable"));
        // The VM is created from the image's snapshot, which Boat finds only in the wallet the image
        // was made in: an image of another wallet (the account's changed since it was acquired) is
        // not this run's; the launch acquires one in the run's wallet.
        if (
          owner.boatWalletState === "known" &&
          wallet.kind === "known" &&
          owner.boatWallet !== wallet.wallet
        )
          return yield* Effect.fail(new BoatRunStoreError("pin-unavailable"));
        yield* db
          .insert(boatRuns)
          .values({
            runId: consumer.runId,
            deploymentId: input.deploymentId,
            accountId: input.accountId ?? null,
            publicationId: publication.publicationId,
            workspaceId: input.workspaceId,
            launchAttemptId: input.launchAttemptId,
            manifestDigest,
            snapshotName: publication.snapshot.identity.name,
            resources: input.resources ?? null,
            idempotencyKey: randomUUID(),
            diskLineage: randomUUID(),
            ...recordedWallet(wallet),
          })
          .onConflictDoNothing();
        const saved = yield* get(consumer.runId);
        // Retries may not substitute another source, workspace or launch.
        if (
          saved === undefined ||
          saved.deploymentId !== input.deploymentId ||
          saved.accountId !== (input.accountId ?? null) ||
          saved.publicationId !== publication.publicationId ||
          saved.workspaceId !== input.workspaceId ||
          saved.launchAttemptId !== input.launchAttemptId ||
          saved.manifestDigest !== manifestDigest ||
          saved.snapshotName !== publication.snapshot.identity.name ||
          saved.resources !== (input.resources ?? null)
        )
          return yield* Effect.fail(new BoatRunStoreError("binding-conflict"));
        // The worker records its selected adapter before dispatch. A matching pending row is
        // deliberately a no-op here: never overwrite its launch lease or repair a foreign binding.
        yield* db
          .insert(workspaceRuntimeInstances)
          .values({
            runId: consumer.runId,
            adapter: "boat",
            status: "pending",
            publicationId: publication.publicationId,
            publication,
            imageScope: scope,
            sourceKind: input.sourceKind,
            daemonImage: publication.evidence.runtime.source,
            daemonRecoveryBoot: publication.evidence.daemonRecovery === "supported",
          })
          .onConflictDoNothing();
        const [runtime] = yield* db
          .select()
          .from(workspaceRuntimeInstances)
          .where(eq(workspaceRuntimeInstances.runId, consumer.runId))
          .for("update");
        if (
          runtime === undefined ||
          runtime.adapter !== "boat" ||
          runtime.publicationId !== publication.publicationId ||
          !isDeepStrictEqual(runtime.publication, publication) ||
          !isDeepStrictEqual(runtime.imageScope, scope) ||
          runtime.sourceKind !== input.sourceKind ||
          runtime.resourceId !== saved.sandboxId
        )
          return yield* Effect.fail(new BoatRunStoreError("binding-conflict"));
        return saved;
      }),
    );
  });
  const sameLaunch = Effect.fn("BoatRunRepo.sameLaunch")(function* (
    input: BoatRunInput,
    manifestDigest: string,
  ) {
    const { consumer, publication } = input;
    const saved = yield* get(consumer.runId);
    // The publication's whole record, its scope and its source kind were frozen on the run's
    // runtime row when the run was reserved.
    const [runtime] = yield* db
      .select()
      .from(workspaceRuntimeInstances)
      .where(eq(workspaceRuntimeInstances.runId, consumer.runId));
    return (
      saved !== undefined &&
      runtime !== undefined &&
      saved.deploymentId === input.deploymentId &&
      saved.accountId === (input.accountId ?? null) &&
      saved.publicationId === publication.publicationId &&
      saved.workspaceId === input.workspaceId &&
      saved.launchAttemptId === input.launchAttemptId &&
      saved.manifestDigest === manifestDigest &&
      saved.snapshotName === publication.snapshot.identity.name &&
      saved.resources === (input.resources ?? null) &&
      runtime.adapter === "boat" &&
      isDeepStrictEqual(runtime.publication, publication) &&
      isDeepStrictEqual(runtime.imageScope, input.scope) &&
      runtime.sourceKind === input.sourceKind
    );
  });
  const issueCreate = Effect.fn("BoatRunRepo.issueCreate")(function* (runId: string) {
    return yield* db.transaction(() =>
      Effect.gen(function* () {
        const before = yield* required(runId);
        const [source] = yield* db
          .select()
          .from(nativePublications)
          .where(eq(nativePublications.id, before.publicationId))
          .for("update");
        if (
          source === undefined ||
          source.state !== "ready" ||
          nativePublicationSchema.safeParse(source.publication).data?.snapshot.identity.name !==
            before.snapshotName
        )
          return yield* Effect.fail(new BoatRunStoreError("pin-unavailable"));
        const issued = yield* one(
          yield* db
            .update(boatRuns)
            .set({ createIssuedAt: sql`now()` })
            .where(
              and(
                eq(boatRuns.runId, runId),
                isNull(boatRuns.createIssuedAt),
                isNull(boatRuns.sandboxId),
                isNull(boatRuns.heldReason),
                isNull(boatRuns.absentAt),
                // Create is issued only for a launch still pending and not asked to stop.
                runtimeOf(
                  eq(workspaceRuntimeInstances.status, "pending"),
                  isNull(workspaceRuntimeInstances.stopReason),
                  isNull(workspaceRuntimeInstances.resourceId),
                ),
              ),
            )
            .returning(),
        );
        if (issued !== undefined) return issued;
        const [runtime] = yield* db
          .select()
          .from(workspaceRuntimeInstances)
          .where(eq(workspaceRuntimeInstances.runId, runId));
        return yield* Effect.fail(
          before.createIssuedAt === null &&
            before.heldReason === null &&
            before.absentAt === null &&
            !(
              runtime?.adapter === "boat" &&
              runtime.status === "pending" &&
              runtime.stopReason === null
            )
            ? new BoatRunStoreError("run-stopped")
            : stale(),
        );
      }),
    );
  });
  const adopt = Effect.fn("BoatRunRepo.adopt")(function* (runId: string, sandboxId: string) {
    return yield* db.transaction(() =>
      Effect.gen(function* () {
        const adopted = yield* one(
          yield* db
            .update(boatRuns)
            .set({ sandboxId, heldReason: null })
            .where(
              and(
                eq(boatRuns.runId, runId),
                isNull(boatRuns.sandboxId),
                isNotNull(boatRuns.createIssuedAt),
                isNull(boatRuns.absentAt),
                // Only an unresolved create is ever adopted from held, when discovery finds its VM.
                or(isNull(boatRuns.heldReason), eq(boatRuns.heldReason, "create-unresolved")),
              ),
            )
            .returning(),
        );
        if (adopted === undefined) return yield* Effect.fail(stale());
        const projected = yield* db
          .update(workspaceRuntimeInstances)
          .set({ resourceId: sandboxId, reference: `boat:${sandboxId}` })
          .where(
            and(
              eq(workspaceRuntimeInstances.runId, runId),
              eq(workspaceRuntimeInstances.adapter, "boat"),
              eq(workspaceRuntimeInstances.publicationId, adopted.publicationId),
              isNull(workspaceRuntimeInstances.resourceId),
            ),
          )
          .returning({ runId: workspaceRuntimeInstances.runId });
        if (projected.length === 0) return yield* Effect.fail(new BoatRunStoreError("run-stopped"));
        return adopted;
      }),
    );
  });
  const hold = Effect.fn("BoatRunRepo.hold")(function* (
    runId: string,
    reason: NonNullable<BoatRun["heldReason"]>,
    conflictingSandboxes: readonly string[] = [],
  ) {
    const held = yield* one(
      yield* db
        .update(boatRuns)
        .set({ heldReason: reason, conflictingSandboxes: [...conflictingSandboxes] })
        .where(
          and(
            eq(boatRuns.runId, runId),
            isNull(boatRuns.heldReason),
            isNull(boatRuns.absentAt),
            isNull(boatRuns.target),
            isNull(boatRuns.deletionClaimedAt),
            isNull(boatRuns.deletionOperationId),
            reason === "lifetime-unverified"
              ? isNotNull(boatRuns.sandboxId)
              : isNull(boatRuns.sandboxId),
            reason === "run-stopped"
              ? isNull(boatRuns.createIssuedAt)
              : isNotNull(boatRuns.createIssuedAt),
          ),
        )
        .returning(),
    );
    return held ?? (yield* Effect.fail(stale()));
  });
  const seen = Effect.fn("BoatRunRepo.seen")(function* (
    runId: string,
    sandboxId: string,
    created: boolean,
  ) {
    if (created)
      yield* db
        .update(boatRuns)
        .set({ createdSeenAt: sql`now()` })
        .where(
          and(
            eq(boatRuns.runId, runId),
            eq(boatRuns.sandboxId, sandboxId),
            isNull(boatRuns.createdSeenAt),
            isNull(boatRuns.absentAt),
          ),
        );
    const run = yield* get(runId);
    if (run === undefined || run.sandboxId !== sandboxId)
      return yield* Effect.fail(new BoatRunStoreError("target-conflict"));
    return run;
  });
  const recordNotFound = Effect.fn("BoatRunRepo.recordNotFound")(function* (
    runId: string,
    sandboxId: string,
  ) {
    yield* db
      .update(boatRuns)
      .set(absent("not-found"))
      .where(
        and(
          eq(boatRuns.runId, runId),
          eq(boatRuns.sandboxId, sandboxId),
          isNull(boatRuns.absentAt),
          // A 404 is absence only for a VM Boat had reported past creation.
          isNotNull(boatRuns.createdSeenAt),
        ),
      );
    const run = yield* get(runId);
    if (run === undefined || run.sandboxId !== sandboxId)
      return yield* Effect.fail(new BoatRunStoreError("target-conflict"));
    return run;
  });
  const recordNeverCreated = Effect.fn("BoatRunRepo.recordNeverCreated")(function* (runId: string) {
    yield* db
      .update(boatRuns)
      .set(absent("never-created"))
      .where(and(eq(boatRuns.runId, runId), isNull(boatRuns.sandboxId), isNull(boatRuns.absentAt)));
    const run = yield* get(runId);
    if (run?.absentBasis !== "never-created") return yield* Effect.fail(stale());
    return run;
  });

  const bind = Effect.fn("BoatRunRepo.bind")(function* (runId: string, raw: BoatExecutionTarget) {
    const target = yield* Effect.try({
      try: () => boatExecutionTargetSchema.parse(raw),
      catch: () => new BoatRunStoreError("invalid-record"),
    });
    const bound = yield* one(
      yield* db
        .update(boatRuns)
        .set({ target })
        .where(
          and(
            eq(boatRuns.runId, runId),
            eq(boatRuns.sandboxId, target.sandboxId),
            isNull(boatRuns.target),
            isNull(boatRuns.fencedAt),
            isNull(boatRuns.heldReason),
            isNull(boatRuns.deletionClaimedAt),
            isNull(boatRuns.deletionOperationId),
            isNull(boatRuns.absentAt),
            runtimeOf(eq(workspaceRuntimeInstances.resourceId, boatRuns.sandboxId)),
          ),
        )
        .returning(),
    );
    if (bound !== undefined) return bound;
    const saved = yield* required(runId);
    if (isDeepStrictEqual(saved.target, target)) return saved;
    return yield* Effect.fail(stale());
  });
  const beginExchange = Effect.fn("BoatRunRepo.beginExchange")(function* (
    target: BoatExecutionTarget,
    exchange: Parameters<BoatRunRepoService["beginExchange"]>[1],
  ) {
    yield* db
      .update(boatRuns)
      .set({
        exchangeId: exchange.exchangeId,
        exchangePublicKey: exchange.publicKey,
        sealedExchange: exchange.sealedExchange,
      })
      .where(
        and(
          eq(boatRuns.runId, target.runId),
          sql`${boatRuns.target} = ${JSON.stringify(target)}::jsonb`,
          isNull(boatRuns.exchangeId),
          isNull(boatRuns.fencedAt),
        ),
      );
    const saved = yield* get(target.runId);
    if (saved === undefined || !isDeepStrictEqual(saved.target, target))
      return yield* Effect.fail(new BoatRunStoreError("target-conflict"));
    return saved;
  });
  const sealControl = Effect.fn("BoatRunRepo.sealControl")(function* (
    runId: string,
    exchangeId: string,
    sealedControl: string,
  ) {
    const sealed = yield* one(
      yield* db
        .update(boatRuns)
        .set({ sealedControl, sealedExchange: null })
        .where(
          and(
            eq(boatRuns.runId, runId),
            eq(boatRuns.exchangeId, exchangeId),
            isNull(boatRuns.sealedControl),
            isNotNull(boatRuns.sealedExchange),
            isNull(boatRuns.fencedAt),
          ),
        )
        .returning(),
    );
    if (sealed !== undefined) return sealed;
    const saved = yield* required(runId);
    // A concurrent exact transition is successful; randomized encryption is compared by its caller.
    if (saved.sealedControl === sealedControl) return saved;
    return yield* Effect.fail(stale());
  });
  const stage = Effect.fn("BoatRunRepo.stage")(function* (
    runId: string,
    admission: Parameters<BoatRunRepoService["stage"]>[1],
  ) {
    const staged = yield* one(
      yield* db
        .update(boatRuns)
        .set({
          admissionOperationId: admission.operationId,
          admissionEpoch: admission.epoch,
          admissionDigest: admission.digest,
          docker: admission.docker,
          sealedLaunch: admission.sealedLaunch,
        })
        .where(
          and(
            eq(boatRuns.runId, runId),
            isNotNull(boatRuns.sealedControl),
            isNull(boatRuns.admissionOperationId),
            isNull(boatRuns.fencedAt),
          ),
        )
        .returning(),
    );
    return staged ?? (yield* Effect.fail(stale()));
  });
  const isolate = Effect.fn("BoatRunRepo.isolate")(function* (
    runId: string,
    raw: BoatRunIsolation,
  ) {
    const isolation = yield* Effect.try({
      try: () => boatRunIsolationSchema.parse(raw),
      catch: () => new BoatRunStoreError("invalid-record"),
    });
    const isolated = yield* one(
      yield* db
        .update(boatRuns)
        .set({ isolation })
        .where(
          and(
            eq(boatRuns.runId, runId),
            isNull(boatRuns.isolation),
            isNotNull(boatRuns.admissionOperationId),
            isNull(boatRuns.fencedAt),
          ),
        )
        .returning(),
    );
    if (isolated !== undefined) return isolated;
    const saved = yield* required(runId);
    if (saved.fencedAt === null && isDeepStrictEqual(saved.isolation, isolation)) return saved;
    return yield* Effect.fail(stale());
  });
  const issueLaunch = Effect.fn("BoatRunRepo.issueLaunch")(function* (runId: string) {
    const issued = yield* one(
      yield* db
        .update(boatRuns)
        .set({ launchIssuedAt: sql`now()` })
        .where(
          and(
            eq(boatRuns.runId, runId),
            isNull(boatRuns.launchIssuedAt),
            isNull(boatRuns.fencedAt),
            isNotNull(boatRuns.sealedLaunch),
            isNotNull(boatRuns.isolation),
          ),
        )
        .returning(),
    );
    return issued ?? (yield* Effect.fail(stale()));
  });
  const acceptLaunch = Effect.fn("BoatRunRepo.acceptLaunch")(function* (runId: string) {
    const accepted = yield* one(
      yield* db
        .update(boatRuns)
        .set({ launchAcceptedAt: sql`now()` })
        .where(
          and(
            eq(boatRuns.runId, runId),
            isNotNull(boatRuns.launchIssuedAt),
            isNull(boatRuns.launchAcceptedAt),
            isNull(boatRuns.fencedAt),
          ),
        )
        .returning(),
    );
    if (accepted !== undefined) return accepted;
    const saved = yield* required(runId);
    if (saved.launchAcceptedAt !== null && saved.fencedAt === null) return saved;
    return yield* Effect.fail(stale());
  });
  const fence = Effect.fn("BoatRunRepo.fence")(function* (runId: string) {
    const unlaunched = sql`${boatRuns.launchIssuedAt} is null`;
    const fenced = yield* one(
      yield* db
        .update(boatRuns)
        .set({
          fencedAt: sql`coalesce(${boatRuns.fencedAt}, now())`,
          sealedExchange: null,
          // A launch never pushed is never pushed now: its bearer and its material have no use.
          sealedControl: sql`case when ${unlaunched} then null else ${boatRuns.sealedControl} end`,
          sealedLaunch: sql`case when ${unlaunched} then null else ${boatRuns.sealedLaunch} end`,
        })
        .where(eq(boatRuns.runId, runId))
        .returning(),
    );
    return fenced ?? (yield* Effect.fail(stale()));
  });

  const claimDeletion = Effect.fn("BoatRunRepo.claimDeletion")(function* (
    runId: string,
    claimMs: number,
  ) {
    const claimed = yield* one(
      yield* db
        .update(boatRuns)
        .set({
          // Milliseconds, so the claim reads back exactly and only its holder can give it up.
          deletionClaimedAt: sql`date_trunc('milliseconds', now())`,
          fencedAt: sql`coalesce(${boatRuns.fencedAt}, now())`,
          heldReason: null,
          conflictingSandboxes: [],
        })
        .where(
          and(
            eq(boatRuns.runId, runId),
            isNotNull(boatRuns.sandboxId),
            isNull(boatRuns.absentAt),
            isNull(boatRuns.deletionOperationId),
            sql`(${boatRuns.deletionClaimedAt} is null or ${boatRuns.deletionClaimedAt} <= now() - ${claimMs} * interval '1 millisecond')`,
            cannotStart,
            stopping,
          ),
        )
        .returning(),
    );
    if (claimed !== undefined) return claimed;
    const [state] = yield* db
      .select({
        // Another call's live claim, its recorded operation or Boat's absence.
        taken: sql<boolean>`(${boatRuns.absentAt} is not null or ${boatRuns.deletionOperationId} is not null or coalesce(${boatRuns.deletionClaimedAt} > now() - ${claimMs} * interval '1 millisecond', false))`,
        startable: sql<boolean>`(${boatRuns.target} is not null and ${boatRuns.fencedAt} is null)`,
      })
      .from(boatRuns)
      .where(eq(boatRuns.runId, runId));
    if (state === undefined) return yield* Effect.fail(stale());
    // This call sends nothing: the claimant's DELETE, its operation or the absence decides.
    if (state.taken) return undefined;
    return yield* Effect.fail(
      new BoatRunStoreError(state.startable ? "binding-conflict" : "run-stopped"),
    );
  });
  const lapseDeletionClaim = Effect.fn("BoatRunRepo.lapseDeletionClaim")(function* (run: BoatRun) {
    if (run.deletionClaimedAt === null) return;
    yield* db
      .update(boatRuns)
      .set({ deletionClaimedAt: new Date(0) })
      .where(
        and(
          eq(boatRuns.runId, run.runId),
          eq(boatRuns.deletionClaimedAt, run.deletionClaimedAt),
          isNull(boatRuns.deletionOperationId),
          isNull(boatRuns.absentAt),
        ),
      );
  });
  const recordDeletion = Effect.fn("BoatRunRepo.recordDeletion")(function* (
    runId: string,
    operation: Parameters<BoatRunRepoService["recordDeletion"]>[1],
  ) {
    const recorded = yield* one(
      yield* db
        .update(boatRuns)
        .set({
          deletionOperationId: operation.id,
          heldReason: null,
          conflictingSandboxes: [],
          // Boat's own completed deletion of this exact VM is its absence: one statement.
          ...(operation.completed
            ? { ...absent("deletion-completed"), deletionCompletedAt: sql`now()` }
            : {}),
        })
        .where(
          and(
            eq(boatRuns.runId, runId),
            eq(boatRuns.sandboxId, operation.sandboxId),
            isNull(boatRuns.absentAt),
            or(
              isNull(boatRuns.deletionOperationId),
              eq(boatRuns.deletionOperationId, operation.id),
            ),
            cannotStart,
            stopping,
          ),
        )
        .returning(),
    );
    if (recorded !== undefined) return recorded;
    const saved = yield* required(runId);
    if (saved.sandboxId !== operation.sandboxId)
      return yield* Effect.fail(new BoatRunStoreError("target-conflict"));
    // Another pass already recorded Boat's absence of it.
    if (saved.absentAt !== null) return saved;
    if (saved.deletionOperationId !== null && saved.deletionOperationId !== operation.id)
      return yield* Effect.fail(new BoatRunStoreError("target-conflict"));
    return yield* Effect.fail(
      saved.target !== null && saved.fencedAt === null
        ? new BoatRunStoreError("binding-conflict")
        : new BoatRunStoreError("run-stopped"),
    );
  });

  return BoatRunRepo.of({
    get: (runId) => boundary(get(runId)),
    getBySandbox: (input) => boundary(getBySandbox(input)),
    locateSandbox: (sandboxId) => boundary(locateSandbox(sandboxId)),
    list: (input) => boundary(list(input)),
    listTunnelled: (input) => boundary(listTunnelled(input)),
    listBearing: (input) =>
      boundary(list(input, isNotNull(boatRuns.sealedControl), isNull(boatRuns.absentAt))),
    listUnresolved: (input) =>
      boundary(list(input, isNull(boatRuns.sandboxId), isNull(boatRuns.absentAt))),
    listUnsettled: (input) => boundary(listUnsettled(input)),
    isActive: (runId) => boundary(isActive(runId)),
    launchInFlight: (runId) => boundary(launchInFlight(runId)),
    createAgeMs: (runId) => boundary(createAgeMs(runId)),
    reserve: (input, manifestDigest) => boundary(reserve(input, manifestDigest)),
    sameLaunch: (input, manifestDigest) => boundary(sameLaunch(input, manifestDigest)),
    issueCreate: (runId) => boundary(issueCreate(runId)),
    adopt: (runId, sandboxId) => boundary(adopt(runId, sandboxId)),
    hold: (runId, reason, conflicting) => boundary(hold(runId, reason, conflicting)),
    seen: (runId, sandboxId, created) => boundary(seen(runId, sandboxId, created)),
    recordNotFound: (runId, sandboxId) => boundary(recordNotFound(runId, sandboxId)),
    recordNeverCreated: (runId) => boundary(recordNeverCreated(runId)),
    bind: (runId, target) => boundary(bind(runId, target)),
    beginExchange: (target, exchange) => boundary(beginExchange(target, exchange)),
    sealControl: (runId, exchangeId, sealed) => boundary(sealControl(runId, exchangeId, sealed)),
    stage: (runId, admission) => boundary(stage(runId, admission)),
    isolate: (runId, isolation) => boundary(isolate(runId, isolation)),
    issueLaunch: (runId) => boundary(issueLaunch(runId)),
    acceptLaunch: (runId) => boundary(acceptLaunch(runId)),
    fence: (runId) => boundary(fence(runId)),
    claimDeletion: (runId, claimMs) => boundary(claimDeletion(runId, claimMs)),
    lapseDeletionClaim: (run) => boundary(lapseDeletionClaim(run)),
    recordDeletion: (runId, operation) => boundary(recordDeletion(runId, operation)),
  });
});

/** Owns database statements and their guards. */
export const BoatRunRepoLive: Layer.Layer<BoatRunRepo, never, SealantDB> = Layer.effect(
  BoatRunRepo,
  make,
);
