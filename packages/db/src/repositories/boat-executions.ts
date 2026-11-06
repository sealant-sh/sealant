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
  readonly reserve: (
    record: BoatExecutionRecord,
  ) => Effect.Effect<BoatExecutionRecord, BoatExecutionStoreError>;
  readonly advance: (
    previous: BoatExecutionRecord,
    next: BoatExecutionRecord,
  ) => Effect.Effect<BoatExecutionRecord, BoatExecutionStoreError>;
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
    return BoatExecutionRepo.of({ get, reserve, advance });
  },
);
/** All transitions use a single database compare-and-set and perform no external I/O. */
export const BoatExecutionRepoLive: Layer.Layer<BoatExecutionRepo, never, SealantDB> = Layer.effect(
  BoatExecutionRepo,
  make,
);
