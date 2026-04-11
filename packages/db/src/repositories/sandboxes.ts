import { and, desc, eq, inArray } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";

import { SealantDB } from "../client.js";
import {
  sandboxRunLinks,
  sandboxes,
  type NewSandbox,
  type NewSandboxRunLink,
  type Sandbox,
  type SandboxRunLink,
  type SandboxRunLinkRelation,
  type SandboxStatus,
} from "../schema.js";

export interface CreateSandboxInput {
  readonly id: string;
  readonly name: string;
  readonly ownerUserId: string;
  readonly repositoryId?: string;
  readonly repositoryProfileRevisionId?: string;
  readonly profileRevisionId?: string;
  readonly requestedByUserId?: string;
  readonly status?: SandboxStatus;
}

export interface ListSandboxesInput {
  readonly ownerUserId?: string;
  readonly repositoryId?: string;
  readonly statuses?: readonly SandboxStatus[];
  readonly limit?: number;
}

export interface SetSandboxStatusInput {
  readonly id: string;
  readonly status: SandboxStatus;
}

export interface SetSandboxNameInput {
  readonly id: string;
  readonly name: string;
}

export interface LinkSandboxAttemptInput {
  readonly sandboxId: string;
  readonly attemptId: string;
  readonly relation?: SandboxRunLinkRelation;
  readonly linkedAt?: Date;
}

/** @deprecated Use SandboxRepo + SandboxRepoLive instead. */
export const createSandboxRepository = (): never => {
  throw new Error("createSandboxRepository is disabled during the Effect transition.");
};

/** @deprecated Use SandboxRepoService instead. */
export type SandboxRepository = SandboxRepoService;

// Keep operation names constrained so all repo failures include consistent metadata.
const sandboxRepoOperationSchema = Schema.Literal(
  "createSandbox",
  "getSandboxByAttemptId",
  "getSandboxById",
  "linkSandboxAttempt",
  "listSandboxAttemptLinks",
  "listSandboxes",
  "setSandboxName",
  "setSandboxStatus",
);

// Invariant errors represent expected domain/consistency violations
// (for example, an insert/update path that should return a row but did not).
export class SandboxRepoInvariantError extends Schema.TaggedError<SandboxRepoInvariantError>(
  "SandboxRepoInvariantError",
)("SandboxRepoInvariantError", {
  operation: sandboxRepoOperationSchema,
  message: Schema.String,
}) {}

// Unexpected errors wrap unknown defects from infra/driver boundaries
// so callers can still pattern-match on a typed repo error channel.
export class SandboxRepoUnexpectedError extends Schema.TaggedError<SandboxRepoUnexpectedError>(
  "SandboxRepoUnexpectedError",
)("SandboxRepoUnexpectedError", {
  operation: sandboxRepoOperationSchema,
  message: Schema.String,
  cause: Schema.Defect,
}) {}

export const sandboxRepoErrorSchema = Schema.Union(
  SandboxRepoInvariantError,
  SandboxRepoUnexpectedError,
);

export type SandboxRepoError = typeof sandboxRepoErrorSchema.Type;

type SandboxRepoOperation = typeof sandboxRepoOperationSchema.Type;

const mapSandboxRepoError = (operation: SandboxRepoOperation, cause: unknown): SandboxRepoError => {
  if (cause instanceof SandboxRepoInvariantError || cause instanceof SandboxRepoUnexpectedError) {
    return cause;
  }

  return new SandboxRepoUnexpectedError({
    operation,
    message: cause instanceof Error ? cause.message : `${operation} failed.`,
    cause,
  });
};

const withSandboxRepoError = <A>(
  operation: SandboxRepoOperation,
  effect: Effect.Effect<A, unknown>,
): Effect.Effect<A, SandboxRepoError> => {
  return effect.pipe(Effect.mapError((cause) => mapSandboxRepoError(operation, cause)));
};

export interface SandboxRepoService {
  /** Inserts a new sandbox row and returns the created sandbox. */
  readonly createSandbox: (input: CreateSandboxInput) => Effect.Effect<Sandbox, SandboxRepoError>;

  /** Finds a sandbox by linked attempt/run id. Returns undefined when no link exists. */
  readonly getSandboxByAttemptId: (
    attemptId: string,
  ) => Effect.Effect<Sandbox | undefined, SandboxRepoError>;

  /** Finds a sandbox by id. Returns undefined when not found. */
  readonly getSandboxById: (id: string) => Effect.Effect<Sandbox | undefined, SandboxRepoError>;

  /** Upserts the sandbox-attempt link and updates latestRunId on the sandbox row. */
  readonly linkSandboxAttempt: (
    input: LinkSandboxAttemptInput,
  ) => Effect.Effect<SandboxRunLink, SandboxRepoError>;

  /** Lists sandboxes newest-first with optional owner, repository, and status filters. */
  readonly listSandboxes: (
    input?: ListSandboxesInput,
  ) => Effect.Effect<readonly Sandbox[], SandboxRepoError>;

  /** Lists links for a sandbox newest-first, bounded by the optional limit. */
  readonly listSandboxAttemptLinks: (
    sandboxId: string,
    limit?: number,
  ) => Effect.Effect<readonly SandboxRunLink[], SandboxRepoError>;

  /** Updates sandbox name and returns the updated row, or null when not found. */
  readonly setSandboxName: (
    input: SetSandboxNameInput,
  ) => Effect.Effect<Sandbox | null, SandboxRepoError>;

  /** Updates sandbox status and returns the updated row, or null when not found. */
  readonly setSandboxStatus: (
    input: SetSandboxStatusInput,
  ) => Effect.Effect<Sandbox | null, SandboxRepoError>;
}
export class SandboxRepo extends Context.Tag("SandboxRepo")<SandboxRepo, SandboxRepoService>() {}

export const SandboxRepoLive = Layer.effect(
  SandboxRepo,
  Effect.gen(function* () {
    const db = yield* SealantDB;

    return {
      createSandbox: (input) =>
        withSandboxRepoError(
          "createSandbox",
          Effect.gen(function* () {
            const [sandbox] = yield* db
              .insert(sandboxes)
              .values({
                id: input.id,
                name: input.name,
                ownerUserId: input.ownerUserId,
                ...(input.repositoryId === undefined ? {} : { repositoryId: input.repositoryId }),
                ...(input.repositoryProfileRevisionId === undefined
                  ? {}
                  : { repositoryProfileRevisionId: input.repositoryProfileRevisionId }),
                ...(input.profileRevisionId === undefined
                  ? {}
                  : { profileRevisionId: input.profileRevisionId }),
                ...(input.requestedByUserId === undefined
                  ? {}
                  : { requestedByUserId: input.requestedByUserId }),
                ...(input.status === undefined ? {} : { status: input.status }),
              } satisfies NewSandbox)
              .returning();

            if (sandbox === undefined) {
              return yield* new SandboxRepoInvariantError({
                operation: "createSandbox",
                message: "Failed to create sandbox.",
              });
            }

            return sandbox;
          }),
        ),

      getSandboxByAttemptId: (attemptId) =>
        withSandboxRepoError(
          "getSandboxByAttemptId",
          Effect.gen(function* () {
            const link = yield* db.query.sandboxRunLinks.findFirst({
              where: { runId: attemptId },
              with: { sandbox: true },
            });

            return link?.sandbox ?? undefined;
          }),
        ),

      getSandboxById: (id) =>
        withSandboxRepoError(
          "getSandboxById",
          Effect.gen(function* () {
            return yield* db.query.sandboxes.findFirst({ where: { id } });
          }),
        ),

      linkSandboxAttempt: (input) =>
        withSandboxRepoError(
          "linkSandboxAttempt",
          db.transaction((tx) =>
            Effect.gen(function* () {
              const [link] = yield* tx
                .insert(sandboxRunLinks)
                .values({
                  sandboxId: input.sandboxId,
                  runId: input.attemptId,
                  ...(input.relation === undefined ? {} : { relation: input.relation }),
                  ...(input.linkedAt === undefined ? {} : { linkedAt: input.linkedAt }),
                } satisfies NewSandboxRunLink)
                .onConflictDoUpdate({
                  target: [sandboxRunLinks.sandboxId, sandboxRunLinks.runId],
                  set: {
                    relation: input.relation ?? "launch",
                    linkedAt: input.linkedAt ?? new Date(),
                  },
                })
                .returning();

              if (link === undefined) {
                return yield* new SandboxRepoInvariantError({
                  operation: "linkSandboxAttempt",
                  message: "Failed to link sandbox attempt.",
                });
              }

              yield* tx
                .update(sandboxes)
                .set({ latestRunId: link.runId })
                .where(eq(sandboxes.id, link.sandboxId));

              return link;
            }),
          ),
        ),

      listSandboxes: (input = {}) =>
        withSandboxRepoError(
          "listSandboxes",
          Effect.gen(function* () {
            const whereClauses = [
              ...(input.ownerUserId === undefined
                ? []
                : [eq(sandboxes.ownerUserId, input.ownerUserId)]),
              ...(input.repositoryId === undefined
                ? []
                : [eq(sandboxes.repositoryId, input.repositoryId)]),
              ...(input.statuses === undefined || input.statuses.length === 0
                ? []
                : [inArray(sandboxes.status, [...input.statuses])]),
            ];

            if (whereClauses.length === 0) {
              return yield* db
                .select()
                .from(sandboxes)
                .orderBy(desc(sandboxes.createdAt))
                .limit(input.limit ?? 100);
            }

            return yield* db
              .select()
              .from(sandboxes)
              .where(and(...whereClauses))
              .orderBy(desc(sandboxes.createdAt))
              .limit(input.limit ?? 100);
          }),
        ),

      listSandboxAttemptLinks: (sandboxId, limit = 100) =>
        withSandboxRepoError(
          "listSandboxAttemptLinks",
          db.query.sandboxRunLinks.findMany({
            where: { sandboxId },
            orderBy: { linkedAt: "desc" },
            limit,
          }),
        ),

      setSandboxName: (input) =>
        withSandboxRepoError(
          "setSandboxName",
          Effect.gen(function* () {
            const [sandbox] = yield* db
              .update(sandboxes)
              .set({ name: input.name })
              .where(eq(sandboxes.id, input.id))
              .returning();

            return sandbox ?? null;
          }),
        ),

      setSandboxStatus: (input) =>
        withSandboxRepoError(
          "setSandboxStatus",
          Effect.gen(function* () {
            const [sandbox] = yield* db
              .update(sandboxes)
              .set({ status: input.status })
              .where(eq(sandboxes.id, input.id))
              .returning();

            return sandbox ?? null;
          }),
        ),
    } satisfies SandboxRepoService;
  }),
);

/*
Example usage in an Effect program (following effect-solutions services-and-layers guidance):

import { Effect, Layer } from "effect";
import { SandboxRepo, SandboxRepoLive, SealantDBLive } from "@sealant/db";

const program = Effect.gen(function* () {
  const sandboxRepo = yield* SandboxRepo;
  return yield* sandboxRepo.listSandboxes({ ownerUserId: "user_123", limit: 20 });
});

const appLayer = SandboxRepoLive.pipe(Layer.provide(SealantDBLive));

const sandboxes = await Effect.runPromise(program.pipe(Effect.provide(appLayer)));
*/
