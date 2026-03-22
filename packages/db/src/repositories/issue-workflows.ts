import { asc, desc, eq } from "drizzle-orm";

import type { DatabaseClient } from "../client.js";
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

const assertInserted = <T>(row: T | undefined, message: string): T => {
  if (row === undefined) {
    throw new Error(message);
  }

  return row;
};

export const createIssueWorkflowRepository = (client: DatabaseClient) => {
  const { db } = client;

  const upsertIssue = async (input: UpsertIssueInput): Promise<Issue> => {
    const [issue] = await db
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
        ...(input.assigneeUserId === undefined ? {} : { assigneeUserId: input.assigneeUserId }),
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
          ...(input.assigneeUserId === undefined ? {} : { assigneeUserId: input.assigneeUserId }),
          ...(input.openedAt === undefined ? {} : { openedAt: input.openedAt }),
          ...(input.closedAt === undefined ? {} : { closedAt: input.closedAt }),
          ...(input.syncedAt === undefined ? {} : { syncedAt: input.syncedAt }),
        },
      })
      .returning();

    return assertInserted(issue, "Failed to upsert issue.");
  };

  const upsertPullRequest = async (input: UpsertPullRequestInput): Promise<PullRequest> => {
    const [pullRequest] = await db
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

    return assertInserted(pullRequest, "Failed to upsert pull request.");
  };

  const createIssueWorkflow = async (input: CreateIssueWorkflowInput): Promise<IssueWorkflow> => {
    const [workflow] = await db
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

    return assertInserted(workflow, "Failed to create issue workflow.");
  };

  const createIssueWorkflowExecution = async (
    input: CreateIssueWorkflowExecutionInput,
  ): Promise<IssueWorkflowExecution> => {
    const [execution] = await db
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

    return assertInserted(execution, "Failed to create issue workflow execution.");
  };

  const linkExecutionPullRequest = async (
    input: LinkIssueWorkflowExecutionPullRequestInput,
  ): Promise<IssueWorkflowExecutionPullRequestLink> => {
    const [link] = await db
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

    return assertInserted(link, "Failed to link issue workflow execution and pull request.");
  };

  const linkIssuePullRequest = async (
    input: LinkIssuePullRequestInput,
  ): Promise<IssuePullRequestLink> => {
    const [link] = await db
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

    return assertInserted(link, "Failed to link issue and pull request.");
  };

  const listIssueWorkflows = async (issueId: string): Promise<readonly IssueWorkflow[]> => {
    return db
      .select()
      .from(issueWorkflows)
      .where(eq(issueWorkflows.issueId, issueId))
      .orderBy(desc(issueWorkflows.createdAt));
  };

  const listWorkflowExecutions = async (
    issueWorkflowId: string,
  ): Promise<readonly IssueWorkflowExecution[]> => {
    return db
      .select()
      .from(issueWorkflowExecutions)
      .where(eq(issueWorkflowExecutions.issueWorkflowId, issueWorkflowId))
      .orderBy(desc(issueWorkflowExecutions.createdAt));
  };

  const listExecutionPullRequests = async (
    executionId: string,
  ): Promise<readonly IssueWorkflowExecutionPullRequestRecord[]> => {
    return db
      .select({
        link: issueWorkflowExecutionPullRequestLinks,
        pullRequest: pullRequests,
      })
      .from(issueWorkflowExecutionPullRequestLinks)
      .innerJoin(
        pullRequests,
        eq(pullRequests.id, issueWorkflowExecutionPullRequestLinks.pullRequestId),
      )
      .where(eq(issueWorkflowExecutionPullRequestLinks.executionId, executionId))
      .orderBy(desc(issueWorkflowExecutionPullRequestLinks.linkedAt), asc(pullRequests.number));
  };

  return {
    createIssueWorkflow,
    createIssueWorkflowExecution,
    linkExecutionPullRequest,
    linkIssuePullRequest,
    listExecutionPullRequests,
    listIssueWorkflows,
    listWorkflowExecutions,
    upsertIssue,
    upsertPullRequest,
  };
};

export type IssueWorkflowRepository = ReturnType<typeof createIssueWorkflowRepository>;
