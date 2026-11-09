import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  boatExecutionRecordSchema,
  type BoatExecutionRecord,
  type BoatExecutionTarget,
} from "@sealant/validators";
import { and, eq, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";

import { SealantDB } from "../client.js";
import { boatExecutions } from "../schema/boat-executions.js";
import { boatObservations } from "../schema/boat-observations.js";

/** Safe failure codes contain no ciphertext, request body or provider response. */
export class BoatExecutionStoreError extends Error {
  readonly _tag = "BoatExecutionStoreError";
  constructor(
    readonly code: "unavailable" | "invalid-record" | "target-conflict" | "stale-transition",
  ) {
    super(`Boat execution store: ${code}`);
  }
}

/** Every mutation compares the immutable target and the prior complete record atomically. */
export interface BoatExecutionRepoService {
  readonly get: (
    id: string,
  ) => Effect.Effect<BoatExecutionRecord | undefined, BoatExecutionStoreError>;
  /** Irreversible fence. Refuses once an invocation may have been issued. Inserts a tombstone if absent. */
  readonly abort: (target: BoatExecutionTarget) => Effect.Effect<void, BoatExecutionStoreError>;
  readonly reserve: (
    record: BoatExecutionRecord,
  ) => Effect.Effect<BoatExecutionRecord, BoatExecutionStoreError>;
  readonly advance: (
    previous: BoatExecutionRecord,
    next: BoatExecutionRecord,
  ) => Effect.Effect<BoatExecutionRecord, BoatExecutionStoreError>;
  /** Freezes current isolation receipts before permit delivery. Changed receipts never replace them. */
  readonly isolate: (
    previous: BoatExecutionRecord,
    isolation: NonNullable<BoatExecutionRecord["isolation"]>,
  ) => Effect.Effect<BoatExecutionRecord, BoatExecutionStoreError>;
  /**
   * Boat positively no longer has the guest (its observation is absent, checked in the same
   * transaction): the sealed copy of its launch payload kept for resume has no purpose left and is
   * erased. The sealed control bearer stays until an `ended` phase exists; it reaches nothing.
   */
  readonly forgetResume: (id: string) => Effect.Effect<void, BoatExecutionStoreError>;
}
/** Durable singleton per run and owned disk; it has no reset or replacement method. */
export class BoatExecutionRepo extends Context.Service<
  BoatExecutionRepo,
  BoatExecutionRepoService
>()("@sealant/db/BoatExecutionRepo") {}

const parse = (value: unknown) =>
  Effect.try({
    try: () => boatExecutionRecordSchema.parse(value),
    catch: () => new BoatExecutionStoreError("invalid-record"),
  });
const sameTarget = (a: BoatExecutionTarget, b: BoatExecutionTarget) => isDeepStrictEqual(a, b);
const transitions: Readonly<
  Record<BoatExecutionRecord["phase"], readonly BoatExecutionRecord["phase"][]>
> = {
  exchange: ["control"],
  control: ["prepared"],
  prepared: ["installed"],
  installed: ["issued"],
  issued: ["running", "held"],
  running: ["held"],
  held: [],
  aborted: [],
};

const make: Effect.Effect<BoatExecutionRepo["Service"], never, SealantDB> = Effect.gen(
  function* () {
    const db = yield* SealantDB;
    const get = Effect.fn("BoatExecutionRepo.get")(function* (id: string) {
      const rows = yield* db
        .select()
        .from(boatExecutions)
        .where(eq(boatExecutions.runtimeInstanceId, id))
        .pipe(Effect.mapError(() => new BoatExecutionStoreError("unavailable")));
      const row = rows[0];
      if (row === undefined) return undefined;
      const record = yield* parse(row.record);
      if (
        record.target.runId !== row.runId ||
        record.target.runtimeInstanceId !== row.runtimeInstanceId ||
        record.target.deploymentId !== row.deploymentId ||
        record.target.sandboxId !== row.sandboxId ||
        record.target.diskLineage !== row.diskLineage
      )
        return yield* Effect.fail(new BoatExecutionStoreError("invalid-record"));
      return record;
    });
    const reserve = Effect.fn("BoatExecutionRepo.reserve")(function* (input: BoatExecutionRecord) {
      const record = yield* parse(input);
      if (record.phase !== "exchange")
        return yield* Effect.fail(new BoatExecutionStoreError("invalid-record"));
      yield* db
        .insert(boatExecutions)
        .values({
          runtimeInstanceId: record.target.runtimeInstanceId,
          runId: record.target.runId,
          deploymentId: record.target.deploymentId,
          sandboxId: record.target.sandboxId,
          diskLineage: record.target.diskLineage,
          record,
        })
        .onConflictDoNothing()
        .pipe(Effect.mapError(() => new BoatExecutionStoreError("unavailable")));
      const saved = yield* get(record.target.runtimeInstanceId);
      if (saved === undefined || !sameTarget(record.target, saved.target))
        return yield* Effect.fail(new BoatExecutionStoreError("target-conflict"));
      return saved;
    });
    const advance = Effect.fn("BoatExecutionRepo.advance")(function* (
      previous: BoatExecutionRecord,
      input: BoatExecutionRecord,
    ) {
      const next = yield* parse(input);
      const before = yield* parse(previous);
      if (
        !sameTarget(before.target, next.target) ||
        before.exchangeId !== next.exchangeId ||
        before.publicKey !== next.publicKey ||
        !isDeepStrictEqual(before.isolation, next.isolation) ||
        !transitions[before.phase].includes(next.phase) ||
        (before.phase !== "exchange" && before.sealedControl !== next.sealedControl) ||
        (before.admission !== null &&
          (next.admission === null ||
            !isDeepStrictEqual(
              { ...before.admission, sealedEnvelope: null },
              { ...next.admission, sealedEnvelope: null },
            ) ||
            (next.admission.sealedEnvelope !== null &&
              before.admission.sealedEnvelope !== next.admission.sealedEnvelope)))
      )
        return yield* Effect.fail(new BoatExecutionStoreError("stale-transition"));
      const rows = yield* db
        .update(boatExecutions)
        .set({ record: next })
        .where(
          and(
            eq(boatExecutions.runtimeInstanceId, before.target.runtimeInstanceId),
            sql`${boatExecutions.record} = ${JSON.stringify(before)}::jsonb`,
          ),
        )
        .returning()
        .pipe(Effect.mapError(() => new BoatExecutionStoreError("unavailable")));
      if (rows.length !== 0) return next;
      const saved = yield* get(before.target.runtimeInstanceId);
      // A concurrent exact transition is successful; randomized encryption is compared by its caller.
      if (saved !== undefined && isDeepStrictEqual(saved, next)) return saved;
      return yield* Effect.fail(new BoatExecutionStoreError("stale-transition"));
    });
    const isolate = Effect.fn("BoatExecutionRepo.isolate")(function* (
      previous: BoatExecutionRecord,
      isolation: NonNullable<BoatExecutionRecord["isolation"]>,
    ) {
      const next = yield* parse({ ...previous, isolation });
      if (!["installed", "issued", "running"].includes(previous.phase))
        return yield* Effect.fail(new BoatExecutionStoreError("stale-transition"));
      if (previous.isolation !== undefined) {
        if (!isDeepStrictEqual(previous.isolation, next.isolation))
          return yield* Effect.fail(new BoatExecutionStoreError("stale-transition"));
        const saved = yield* get(previous.target.runtimeInstanceId);
        if (isDeepStrictEqual(saved, next)) return next;
        return yield* Effect.fail(new BoatExecutionStoreError("stale-transition"));
      }
      const rows = yield* db
        .update(boatExecutions)
        .set({ record: next })
        .where(
          and(
            eq(boatExecutions.runtimeInstanceId, previous.target.runtimeInstanceId),
            sql`${boatExecutions.record} = ${JSON.stringify(previous)}::jsonb`,
          ),
        )
        .returning()
        .pipe(Effect.mapError(() => new BoatExecutionStoreError("unavailable")));
      if (rows.length !== 0) return next;
      const saved = yield* get(previous.target.runtimeInstanceId);
      if (isDeepStrictEqual(saved, next)) return next;
      return yield* Effect.fail(new BoatExecutionStoreError("stale-transition"));
    });
    const abort = Effect.fn("BoatExecutionRepo.abort")(function* (target: BoatExecutionTarget) {
      const before = yield* get(target.runtimeInstanceId);
      if (
        before !== undefined &&
        (!sameTarget(before.target, target) ||
          !["exchange", "control", "prepared", "installed", "aborted"].includes(before.phase))
      )
        return yield* Effect.fail(new BoatExecutionStoreError("stale-transition"));
      if (before?.phase === "aborted") return;
      const next = yield* parse({
        target,
        exchangeId: before?.exchangeId ?? randomUUID(),
        publicKey: before?.publicKey ?? "",
        sealedExchange: null,
        sealedControl: null,
        admission: null,
        phase: "aborted",
      });
      if (before === undefined) {
        yield* db
          .insert(boatExecutions)
          .values({
            runtimeInstanceId: target.runtimeInstanceId,
            runId: target.runId,
            deploymentId: target.deploymentId,
            sandboxId: target.sandboxId,
            diskLineage: target.diskLineage,
            record: next,
          })
          .onConflictDoNothing()
          .pipe(Effect.mapError(() => new BoatExecutionStoreError("unavailable")));
      } else {
        yield* db
          .update(boatExecutions)
          .set({ record: next })
          .where(
            and(
              eq(boatExecutions.runtimeInstanceId, target.runtimeInstanceId),
              sql`${boatExecutions.record} = ${JSON.stringify(before)}::jsonb`,
            ),
          )
          .pipe(Effect.mapError(() => new BoatExecutionStoreError("unavailable")));
      }
      const saved = yield* get(target.runtimeInstanceId);
      if (saved?.phase !== "aborted" || !sameTarget(saved.target, target))
        return yield* Effect.fail(new BoatExecutionStoreError("stale-transition"));
    });
    const forgetResume = Effect.fn("BoatExecutionRepo.forgetResume")(function* (id: string) {
      yield* db
        .transaction(() =>
          Effect.gen(function* () {
            const [row] = yield* db
              .select()
              .from(boatExecutions)
              .where(eq(boatExecutions.runtimeInstanceId, id))
              .for("update");
            if (row === undefined) return;
            const record = yield* parse(row.record);
            if (record.admission?.sealedResumeEnvelope === undefined) return;
            const [observed] = yield* db
              .select()
              .from(boatObservations)
              .where(eq(boatObservations.runtimeInstanceId, id));
            if (observed?.presence !== "absent" || observed.sandboxId !== row.sandboxId)
              return yield* Effect.fail(new BoatExecutionStoreError("stale-transition"));
            const { sealedResumeEnvelope: _erased, ...admission } = record.admission;
            const next = yield* parse({ ...record, admission });
            yield* db
              .update(boatExecutions)
              .set({ record: next })
              .where(
                and(
                  eq(boatExecutions.runtimeInstanceId, id),
                  sql`${boatExecutions.record} = ${JSON.stringify(row.record)}::jsonb`,
                ),
              );
          }),
        )
        .pipe(
          Effect.mapError((error) =>
            error instanceof BoatExecutionStoreError
              ? error
              : new BoatExecutionStoreError("unavailable"),
          ),
        );
    });
    return BoatExecutionRepo.of({ get, reserve, advance, isolate, abort, forgetResume });
  },
);
/** All transitions use a single database compare-and-set and perform no external I/O. */
export const BoatExecutionRepoLive: Layer.Layer<BoatExecutionRepo, never, SealantDB> = Layer.effect(
  BoatExecutionRepo,
  make,
);
