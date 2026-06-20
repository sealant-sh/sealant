import {
  firstString,
  isUnknownRecord,
  normalizeDateString,
  readArray,
  readNumber,
  readRecord,
  readRequiredString,
  readString,
  requireRecord,
  toImportedAt,
  type UnknownRecord,
} from "./parsing.js";
import { inferIssueWorkflowStage } from "./stage.js";
import {
  IssueWorkflowImportHttpError,
  IssueWorkflowImportParseError,
  type IssueWorkflowImportResult,
  type IssueWorkflowPriority,
  type IssueWorkflowRecord,
  type IssueWorkflowStage,
  type IssueWorkflowState,
} from "./types.js";

export const defaultLinearGraphqlEndpoint = "https://api.linear.app/graphql";

export type LinearIssueImportAuthorization =
  | {
      readonly kind: "api-key";
      readonly apiKey: string;
    }
  | {
      readonly kind: "oauth";
      readonly accessToken: string;
    };

export interface ParsedLinearIssue {
  readonly externalId: string;
  readonly identifier: string;
  readonly number: number | null;
  readonly title: string;
  readonly description: string | null;
  readonly state: IssueWorkflowState;
  readonly stateName: string | null;
  readonly stateType: string | null;
  readonly priority: IssueWorkflowPriority;
  readonly labels: readonly string[];
  readonly assigneeNames: readonly string[];
  readonly authorName: string | null;
  readonly teamName: string | null;
  readonly projectName: string | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  readonly closedAt: string | null;
  readonly url: string | null;
}

export interface NormalizeLinearIssueOptions {
  readonly issue: unknown;
  readonly importedAt?: Date | string;
  readonly repositoryName?: string;
  readonly stageResolver?: (issue: ParsedLinearIssue) => IssueWorkflowStage;
}

export interface ImportLinearIssuesOptions {
  readonly authorization: LinearIssueImportAuthorization;
  readonly apiEndpoint?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly teamId?: string;
  readonly importedAt?: Date | string;
  readonly first?: number;
  readonly maxPages?: number;
  readonly repositoryName?: string;
  readonly stageResolver?: (issue: ParsedLinearIssue) => IssueWorkflowStage;
}

interface LinearIssuesVariables {
  after: string | null;
  first: number;
  teamId?: string;
}

export function normalizeLinearIssue({
  issue,
  importedAt,
  repositoryName,
  stageResolver,
}: NormalizeLinearIssueOptions): IssueWorkflowRecord {
  const parsedIssue = parseLinearIssue(issue);
  const importedAtValue = toImportedAt(importedAt ?? null);
  const stage = stageResolver?.(parsedIssue) ?? inferLinearIssueWorkflowStage(parsedIssue);
  const repository = repositoryName ?? parsedIssue.projectName ?? "Linear workspace";
  const id = `linear:${parsedIssue.externalId}`;

  return {
    id,
    provider: "linear",
    externalId: parsedIssue.externalId,
    key: parsedIssue.identifier,
    number: parsedIssue.number,
    title: parsedIssue.title,
    description: parsedIssue.description,
    state: parsedIssue.state,
    stage,
    priority: parsedIssue.priority,
    labels: parsedIssue.labels,
    repository: {
      id: null,
      name: repository,
      owner: parsedIssue.teamName,
      url: null,
    },
    teamName: parsedIssue.teamName,
    assigneeName: firstString(parsedIssue.assigneeNames),
    authorName: parsedIssue.authorName,
    commentCount: 0,
    createdAt: parsedIssue.createdAt,
    updatedAt: parsedIssue.updatedAt,
    closedAt: parsedIssue.closedAt,
    url: parsedIssue.url,
    source: {
      provider: "linear",
      externalId: parsedIssue.externalId,
      key: parsedIssue.identifier,
      url: parsedIssue.url,
      importedAt: importedAtValue,
    },
  };
}

export async function importLinearIssues(
  options: ImportLinearIssuesOptions,
): Promise<IssueWorkflowImportResult> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const importedAt = toImportedAt(options.importedAt ?? null);
  const first = clampFirst(options.first ?? 50);
  const maxPages = Math.max(1, options.maxPages ?? 1);
  const issues: IssueWorkflowRecord[] = [];
  let after: string | null = null;
  let pageCount = 0;

  for (let page = 1; page <= maxPages; page += 1) {
    const variables: LinearIssuesVariables = {
      after,
      first,
    };

    if (options.teamId !== undefined) {
      variables.teamId = options.teamId;
    }

    const response = await fetchImpl(options.apiEndpoint ?? defaultLinearGraphqlEndpoint, {
      method: "POST",
      headers: {
        Authorization: createLinearAuthorizationHeader(options.authorization),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: options.teamId === undefined ? linearWorkspaceIssuesQuery : linearTeamIssuesQuery,
        variables,
      }),
    });

    if (!response.ok) {
      throw new IssueWorkflowImportHttpError(
        "linear",
        response.status,
        `Linear issues import failed with status ${response.status}.`,
      );
    }

    const payload: unknown = await response.json();
    const connection = parseLinearIssuesConnection(payload, options.teamId !== undefined);

    for (const item of connection.nodes) {
      issues.push(
        normalizeLinearIssue({
          issue: item,
          importedAt,
          ...(options.repositoryName === undefined
            ? {}
            : { repositoryName: options.repositoryName }),
          ...(options.stageResolver === undefined ? {} : { stageResolver: options.stageResolver }),
        }),
      );
    }

    pageCount = page;

    if (!connection.hasNextPage || connection.endCursor === null) {
      break;
    }

    after = connection.endCursor;
  }

  return {
    provider: "linear",
    importedAt,
    issues,
    pageCount,
  };
}

export function parseLinearIssue(issue: unknown): ParsedLinearIssue {
  const record = requireRecord("linear", issue, "Linear issue");
  const externalId = readRequiredString("linear", record, "id");
  const identifier = readRequiredString("linear", record, "identifier");
  const title = readRequiredString("linear", record, "title");
  const archivedAt = normalizeDateString(readString(record, "archivedAt"));
  const completedAt = normalizeDateString(readString(record, "completedAt"));
  const canceledAt = normalizeDateString(readString(record, "canceledAt"));
  const stateRecord = readRecord(record, "state");
  const stateName = stateRecord === null ? null : readString(stateRecord, "name");
  const stateType = stateRecord === null ? null : readString(stateRecord, "type");
  const assigneeRecord = readRecord(record, "assignee");
  const creatorRecord = readRecord(record, "creator");
  const teamRecord = readRecord(record, "team");
  const projectRecord = readRecord(record, "project");
  const priority = normalizeLinearPriority(readNumber(record, "priority"));
  const labels = readLinearLabels(record);
  const closedAt = completedAt ?? canceledAt ?? archivedAt;
  const state = closedAt === null ? "open" : "closed";

  return {
    externalId,
    identifier,
    number: readNumber(record, "number") ?? parseLinearIssueNumber(identifier),
    title,
    description: readString(record, "description"),
    state,
    stateName,
    stateType,
    priority,
    labels,
    assigneeNames: readLinearUserName(assigneeRecord),
    authorName: firstString(readLinearUserName(creatorRecord)),
    teamName: teamRecord === null ? null : readString(teamRecord, "name"),
    projectName: projectRecord === null ? null : readString(projectRecord, "name"),
    createdAt: normalizeDateString(readString(record, "createdAt")),
    updatedAt: normalizeDateString(readString(record, "updatedAt")),
    closedAt,
    url: readString(record, "url"),
  };
}

export function inferLinearIssueWorkflowStage(issue: ParsedLinearIssue): IssueWorkflowStage {
  return inferIssueWorkflowStage({
    state: issue.stateName,
    stateType: issue.stateType,
    labels: issue.labels,
    closed: issue.state === "closed",
  });
}

function parseLinearIssuesConnection(
  payload: unknown,
  usesTeamQuery: boolean,
): {
  readonly nodes: readonly unknown[];
  readonly hasNextPage: boolean;
  readonly endCursor: string | null;
} {
  const root = requireRecord("linear", payload, "Linear GraphQL response");
  const errors = readArray(root, "errors");

  if (errors.length > 0) {
    throw new IssueWorkflowImportParseError("linear", "Linear GraphQL response returned errors.");
  }

  const data = readRecord(root, "data");

  if (data === null) {
    throw new IssueWorkflowImportParseError("linear", "Linear GraphQL response missing data.");
  }

  const connection = usesTeamQuery
    ? readRecord(readRecord(data, "team") ?? data, "issues")
    : readRecord(data, "issues");

  if (connection === null) {
    throw new IssueWorkflowImportParseError(
      "linear",
      "Linear GraphQL response missing issues connection.",
    );
  }

  const pageInfo = readRecord(connection, "pageInfo");

  return {
    nodes: readArray(connection, "nodes"),
    hasNextPage: pageInfo === null ? false : readBooleanish(pageInfo, "hasNextPage"),
    endCursor: pageInfo === null ? null : readString(pageInfo, "endCursor"),
  };
}

function readBooleanish(record: UnknownRecord, key: string): boolean {
  return record[key] === true;
}

function createLinearAuthorizationHeader(authorization: LinearIssueImportAuthorization): string {
  switch (authorization.kind) {
    case "api-key":
      return authorization.apiKey;
    case "oauth":
      return `Bearer ${authorization.accessToken}`;
  }
}

function readLinearLabels(record: UnknownRecord): readonly string[] {
  const labelsRecord = readRecord(record, "labels");

  if (labelsRecord === null) {
    return [];
  }

  const labels: string[] = [];

  for (const value of readArray(labelsRecord, "nodes")) {
    if (!isUnknownRecord(value)) {
      continue;
    }

    const label = readString(value, "name");

    if (label !== null) {
      labels.push(label);
    }
  }

  return labels;
}

function readLinearUserName(record: UnknownRecord | null): readonly string[] {
  if (record === null) {
    return [];
  }

  const displayName = readString(record, "displayName");
  const name = readString(record, "name");

  if (displayName !== null) {
    return [displayName];
  }

  return name === null ? [] : [name];
}

function normalizeLinearPriority(priority: number | null): IssueWorkflowPriority {
  if (priority === 1) {
    return "urgent";
  }

  if (priority === 2) {
    return "high";
  }

  if (priority === 3) {
    return "medium";
  }

  if (priority === 4) {
    return "low";
  }

  return "none";
}

function parseLinearIssueNumber(identifier: string): number | null {
  const segments = identifier.split("-");
  const maybeNumber = segments[segments.length - 1];

  if (maybeNumber === undefined) {
    return null;
  }

  const parsed = Number.parseInt(maybeNumber, 10);

  return Number.isFinite(parsed) ? parsed : null;
}

function clampFirst(value: number): number {
  if (!Number.isFinite(value)) {
    return 50;
  }

  if (value < 1) {
    return 1;
  }

  if (value > 100) {
    return 100;
  }

  return Math.floor(value);
}

const linearIssueFields = `
  nodes {
    id
    identifier
    number
    title
    description
    priority
    url
    createdAt
    updatedAt
    completedAt
    canceledAt
    archivedAt
    assignee {
      id
      name
      displayName
    }
    creator {
      id
      name
      displayName
    }
    team {
      id
      name
    }
    project {
      id
      name
    }
    state {
      id
      name
      type
    }
    labels {
      nodes {
        id
        name
      }
    }
  }
  pageInfo {
    hasNextPage
    endCursor
  }
`;

const linearWorkspaceIssuesQuery = `
  query SealantIssueWorkflowImport($first: Int!, $after: String) {
    issues(first: $first, after: $after) {
      ${linearIssueFields}
    }
  }
`;

const linearTeamIssuesQuery = `
  query SealantTeamIssueWorkflowImport($teamId: String!, $first: Int!, $after: String) {
    team(id: $teamId) {
      issues(first: $first, after: $after) {
        ${linearIssueFields}
      }
    }
  }
`;
