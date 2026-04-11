import { desc, eq } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";

import { SealantDB } from "../client.js";
import {
  issuePullRequestLinks,
  issues,
  issueWorkflowExecutionPullRequestLinks,
  issueWorkflowExecutions,
  issueWorkflows,
  pullRequests,
  type Issue,
  type IssuePullRequestLink,
  type IssuePullRequestLinkRelation,
  type IssueState,
  type IssueWorkflow,
  type IssueWorkflowExecution,
  type IssueWorkflowExecutionPullRequestLink,
  type IssueWorkflowExecutionPullRequestLinkRelation,
  type IssueWorkflowExecutionStatus,
  type IssueWorkflowExecutionTriggerType,
  type IssueWorkflowStatus,
  type NewIssue,
  type NewIssuePullRequestLink,
  type NewIssueWorkflow,
  type NewIssueWorkflowExecution,
  type NewIssueWorkflowExecutionPullRequestLink,
  type NewPullRequest,
  type PullRequest,
  type PullRequestState,
  type SourceProvider,
} from "../schema.js";

export interface UpsertIssueInput {
  readonly id: string;
  readonly repositoryId: string;
  readonly provider?: SourceProvider;
  readonly externalId?: string;
  readonly number: number;
  readonly title: string;
  readonly state?: IssueState;
  readonly url?: string;
  readonly authorUserId?: string;
  readonly assigneeUserId?: string;
  readonly openedAt?: Date;
  readonly closedAt?: Date;
  readonly syncedAt?: Date;
}

export interface UpsertPullRequestInput {
  readonly id: string;
  readonly repositoryId: string;
  readonly provider?: SourceProvider;
  readonly externalId?: string;
  readonly number: number;
  readonly title: string;
  readonly state?: PullRequestState;
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly headSha?: string;
  readonly url?: string;
  readonly authorUserId?: string;
  readonly openedAt?: Date;
  readonly mergedAt?: Date;
  readonly closedAt?: Date;
  readonly syncedAt?: Date;
}

export interface CreateIssueWorkflowInput {
  readonly id: string;
  readonly issueId: string;
  readonly repositoryId: string;
  readonly ownerUserId?: string;
  readonly requestedByUserId?: string;
  readonly status?: IssueWorkflowStatus;
}

export interface CreateIssueWorkflowExecutionInput {
  readonly id: string;
  readonly issueWorkflowId: string;
  readonly sandboxId?: string;
  readonly sandboxAttemptId?: string;
  readonly status?: IssueWorkflowExecutionStatus;
  readonly triggerType?: IssueWorkflowExecutionTriggerType;
  readonly requestedByUserId?: string;
  readonly queuedAt?: Date;
}

export interface LinkIssueWorkflowExecutionPullRequestInput {
  readonly executionId: string;
  readonly pullRequestId: string;
  readonly relation?: IssueWorkflowExecutionPullRequestLinkRelation;
  readonly linkedAt?: Date;
}

export interface LinkIssuePullRequestInput {
  readonly issueId: string;
  readonly pullRequestId: string;
  readonly relation?: IssuePullRequestLinkRelation;
  readonly linkedAt?: Date;
}

export interface IssueWorkflowExecutionPullRequestRecord {
  readonly link: IssueWorkflowExecutionPullRequestLink;
  readonly pullRequest: PullRequest;
}

/** @deprecated Use IssueWorkflowRepo + IssueWorkflowRepoLive instead. */
export const createIssueWorkflowRepository = (): never => {
  throw new Error("createIssueWorkflowRepository is disabled during the Effect transition.");
};

/** @deprecated Use IssueWorkflowRepoService instead. */
export type IssueWorkflowRepository = IssueWorkflowRepoService;

const issueWorkflowRepoOperationSchema = Schema.Literal(
  "createIssueWorkflow",
  "createIssueWorkflowExecution",
  "linkExecutionPullRequest",
  "linkIssuePullRequest",
  "listExecutionPullRequests",
  "listIssueWorkflows",
  "listWorkflowExecutions",
  "upsertIssue",
  "upsertPullRequest",
);

export class IssueWorkflowRepoInvariantError extends Schema.TaggedError<IssueWorkflowRepoInvariantError>(
  "IssueWorkflowRepoInvariantError",
)("IssueWorkflowRepoInvariantError", {
  operation: issueWorkflowRepoOperationSchema,
  message: Schema.String,
}) {}

export class IssueWorkflowRepoUnexpectedError extends Schema.TaggedError<IssueWorkflowRepoUnexpectedError>(
  "IssueWorkflowRepoUnexpectedError",
)("IssueWorkflowRepoUnexpectedError", {
  operation: issueWorkflowRepoOperationSchema,
  message: Schema.String,
  cause: Schema.Defect,
}) {}

export const issueWorkflowRepoErrorSchema = Schema.Union(
  IssueWorkflowRepoInvariantError,
  IssueWorkflowRepoUnexpectedError,
);

export type IssueWorkflowRepoError = typeof issueWorkflowRepoErrorSchema.Type;

type IssueWorkflowRepoOperation = typeof issueWorkflowRepoOperationSchema.Type;

const mapIssueWorkflowRepoError = (
  operation: IssueWorkflowRepoOperation,
  cause: unknown,
): IssueWorkflowRepoError => {
  if (
    cause instanceof IssueWorkflowRepoInvariantError ||
    cause instanceof IssueWorkflowRepoUnexpectedError
  ) {
    return cause;
  }

  return new IssueWorkflowRepoUnexpectedError({
    operation,
    message: cause instanceof Error ? cause.message : `${operation} failed.`,
    cause,
  });
};

const withIssueWorkflowRepoError = <A>(
  operation: IssueWorkflowRepoOperation,
  effect: Effect.Effect<A, unknown>,
): Effect.Effect<A, IssueWorkflowRepoError> => {
  return effect.pipe(Effect.mapError((cause) => mapIssueWorkflowRepoError(operation, cause)));
};

export interface IssueWorkflowRepoService {
  readonly upsertIssue: (input: UpsertIssueInput) => Effect.Effect<Issue, IssueWorkflowRepoError>;
  readonly upsertPullRequest: (
    input: UpsertPullRequestInput,
  ) => Effect.Effect<PullRequest, IssueWorkflowRepoError>;
  readonly createIssueWorkflow: (
    input: CreateIssueWorkflowInput,
  ) => Effect.Effect<IssueWorkflow, IssueWorkflowRepoError>;
  readonly createIssueWorkflowExecution: (
    input: CreateIssueWorkflowExecutionInput,
  ) => Effect.Effect<IssueWorkflowExecution, IssueWorkflowRepoError>;
  readonly linkExecutionPullRequest: (
    input: LinkIssueWorkflowExecutionPullRequestInput,
  ) => Effect.Effect<IssueWorkflowExecutionPullRequestLink, IssueWorkflowRepoError>;
  readonly linkIssuePullRequest: (
    input: LinkIssuePullRequestInput,
  ) => Effect.Effect<IssuePullRequestLink, IssueWorkflowRepoError>;
  readonly listIssueWorkflows: (
    issueId: string,
  ) => Effect.Effect<readonly IssueWorkflow[], IssueWorkflowRepoError>;
  readonly listWorkflowExecutions: (
    issueWorkflowId: string,
  ) => Effect.Effect<readonly IssueWorkflowExecution[], IssueWorkflowRepoError>;
  readonly listExecutionPullRequests: (
    executionId: string,
  ) => Effect.Effect<readonly IssueWorkflowExecutionPullRequestRecord[], IssueWorkflowRepoError>;
}

export class IssueWorkflowRepo extends Context.Tag("IssueWorkflowRepo")<
  IssueWorkflowRepo,
  IssueWorkflowRepoService
>() {}

export const IssueWorkflowRepoLive = Layer.effect(
  IssueWorkflowRepo,
  Effect.gen(function* () {
    const db = yield* SealantDB;

    return {
      upsertIssue: (input) =>
        withIssueWorkflowRepoError(
          "upsertIssue",
          Effect.gen(function* () {
            const [issue] = yield* db
              .insert(issues)
              .values({
                id: input.id,
                repositoryId: input.repositoryId,
                ...(input.provider === undefined ? {} : { provider: input.provider }),
                ...(input.externalId === undefined ? {} : { externalId: input.externalId }),
                number: input.number,
                title: input.title,
                ...(input.state === undefined ? {} : { state: input.state }),
                ...(input.url === undefined ? {} : { url: input.url }),
                ...(input.authorUserId === undefined ? {} : { authorUserId: input.authorUserId }),
                ...(input.assigneeUserId === undefined
                  ? {}
                  : { assigneeUserId: input.assigneeUserId }),
                ...(input.openedAt === undefined ? {} : { openedAt: input.openedAt }),
                ...(input.closedAt === undefined ? {} : { closedAt: input.closedAt }),
                ...(input.syncedAt === undefined ? {} : { syncedAt: input.syncedAt }),
              } satisfies NewIssue)
              .onConflictDoUpdate({
                target: [issues.provider, issues.repositoryId, issues.number],
                set: {
                  ...(input.externalId === undefined ? {} : { externalId: input.externalId }),
                  title: input.title,
                  ...(input.state === undefined ? {} : { state: input.state }),
                  ...(input.url === undefined ? {} : { url: input.url }),
                  ...(input.authorUserId === undefined ? {} : { authorUserId: input.authorUserId }),
                  ...(input.assigneeUserId === undefined
                    ? {}
                    : { assigneeUserId: input.assigneeUserId }),
                  ...(input.openedAt === undefined ? {} : { openedAt: input.openedAt }),
                  ...(input.closedAt === undefined ? {} : { closedAt: input.closedAt }),
                  ...(input.syncedAt === undefined ? {} : { syncedAt: input.syncedAt }),
                },
              })
              .returning();

            if (issue === undefined) {
              return yield* new IssueWorkflowRepoInvariantError({
                operation: "upsertIssue",
                message: "Failed to upsert issue.",
              });
            }

            return issue;
          }),
        ),

      upsertPullRequest: (input) =>
        withIssueWorkflowRepoError(
          "upsertPullRequest",
          Effect.gen(function* () {
            const [pullRequest] = yield* db
              .insert(pullRequests)
              .values({
                id: input.id,
                repositoryId: input.repositoryId,
                ...(input.provider === undefined ? {} : { provider: input.provider }),
                ...(input.externalId === undefined ? {} : { externalId: input.externalId }),
                number: input.number,
                title: input.title,
                ...(input.state === undefined ? {} : { state: input.state }),
                headBranch: input.headBranch,
                baseBranch: input.baseBranch,
                ...(input.headSha === undefined ? {} : { headSha: input.headSha }),
                ...(input.url === undefined ? {} : { url: input.url }),
                ...(input.authorUserId === undefined ? {} : { authorUserId: input.authorUserId }),
                ...(input.openedAt === undefined ? {} : { openedAt: input.openedAt }),
                ...(input.mergedAt === undefined ? {} : { mergedAt: input.mergedAt }),
                ...(input.closedAt === undefined ? {} : { closedAt: input.closedAt }),
                ...(input.syncedAt === undefined ? {} : { syncedAt: input.syncedAt }),
              } satisfies NewPullRequest)
              .onConflictDoUpdate({
                target: [pullRequests.provider, pullRequests.repositoryId, pullRequests.number],
                set: {
                  ...(input.externalId === undefined ? {} : { externalId: input.externalId }),
                  title: input.title,
                  ...(input.state === undefined ? {} : { state: input.state }),
                  headBranch: input.headBranch,
                  baseBranch: input.baseBranch,
                  ...(input.headSha === undefined ? {} : { headSha: input.headSha }),
                  ...(input.url === undefined ? {} : { url: input.url }),
                  ...(input.authorUserId === undefined ? {} : { authorUserId: input.authorUserId }),
                  ...(input.openedAt === undefined ? {} : { openedAt: input.openedAt }),
                  ...(input.mergedAt === undefined ? {} : { mergedAt: input.mergedAt }),
                  ...(input.closedAt === undefined ? {} : { closedAt: input.closedAt }),
                  ...(input.syncedAt === undefined ? {} : { syncedAt: input.syncedAt }),
                },
              })
              .returning();

            if (pullRequest === undefined) {
              return yield* new IssueWorkflowRepoInvariantError({
                operation: "upsertPullRequest",
                message: "Failed to upsert pull request.",
              });
            }

            return pullRequest;
          }),
        ),

      createIssueWorkflow: (input) =>
        withIssueWorkflowRepoError(
          "createIssueWorkflow",
          Effect.gen(function* () {
            const [workflow] = yield* db
              .insert(issueWorkflows)
              .values({
                id: input.id,
                issueId: input.issueId,
                repositoryId: input.repositoryId,
                ...(input.ownerUserId === undefined ? {} : { ownerUserId: input.ownerUserId }),
                ...(input.requestedByUserId === undefined
                  ? {}
                  : { requestedByUserId: input.requestedByUserId }),
                ...(input.status === undefined ? {} : { status: input.status }),
              } satisfies NewIssueWorkflow)
              .returning();

            if (workflow === undefined) {
              return yield* new IssueWorkflowRepoInvariantError({
                operation: "createIssueWorkflow",
                message: "Failed to create issue workflow.",
              });
            }

            return workflow;
          }),
        ),

      createIssueWorkflowExecution: (input) =>
        withIssueWorkflowRepoError(
          "createIssueWorkflowExecution",
          Effect.gen(function* () {
            const [execution] = yield* db
              .insert(issueWorkflowExecutions)
              .values({
                id: input.id,
                issueWorkflowId: input.issueWorkflowId,
                ...(input.sandboxId === undefined ? {} : { sandboxId: input.sandboxId }),
                ...(input.sandboxAttemptId === undefined
                  ? {}
                  : { sandboxAttemptId: input.sandboxAttemptId }),
                ...(input.status === undefined ? {} : { status: input.status }),
                ...(input.triggerType === undefined ? {} : { triggerType: input.triggerType }),
                ...(input.requestedByUserId === undefined
                  ? {}
                  : { requestedByUserId: input.requestedByUserId }),
                ...(input.queuedAt === undefined ? {} : { queuedAt: input.queuedAt }),
              } satisfies NewIssueWorkflowExecution)
              .returning();

            if (execution === undefined) {
              return yield* new IssueWorkflowRepoInvariantError({
                operation: "createIssueWorkflowExecution",
                message: "Failed to create issue workflow execution.",
              });
            }

            return execution;
          }),
        ),

      linkExecutionPullRequest: (input) =>
        withIssueWorkflowRepoError(
          "linkExecutionPullRequest",
          Effect.gen(function* () {
            const [link] = yield* db
              .insert(issueWorkflowExecutionPullRequestLinks)
              .values({
                executionId: input.executionId,
                pullRequestId: input.pullRequestId,
                ...(input.relation === undefined ? {} : { relation: input.relation }),
                ...(input.linkedAt === undefined ? {} : { linkedAt: input.linkedAt }),
              } satisfies NewIssueWorkflowExecutionPullRequestLink)
              .onConflictDoUpdate({
                target: [
                  issueWorkflowExecutionPullRequestLinks.executionId,
                  issueWorkflowExecutionPullRequestLinks.pullRequestId,
                ],
                set: {
                  ...(input.relation === undefined ? {} : { relation: input.relation }),
                  ...(input.linkedAt === undefined ? {} : { linkedAt: input.linkedAt }),
                },
              })
              .returning();

            if (link === undefined) {
              return yield* new IssueWorkflowRepoInvariantError({
                operation: "linkExecutionPullRequest",
                message: "Failed to link issue workflow execution and pull request.",
              });
            }

            return link;
          }),
        ),

      linkIssuePullRequest: (input) =>
        withIssueWorkflowRepoError(
          "linkIssuePullRequest",
          Effect.gen(function* () {
            const [link] = yield* db
              .insert(issuePullRequestLinks)
              .values({
                issueId: input.issueId,
                pullRequestId: input.pullRequestId,
                ...(input.relation === undefined ? {} : { relation: input.relation }),
                ...(input.linkedAt === undefined ? {} : { linkedAt: input.linkedAt }),
              } satisfies NewIssuePullRequestLink)
              .onConflictDoUpdate({
                target: [issuePullRequestLinks.issueId, issuePullRequestLinks.pullRequestId],
                set: {
                  ...(input.relation === undefined ? {} : { relation: input.relation }),
                  ...(input.linkedAt === undefined ? {} : { linkedAt: input.linkedAt }),
                },
              })
              .returning();

            if (link === undefined) {
              return yield* new IssueWorkflowRepoInvariantError({
                operation: "linkIssuePullRequest",
                message: "Failed to link issue and pull request.",
              });
            }

            return link;
          }),
        ),

      listIssueWorkflows: (issueId) =>
        withIssueWorkflowRepoError(
          "listIssueWorkflows",
          db
            .select()
            .from(issueWorkflows)
            .where(eq(issueWorkflows.issueId, issueId))
            .orderBy(desc(issueWorkflows.createdAt)),
        ),

      listWorkflowExecutions: (issueWorkflowId) =>
        withIssueWorkflowRepoError(
          "listWorkflowExecutions",
          db
            .select()
            .from(issueWorkflowExecutions)
            .where(eq(issueWorkflowExecutions.issueWorkflowId, issueWorkflowId))
            .orderBy(desc(issueWorkflowExecutions.createdAt)),
        ),

      listExecutionPullRequests: (executionId) =>
        withIssueWorkflowRepoError(
          "listExecutionPullRequests",
          Effect.gen(function* () {
            const rows = yield* db.query.issueWorkflowExecutionPullRequestLinks.findMany({
              where: { executionId },
              with: { pullRequest: true },
              orderBy: { linkedAt: "desc" },
            });

            return rows.flatMap((row) => {
              if (row.pullRequest === null) {
                return [];
              }

              return [
                {
                  link: {
                    executionId: row.executionId,
                    pullRequestId: row.pullRequestId,
                    relation: row.relation,
                    linkedAt: row.linkedAt,
                  },
                  pullRequest: row.pullRequest,
                },
              ];
            });
          }),
        ),
    } satisfies IssueWorkflowRepoService;
  }),
);
