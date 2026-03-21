import { asc, desc, eq } from "drizzle-orm";

import type { DatabaseClient } from "../client.js";
import {
  issuePullRequestLinks,
  issueRunLinks,
  issues,
  pullRequests,
  runPullRequestLinks,
  workspaceRuns,
  type Issue,
  type IssuePullRequestLink,
  type IssuePullRequestLinkRelation,
  type IssueRunLink,
  type IssueRunLinkRelation,
  type IssueState,
  type NewIssue,
  type NewIssuePullRequestLink,
  type NewIssueRunLink,
  type NewPullRequest,
  type NewRunPullRequestLink,
  type PullRequest,
  type PullRequestState,
  type RunPullRequestLink,
  type RunPullRequestLinkRelation,
  type SourceProvider,
  type WorkspaceRun,
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

export interface LinkIssueRunInput {
  readonly issueId: string;
  readonly runId: string;
  readonly relation?: IssueRunLinkRelation;
  readonly linkedAt?: Date;
}

export interface LinkRunPullRequestInput {
  readonly runId: string;
  readonly pullRequestId: string;
  readonly relation?: RunPullRequestLinkRelation;
  readonly linkedAt?: Date;
}

export interface LinkIssuePullRequestInput {
  readonly issueId: string;
  readonly pullRequestId: string;
  readonly relation?: IssuePullRequestLinkRelation;
  readonly linkedAt?: Date;
}

export interface IssueRunRecord {
  readonly link: IssueRunLink;
  readonly run: WorkspaceRun;
}

export interface RunPullRequestRecord {
  readonly link: RunPullRequestLink;
  readonly pullRequest: PullRequest;
}

const assertInserted = <T>(row: T | undefined, message: string): T => {
  if (row === undefined) {
    throw new Error(message);
  }

  return row;
};

export const createLineageRepository = (client: DatabaseClient) => {
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

  const linkIssueRun = async (input: LinkIssueRunInput): Promise<IssueRunLink> => {
    const [link] = await db
      .insert(issueRunLinks)
      .values({
        issueId: input.issueId,
        runId: input.runId,
        ...(input.relation === undefined ? {} : { relation: input.relation }),
        ...(input.linkedAt === undefined ? {} : { linkedAt: input.linkedAt }),
      } satisfies NewIssueRunLink)
      .onConflictDoUpdate({
        target: [issueRunLinks.issueId, issueRunLinks.runId],
        set: {
          ...(input.relation === undefined ? {} : { relation: input.relation }),
          ...(input.linkedAt === undefined ? {} : { linkedAt: input.linkedAt }),
        },
      })
      .returning();

    return assertInserted(link, "Failed to link issue and run.");
  };

  const linkRunPullRequest = async (
    input: LinkRunPullRequestInput,
  ): Promise<RunPullRequestLink> => {
    const [link] = await db
      .insert(runPullRequestLinks)
      .values({
        runId: input.runId,
        pullRequestId: input.pullRequestId,
        ...(input.relation === undefined ? {} : { relation: input.relation }),
        ...(input.linkedAt === undefined ? {} : { linkedAt: input.linkedAt }),
      } satisfies NewRunPullRequestLink)
      .onConflictDoUpdate({
        target: [runPullRequestLinks.runId, runPullRequestLinks.pullRequestId],
        set: {
          ...(input.relation === undefined ? {} : { relation: input.relation }),
          ...(input.linkedAt === undefined ? {} : { linkedAt: input.linkedAt }),
        },
      })
      .returning();

    return assertInserted(link, "Failed to link run and pull request.");
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

  const listIssueRuns = async (issueId: string): Promise<readonly IssueRunRecord[]> => {
    const rows = await db
      .select({
        link: issueRunLinks,
        run: workspaceRuns,
      })
      .from(issueRunLinks)
      .innerJoin(workspaceRuns, eq(workspaceRuns.id, issueRunLinks.runId))
      .where(eq(issueRunLinks.issueId, issueId))
      .orderBy(desc(workspaceRuns.createdAt));

    return rows;
  };

  const listRunPullRequests = async (runId: string): Promise<readonly RunPullRequestRecord[]> => {
    const rows = await db
      .select({
        link: runPullRequestLinks,
        pullRequest: pullRequests,
      })
      .from(runPullRequestLinks)
      .innerJoin(pullRequests, eq(pullRequests.id, runPullRequestLinks.pullRequestId))
      .where(eq(runPullRequestLinks.runId, runId))
      .orderBy(desc(runPullRequestLinks.linkedAt), asc(pullRequests.number));

    return rows;
  };

  return {
    linkIssuePullRequest,
    linkIssueRun,
    linkRunPullRequest,
    listIssueRuns,
    listRunPullRequests,
    upsertIssue,
    upsertPullRequest,
  };
};

export type LineageRepository = ReturnType<typeof createLineageRepository>;
