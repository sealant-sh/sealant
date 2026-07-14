import { and, desc, eq, inArray } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";

import { SealantDB } from "../client.js";
import {
  workspaceRunLinks,
  workspaces,
  type NewWorkspace,
  type NewWorkspaceRunLink,
  type Workspace,
  type WorkspaceRunLink,
  type WorkspaceRunLinkRelation,
  type WorkspaceStatus,
} from "../schema.js";

export interface CreateWorkspaceInput {
  readonly id: string;
  readonly name: string;
  readonly ownerUserId: string;
  readonly repositoryId?: string;
  readonly repositoryProfileRevisionId?: string;
  readonly profileRevisionId?: string;
  readonly requestedByUserId?: string;
  readonly status?: WorkspaceStatus;
  readonly expiresAt?: Date;
}

export interface ListWorkspacesInput {
  readonly ownerUserId?: string;
  readonly repositoryId?: string;
  readonly statuses?: readonly WorkspaceStatus[];
  readonly limit?: number;
}

export interface SetWorkspaceStatusInput {
  readonly id: string;
  readonly status: WorkspaceStatus;
}

export interface SetWorkspaceNameInput {
  readonly id: string;
  readonly name: string;
}

export interface SetWorkspaceExpiryInput {
  readonly id: string;
  /** `null` clears the TTL (never expires). */
  readonly expiresAt: Date | null;
}

export interface LinkWorkspaceAttemptInput {
  readonly workspaceId: string;
  readonly attemptId: string;
  readonly relation?: WorkspaceRunLinkRelation;
  readonly linkedAt?: Date;
}

/** @deprecated Use WorkspaceRepo + WorkspaceRepoLive instead. */
export const createWorkspaceRepository = (): never => {
  throw new Error("createWorkspaceRepository is disabled during the Effect transition.");
};

/** @deprecated Use WorkspaceRepoService instead. */
export type WorkspaceRepository = WorkspaceRepoService;

// Keep operation names constrained so all repo failures include consistent metadata.
const workspaceRepoOperationSchema = Schema.Literals([
  "createWorkspace",
  "getWorkspaceByAttemptId",
  "getWorkspaceById",
  "linkWorkspaceAttempt",
  "listWorkspaceAttemptLinks",
  "listWorkspaces",
  "setWorkspaceExpiry",
  "setWorkspaceName",
  "setWorkspaceStatus",
]);

// Invariant errors represent expected domain/consistency violations
// (for example, an insert/update path that should return a row but did not).
export class WorkspaceRepoInvariantError extends Schema.TaggedErrorClass<WorkspaceRepoInvariantError>()(
  "WorkspaceRepoInvariantError",
  {
    operation: workspaceRepoOperationSchema,
    message: Schema.String,
  },
) {}

// Unexpected errors wrap unknown defects from infra/driver boundaries
// so callers can still pattern-match on a typed repo error channel.
export class WorkspaceRepoUnexpectedError extends Schema.TaggedErrorClass<WorkspaceRepoUnexpectedError>()(
  "WorkspaceRepoUnexpectedError",
  {
    operation: workspaceRepoOperationSchema,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export const workspaceRepoErrorSchema = Schema.Union([
  WorkspaceRepoInvariantError,
  WorkspaceRepoUnexpectedError,
]);

export type WorkspaceRepoError = typeof workspaceRepoErrorSchema.Type;

type WorkspaceRepoOperation = typeof workspaceRepoOperationSchema.Type;

const mapWorkspaceRepoError = (
  operation: WorkspaceRepoOperation,
  cause: unknown,
): WorkspaceRepoError => {
  if (
    cause instanceof WorkspaceRepoInvariantError ||
    cause instanceof WorkspaceRepoUnexpectedError
  ) {
    return cause;
  }

  return new WorkspaceRepoUnexpectedError({
    operation,
    message: cause instanceof Error ? cause.message : `${operation} failed.`,
    cause,
  });
};

const withWorkspaceRepoError = <A>(
  operation: WorkspaceRepoOperation,
  effect: Effect.Effect<A, unknown>,
): Effect.Effect<A, WorkspaceRepoError> => {
  return effect.pipe(Effect.mapError((cause) => mapWorkspaceRepoError(operation, cause)));
};

export interface WorkspaceRepoService {
  /** Inserts a new workspace row and returns the created workspace. */
  readonly createWorkspace: (
    input: CreateWorkspaceInput,
  ) => Effect.Effect<Workspace, WorkspaceRepoError>;

  /** Finds a workspace by linked attempt/run id. Returns undefined when no link exists. */
  readonly getWorkspaceByAttemptId: (
    attemptId: string,
  ) => Effect.Effect<Workspace | undefined, WorkspaceRepoError>;

  /** Finds a workspace by id. Returns undefined when not found. */
  readonly getWorkspaceById: (
    id: string,
  ) => Effect.Effect<Workspace | undefined, WorkspaceRepoError>;

  /** Upserts the workspace-attempt link and updates latestRunId on the workspace row. */
  readonly linkWorkspaceAttempt: (
    input: LinkWorkspaceAttemptInput,
  ) => Effect.Effect<WorkspaceRunLink, WorkspaceRepoError>;

  /** Lists workspaces newest-first with optional owner, repository, and status filters. */
  readonly listWorkspaces: (
    input?: ListWorkspacesInput,
  ) => Effect.Effect<readonly Workspace[], WorkspaceRepoError>;

  /** Lists links for a workspace newest-first, bounded by the optional limit. */
  readonly listWorkspaceAttemptLinks: (
    workspaceId: string,
    limit?: number,
  ) => Effect.Effect<readonly WorkspaceRunLink[], WorkspaceRepoError>;

  /** Updates workspace name and returns the updated row, or null when not found. */
  readonly setWorkspaceName: (
    input: SetWorkspaceNameInput,
  ) => Effect.Effect<Workspace | null, WorkspaceRepoError>;

  /** Sets (or clears, with null) the workspace TTL. Returns the updated row, or null when not found. */
  readonly setWorkspaceExpiry: (
    input: SetWorkspaceExpiryInput,
  ) => Effect.Effect<Workspace | null, WorkspaceRepoError>;

  /** Updates workspace status and returns the updated row, or null when not found. */
  readonly setWorkspaceStatus: (
    input: SetWorkspaceStatusInput,
  ) => Effect.Effect<Workspace | null, WorkspaceRepoError>;
}
export class WorkspaceRepo extends Context.Service<WorkspaceRepo, WorkspaceRepoService>()(
  "WorkspaceRepo",
) {}

export const WorkspaceRepoLive = Layer.effect(
  WorkspaceRepo,
  Effect.gen(function* () {
    const db = yield* SealantDB;

    return {
      createWorkspace: (input) =>
        withWorkspaceRepoError(
          "createWorkspace",
          Effect.gen(function* () {
            const [workspace] = yield* db
              .insert(workspaces)
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
                ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
              } satisfies NewWorkspace)
              .returning();

            if (workspace === undefined) {
              return yield* new WorkspaceRepoInvariantError({
                operation: "createWorkspace",
                message: "Failed to create workspace.",
              });
            }

            return workspace;
          }),
        ),

      getWorkspaceByAttemptId: (attemptId) =>
        withWorkspaceRepoError(
          "getWorkspaceByAttemptId",
          Effect.gen(function* () {
            const link = yield* db.query.workspaceRunLinks.findFirst({
              where: { runId: attemptId },
              with: { workspace: true },
            });

            return link?.workspace ?? undefined;
          }),
        ),

      getWorkspaceById: (id) =>
        withWorkspaceRepoError(
          "getWorkspaceById",
          Effect.gen(function* () {
            return yield* db.query.workspaces.findFirst({ where: { id } });
          }),
        ),

      linkWorkspaceAttempt: (input) =>
        withWorkspaceRepoError(
          "linkWorkspaceAttempt",
          db.transaction((tx) =>
            Effect.gen(function* () {
              const [link] = yield* tx
                .insert(workspaceRunLinks)
                .values({
                  workspaceId: input.workspaceId,
                  runId: input.attemptId,
                  ...(input.relation === undefined ? {} : { relation: input.relation }),
                  ...(input.linkedAt === undefined ? {} : { linkedAt: input.linkedAt }),
                } satisfies NewWorkspaceRunLink)
                .onConflictDoUpdate({
                  target: [workspaceRunLinks.workspaceId, workspaceRunLinks.runId],
                  set: {
                    relation: input.relation ?? "launch",
                    linkedAt: input.linkedAt ?? new Date(),
                  },
                })
                .returning();

              if (link === undefined) {
                return yield* new WorkspaceRepoInvariantError({
                  operation: "linkWorkspaceAttempt",
                  message: "Failed to link workspace attempt.",
                });
              }

              yield* tx
                .update(workspaces)
                .set({ latestRunId: link.runId })
                .where(eq(workspaces.id, link.workspaceId));

              return link;
            }),
          ),
        ),

      listWorkspaces: (input = {}) =>
        withWorkspaceRepoError(
          "listWorkspaces",
          Effect.gen(function* () {
            const whereClauses = [
              ...(input.ownerUserId === undefined
                ? []
                : [eq(workspaces.ownerUserId, input.ownerUserId)]),
              ...(input.repositoryId === undefined
                ? []
                : [eq(workspaces.repositoryId, input.repositoryId)]),
              ...(input.statuses === undefined || input.statuses.length === 0
                ? []
                : [inArray(workspaces.status, [...input.statuses])]),
            ];

            if (whereClauses.length === 0) {
              return yield* db
                .select()
                .from(workspaces)
                .orderBy(desc(workspaces.createdAt))
                .limit(input.limit ?? 100);
            }

            return yield* db
              .select()
              .from(workspaces)
              .where(and(...whereClauses))
              .orderBy(desc(workspaces.createdAt))
              .limit(input.limit ?? 100);
          }),
        ),

      listWorkspaceAttemptLinks: (workspaceId, limit = 100) =>
        withWorkspaceRepoError(
          "listWorkspaceAttemptLinks",
          db.query.workspaceRunLinks.findMany({
            where: { workspaceId },
            orderBy: { linkedAt: "desc" },
            limit,
          }),
        ),

      setWorkspaceName: (input) =>
        withWorkspaceRepoError(
          "setWorkspaceName",
          Effect.gen(function* () {
            const [workspace] = yield* db
              .update(workspaces)
              .set({ name: input.name })
              .where(eq(workspaces.id, input.id))
              .returning();

            return workspace ?? null;
          }),
        ),

      setWorkspaceExpiry: (input) =>
        withWorkspaceRepoError(
          "setWorkspaceExpiry",
          Effect.gen(function* () {
            const [workspace] = yield* db
              .update(workspaces)
              .set({ expiresAt: input.expiresAt })
              .where(eq(workspaces.id, input.id))
              .returning();

            return workspace ?? null;
          }),
        ),

      setWorkspaceStatus: (input) =>
        withWorkspaceRepoError(
          "setWorkspaceStatus",
          Effect.gen(function* () {
            const [workspace] = yield* db
              .update(workspaces)
              .set({ status: input.status })
              .where(eq(workspaces.id, input.id))
              .returning();

            return workspace ?? null;
          }),
        ),
    } satisfies WorkspaceRepoService;
  }),
);

/*
Example usage in an Effect program (following effect-solutions services-and-layers guidance):

import { Effect, Layer } from "effect";
import { WorkspaceRepo, WorkspaceRepoLive, SealantDBLive } from "@sealant/db";

const program = Effect.gen(function* () {
  const workspaceRepo = yield* WorkspaceRepo;
  return yield* workspaceRepo.listWorkspaces({ ownerUserId: "user_123", limit: 20 });
});

const appLayer = WorkspaceRepoLive.pipe(Layer.provide(SealantDBLive));

const workspaces = await Effect.runPromise(program.pipe(Effect.provide(appLayer)));
*/
