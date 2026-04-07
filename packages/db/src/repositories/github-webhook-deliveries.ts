import { desc, eq } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";

import { SealantDB } from "../client.js";
import {
  githubWebhookDeliveries,
  type GitHubWebhookDelivery,
  type GitHubWebhookDeliveryStatus,
  type NewGitHubWebhookDelivery,
} from "../schema.js";

export interface CreateGitHubWebhookDeliveryInput {
  readonly id: string;
  readonly deliveryId: string;
  readonly eventType: string;
  readonly action?: string;
  readonly installationExternalId?: string;
  readonly payload?: Record<string, unknown>;
  readonly receivedAt?: Date;
  readonly status?: GitHubWebhookDeliveryStatus;
  readonly processedAt?: Date;
  readonly errorMessage?: string;
}

/** @deprecated Use GitHubWebhookDeliveryRepo + GitHubWebhookDeliveryRepoLive instead. */
export const createGitHubWebhookDeliveryRepository = (): never => {
  throw new Error(
    "createGitHubWebhookDeliveryRepository is disabled during the Effect transition.",
  );
};

/** @deprecated Use GitHubWebhookDeliveryRepoService instead. */
export type GitHubWebhookDeliveryRepository = GitHubWebhookDeliveryRepoService;

const gitHubWebhookDeliveryRepoOperationSchema = Schema.Literal(
  "createWebhookDelivery",
  "getWebhookDeliveryByDeliveryId",
  "listWebhookDeliveries",
  "markWebhookDeliveryFailed",
  "markWebhookDeliveryProcessed",
);

export class GitHubWebhookDeliveryRepoInvariantError extends Schema.TaggedError<GitHubWebhookDeliveryRepoInvariantError>(
  "GitHubWebhookDeliveryRepoInvariantError",
)("GitHubWebhookDeliveryRepoInvariantError", {
  operation: gitHubWebhookDeliveryRepoOperationSchema,
  message: Schema.String,
}) {}

export class GitHubWebhookDeliveryRepoUnexpectedError extends Schema.TaggedError<GitHubWebhookDeliveryRepoUnexpectedError>(
  "GitHubWebhookDeliveryRepoUnexpectedError",
)("GitHubWebhookDeliveryRepoUnexpectedError", {
  operation: gitHubWebhookDeliveryRepoOperationSchema,
  message: Schema.String,
  cause: Schema.Defect,
}) {}

export const gitHubWebhookDeliveryRepoErrorSchema = Schema.Union(
  GitHubWebhookDeliveryRepoInvariantError,
  GitHubWebhookDeliveryRepoUnexpectedError,
);

export type GitHubWebhookDeliveryRepoError = typeof gitHubWebhookDeliveryRepoErrorSchema.Type;

type GitHubWebhookDeliveryRepoOperation = typeof gitHubWebhookDeliveryRepoOperationSchema.Type;

const mapGitHubWebhookDeliveryRepoError = (
  operation: GitHubWebhookDeliveryRepoOperation,
  cause: unknown,
): GitHubWebhookDeliveryRepoError => {
  if (
    cause instanceof GitHubWebhookDeliveryRepoInvariantError ||
    cause instanceof GitHubWebhookDeliveryRepoUnexpectedError
  ) {
    return cause;
  }

  return new GitHubWebhookDeliveryRepoUnexpectedError({
    operation,
    message: cause instanceof Error ? cause.message : `${operation} failed.`,
    cause,
  });
};

const withGitHubWebhookDeliveryRepoError = <A>(
  operation: GitHubWebhookDeliveryRepoOperation,
  effect: Effect.Effect<A, unknown>,
): Effect.Effect<A, GitHubWebhookDeliveryRepoError> => {
  return effect.pipe(
    Effect.mapError((cause) => mapGitHubWebhookDeliveryRepoError(operation, cause)),
  );
};

export interface GitHubWebhookDeliveryRepoService {
  readonly createWebhookDelivery: (
    input: CreateGitHubWebhookDeliveryInput,
  ) => Effect.Effect<GitHubWebhookDelivery, GitHubWebhookDeliveryRepoError>;
  readonly getWebhookDeliveryByDeliveryId: (
    deliveryId: string,
  ) => Effect.Effect<GitHubWebhookDelivery | undefined, GitHubWebhookDeliveryRepoError>;
  readonly markWebhookDeliveryProcessed: (input: {
    readonly deliveryId: string;
    readonly processedAt?: Date;
    readonly status?: Extract<GitHubWebhookDeliveryStatus, "processed" | "ignored">;
  }) => Effect.Effect<GitHubWebhookDelivery | null, GitHubWebhookDeliveryRepoError>;
  readonly markWebhookDeliveryFailed: (input: {
    readonly deliveryId: string;
    readonly errorMessage: string;
    readonly processedAt?: Date;
  }) => Effect.Effect<GitHubWebhookDelivery | null, GitHubWebhookDeliveryRepoError>;
  readonly listWebhookDeliveries: (
    limit?: number,
  ) => Effect.Effect<readonly GitHubWebhookDelivery[], GitHubWebhookDeliveryRepoError>;
}

export class GitHubWebhookDeliveryRepo extends Context.Tag("GitHubWebhookDeliveryRepo")<
  GitHubWebhookDeliveryRepo,
  GitHubWebhookDeliveryRepoService
>() {}

export const GitHubWebhookDeliveryRepoLive = Layer.effect(
  GitHubWebhookDeliveryRepo,
  Effect.gen(function* () {
    const db = yield* SealantDB;

    const getWebhookDeliveryByDeliveryId = (deliveryId: string) =>
      withGitHubWebhookDeliveryRepoError(
        "getWebhookDeliveryByDeliveryId",
        Effect.gen(function* () {
          const [delivery] = yield* db
            .select()
            .from(githubWebhookDeliveries)
            .where(eq(githubWebhookDeliveries.deliveryId, deliveryId))
            .limit(1);

          return delivery;
        }),
      );

    return {
      createWebhookDelivery: (input) =>
        withGitHubWebhookDeliveryRepoError(
          "createWebhookDelivery",
          Effect.gen(function* () {
            const [delivery] = yield* db
              .insert(githubWebhookDeliveries)
              .values({
                id: input.id,
                deliveryId: input.deliveryId,
                eventType: input.eventType,
                ...(input.action === undefined ? {} : { action: input.action }),
                ...(input.installationExternalId === undefined
                  ? {}
                  : { installationExternalId: input.installationExternalId }),
                ...(input.payload === undefined ? {} : { payload: input.payload }),
                ...(input.receivedAt === undefined ? {} : { receivedAt: input.receivedAt }),
                ...(input.status === undefined ? {} : { status: input.status }),
                ...(input.processedAt === undefined ? {} : { processedAt: input.processedAt }),
                ...(input.errorMessage === undefined ? {} : { errorMessage: input.errorMessage }),
              } satisfies NewGitHubWebhookDelivery)
              .onConflictDoNothing({ target: githubWebhookDeliveries.deliveryId })
              .returning();

            if (delivery !== undefined) {
              return delivery;
            }

            const existing = yield* getWebhookDeliveryByDeliveryId(input.deliveryId);
            if (existing === undefined) {
              return yield* new GitHubWebhookDeliveryRepoInvariantError({
                operation: "createWebhookDelivery",
                message: "Failed to create or retrieve GitHub webhook delivery.",
              });
            }

            return existing;
          }),
        ),

      getWebhookDeliveryByDeliveryId,

      markWebhookDeliveryProcessed: (input) =>
        withGitHubWebhookDeliveryRepoError(
          "markWebhookDeliveryProcessed",
          Effect.gen(function* () {
            const [delivery] = yield* db
              .update(githubWebhookDeliveries)
              .set({
                status: input.status ?? "processed",
                processedAt: input.processedAt ?? new Date(),
                errorMessage: null,
              })
              .where(eq(githubWebhookDeliveries.deliveryId, input.deliveryId))
              .returning();

            return delivery ?? null;
          }),
        ),

      markWebhookDeliveryFailed: (input) =>
        withGitHubWebhookDeliveryRepoError(
          "markWebhookDeliveryFailed",
          Effect.gen(function* () {
            const [delivery] = yield* db
              .update(githubWebhookDeliveries)
              .set({
                status: "failed",
                errorMessage: input.errorMessage,
                processedAt: input.processedAt ?? new Date(),
              })
              .where(eq(githubWebhookDeliveries.deliveryId, input.deliveryId))
              .returning();

            return delivery ?? null;
          }),
        ),

      listWebhookDeliveries: (limit = 100) =>
        withGitHubWebhookDeliveryRepoError(
          "listWebhookDeliveries",
          db
            .select()
            .from(githubWebhookDeliveries)
            .orderBy(desc(githubWebhookDeliveries.receivedAt))
            .limit(limit),
        ),
    } satisfies GitHubWebhookDeliveryRepoService;
  }),
);
