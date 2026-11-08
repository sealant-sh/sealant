import { boatExecutionTargetSchema, type BoatExecutionTarget } from "@sealant/validators";
import { and, eq, gt, isNull, lte, sql } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";

import { SealantDB } from "../client.js";
import { boatControlRequests } from "../schema/boat-control-requests.js";

const requestSchema = Schema.Struct({
  id: Schema.String,
  target: Schema.Unknown,
  sealedAccess: Schema.NullOr(Schema.String),
});
export interface BoatControlRequest {
  readonly id: string;
  readonly target: BoatExecutionTarget;
  readonly sealedAccess: string | null;
}

/** Contains no request contents or encrypted replies. */
export class BoatControlRequestError extends Error {
  readonly _tag = "BoatControlRequestError";
  constructor() {
    super("Boat control request unavailable");
  }
}

/** Each caller owns one expiring request; workers can only complete that exact target. */
export class BoatControlRequestRepo extends Context.Service<
  BoatControlRequestRepo,
  {
    readonly create: (
      id: string,
      target: BoatExecutionTarget,
    ) => Effect.Effect<void, BoatControlRequestError>;
    readonly get: (
      id: string,
    ) => Effect.Effect<BoatControlRequest | undefined, BoatControlRequestError>;
    readonly pending: () => Effect.Effect<readonly BoatControlRequest[], BoatControlRequestError>;
    readonly complete: (
      request: BoatControlRequest,
      sealed: string,
    ) => Effect.Effect<void, BoatControlRequestError>;
    readonly remove: (id: string) => Effect.Effect<void, BoatControlRequestError>;
    readonly expire: () => Effect.Effect<void, BoatControlRequestError>;
  }
>()("@sealant/db/BoatControlRequestRepo") {}

const make: Effect.Effect<BoatControlRequestRepo["Service"], never, SealantDB> = Effect.gen(
  function* () {
    const db = yield* SealantDB;
    const failure = () => new BoatControlRequestError();
    const parse = (row: unknown) =>
      Effect.try({
        try: () => {
          const parsed = Schema.decodeUnknownSync(requestSchema)(row);
          return { ...parsed, target: boatExecutionTargetSchema.parse(parsed.target) };
        },
        catch: failure,
      });
    return {
      create: (id: string, target: BoatExecutionTarget) =>
        db
          .insert(boatControlRequests)
          .values({
            id,
            runtimeInstanceId: target.runtimeInstanceId,
            target,
            expiresAt: sql`now() + interval '30 seconds'`,
          })
          .pipe(Effect.mapError(failure), Effect.asVoid),
      get: (id: string) =>
        db
          .select()
          .from(boatControlRequests)
          .where(and(eq(boatControlRequests.id, id), gt(boatControlRequests.expiresAt, sql`now()`)))
          .pipe(
            Effect.mapError(failure),
            Effect.flatMap((rows) =>
              rows[0] === undefined ? Effect.succeed(undefined) : parse(rows[0]),
            ),
          ),
      pending: () =>
        db
          .select()
          .from(boatControlRequests)
          .where(
            and(
              isNull(boatControlRequests.sealedAccess),
              gt(boatControlRequests.expiresAt, sql`now()`),
            ),
          )
          .orderBy(boatControlRequests.expiresAt, boatControlRequests.id)
          .limit(20)
          .pipe(
            Effect.mapError(failure),
            Effect.flatMap((rows) => Effect.forEach(rows, parse)),
          ),
      complete: (request: BoatControlRequest, sealedAccess: string) =>
        db
          .update(boatControlRequests)
          .set({ sealedAccess })
          .where(
            and(
              eq(boatControlRequests.id, request.id),
              eq(boatControlRequests.target, request.target),
              isNull(boatControlRequests.sealedAccess),
              gt(boatControlRequests.expiresAt, sql`now()`),
            ),
          )
          .pipe(Effect.mapError(failure), Effect.asVoid),
      remove: (id: string) =>
        db
          .delete(boatControlRequests)
          .where(eq(boatControlRequests.id, id))
          .pipe(Effect.mapError(failure), Effect.asVoid),
      expire: () =>
        db
          .delete(boatControlRequests)
          .where(lte(boatControlRequests.expiresAt, sql`now()`))
          .pipe(Effect.mapError(failure), Effect.asVoid),
    };
  },
);

export const boatControlRequestRepoLayer: Layer.Layer<BoatControlRequestRepo, never, SealantDB> =
  Layer.effect(BoatControlRequestRepo, make);
