import { and, eq, sql } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";

import { SealantDB } from "../client.js";
import { workspaceCreateReservations, type WorkspaceCreateReservation } from "../schema.js";

const operationSchema = Schema.Literals(["reserve", "markCreated", "cancel", "get"]);

export class WorkspaceCreateReservationRepoUnexpectedError extends Schema.TaggedErrorClass<WorkspaceCreateReservationRepoUnexpectedError>()(
  "WorkspaceCreateReservationRepoUnexpectedError",
  {
    operation: operationSchema,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export type WorkspaceCreateReservationRepoError = WorkspaceCreateReservationRepoUnexpectedError;

const withRepoError = <A>(
  operation: typeof operationSchema.Type,
  effect: Effect.Effect<A, unknown>,
): Effect.Effect<A, WorkspaceCreateReservationRepoError> =>
  effect.pipe(
    Effect.mapError((cause) =>
      cause instanceof WorkspaceCreateReservationRepoUnexpectedError
        ? cause
        : new WorkspaceCreateReservationRepoUnexpectedError({
            operation,
            message: cause instanceof Error ? cause.message : `${operation} failed.`,
            cause,
          }),
    ),
  );

export interface WorkspaceCreateReservationKey {
  readonly ownerUserId: string;
  readonly idempotencyKey: string;
}

/**
 * The durable record of an idempotent create (`workspace_create_reservations`). A create with a
 * key reserves it (`pending`) before anything else, and commits it (`created`) in the same
 * transaction as the workspace, its attempt and its launch job. The owner can cancel a key
 * (`cancelled`) so a create with it — a delayed original request included — never commits.
 * Both transitions are fenced on `pending` (or an absent row): exactly one wins.
 */
export interface WorkspaceCreateReservationRepoService {
  /** Reserve the key (`pending`) unless a record exists; returns the record as it now stands. */
  readonly reserve: (
    input: WorkspaceCreateReservationKey & { readonly launchId?: string },
  ) => Effect.Effect<WorkspaceCreateReservation, WorkspaceCreateReservationRepoError>;
  /**
   * `pending` → `created` for `workspaceId`. `false` when the key is no longer pending (it was
   * cancelled, or another create committed it): the caller's transaction must not commit.
   */
  readonly markCreated: (
    input: WorkspaceCreateReservationKey & { readonly workspaceId: string },
  ) => Effect.Effect<boolean, WorkspaceCreateReservationRepoError>;
  /**
   * Cancel the key: a `pending` (or absent) record becomes `cancelled`, for good; a `created` one
   * stays created. Returns the record as it now stands.
   */
  readonly cancel: (
    input: WorkspaceCreateReservationKey,
  ) => Effect.Effect<WorkspaceCreateReservation, WorkspaceCreateReservationRepoError>;
  readonly get: (
    input: WorkspaceCreateReservationKey,
  ) => Effect.Effect<WorkspaceCreateReservation | undefined, WorkspaceCreateReservationRepoError>;
}

export class WorkspaceCreateReservationRepo extends Context.Service<
  WorkspaceCreateReservationRepo,
  WorkspaceCreateReservationRepoService
>()("WorkspaceCreateReservationRepo") {}

const keyMatches = (input: WorkspaceCreateReservationKey) =>
  and(
    eq(workspaceCreateReservations.ownerUserId, input.ownerUserId),
    eq(workspaceCreateReservations.idempotencyKey, input.idempotencyKey),
  );

export const WorkspaceCreateReservationRepoLive: Layer.Layer<
  WorkspaceCreateReservationRepo,
  never,
  SealantDB
> = Layer.effect(
  WorkspaceCreateReservationRepo,
  Effect.gen(function* () {
    const db = yield* SealantDB;

    const read = (input: WorkspaceCreateReservationKey) =>
      Effect.gen(function* () {
        const [row] = yield* db
          .select()
          .from(workspaceCreateReservations)
          .where(keyMatches(input))
          .limit(1);
        return row;
      });

    const readExisting = (input: WorkspaceCreateReservationKey) =>
      Effect.gen(function* () {
        const row = yield* read(input);
        if (row === undefined) {
          return yield* Effect.fail(
            new Error(`The create reservation of key ${input.idempotencyKey} was not written.`),
          );
        }
        return row;
      });

    return {
      reserve: (input) =>
        withRepoError(
          "reserve",
          Effect.gen(function* () {
            yield* db
              .insert(workspaceCreateReservations)
              .values({
                ownerUserId: input.ownerUserId,
                idempotencyKey: input.idempotencyKey,
                state: "pending",
                ...(input.launchId === undefined ? {} : { launchId: input.launchId }),
              })
              .onConflictDoNothing();
            return yield* readExisting(input);
          }),
        ),

      markCreated: (input) =>
        withRepoError(
          "markCreated",
          Effect.gen(function* () {
            const updated = yield* db
              .update(workspaceCreateReservations)
              .set({ state: "created", workspaceId: input.workspaceId })
              .where(and(keyMatches(input), eq(workspaceCreateReservations.state, "pending")))
              .returning({ state: workspaceCreateReservations.state });
            return updated.length > 0;
          }),
        ),

      cancel: (input) =>
        withRepoError(
          "cancel",
          Effect.gen(function* () {
            yield* db
              .insert(workspaceCreateReservations)
              .values({
                ownerUserId: input.ownerUserId,
                idempotencyKey: input.idempotencyKey,
                state: "cancelled",
                cancelledAt: new Date(),
              })
              .onConflictDoUpdate({
                target: [
                  workspaceCreateReservations.ownerUserId,
                  workspaceCreateReservations.idempotencyKey,
                ],
                set: { state: "cancelled", cancelledAt: sql`now()` },
                setWhere: eq(workspaceCreateReservations.state, "pending"),
              });
            return yield* readExisting(input);
          }),
        ),

      get: (input) => withRepoError("get", read(input)),
    } satisfies WorkspaceCreateReservationRepoService;
  }),
);
