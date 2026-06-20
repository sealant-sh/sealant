import {
  firstString,
  isUnknownRecord,
  normalizeDateString,
  readArray,
  readNumber,
  readRecord,
  readRequiredNumber,
  readRequiredString,
  readString,
  requireArray,
  requireRecord,
  toImportedAt,
  type UnknownRecord,
} from "./parsing.js";
import { inferIssueWorkflowPriority, inferIssueWorkflowStage } from "./stage.js";
import {
  IssueWorkflowImportHttpError,
  IssueWorkflowImportParseError,
  type IssueWorkflowImportResult,
  type IssueWorkflowPriority,
  type IssueWorkflowRecord,
  type IssueWorkflowStage,
  type IssueWorkflowState,
} from "./types.js";

export const defaultGitHubIssuesApiBaseUrl = "https://api.github.com";
export const defaultGitHubRestApiVersion = "2022-11-28";

export interface GitHubIssueImportRepository {
  readonly id: string | null;
  readonly owner: string;
  readonly name: string;
  readonly url: string | null;
}

export interface ParsedGitHubIssue {
  readonly externalId: string;
  readonly number: number;
  readonly title: string;
  readonly description: string | null;
  readonly state: IssueWorkflowState;
  readonly labels: readonly string[];
  readonly assigneeNames: readonly string[];
  readonly authorName: string | null;
  readonly commentCount: number;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  readonly closedAt: string | null;
  readonly url: string | null;
}

export interface NormalizeGitHubIssueOptions {
  readonly issue: unknown;
  readonly repository: GitHubIssueImportRepository;
  readonly importedAt?: Date | string;
  readonly stageResolver?: (issue: ParsedGitHubIssue) => IssueWorkflowStage;
}

export interface ImportGitHubIssuesOptions {
  readonly repository: GitHubIssueImportRepository;
  readonly token?: string;
  readonly apiBaseUrl?: string;
  readonly apiVersion?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly importedAt?: Date | string;
  readonly state?: IssueWorkflowState | "all";
  readonly labels?: readonly string[];
  readonly since?: Date | string;
  readonly perPage?: number;
  readonly maxPages?: number;
  readonly stageResolver?: (issue: ParsedGitHubIssue) => IssueWorkflowStage;
}

export function normalizeGitHubIssue({
  issue,
  repository,
  importedAt,
  stageResolver,
}: NormalizeGitHubIssueOptions): IssueWorkflowRecord | null {
  const parsedIssue = parseGitHubIssue(issue);

  if (parsedIssue === null) {
    return null;
  }

  const importedAtValue = toImportedAt(importedAt ?? null);
  const stage = stageResolver?.(parsedIssue) ?? inferGitHubIssueWorkflowStage(parsedIssue);
  const priority = inferGitHubIssueWorkflowPriority(parsedIssue);
  const fullName = `${repository.owner}/${repository.name}`;
  const key = `${fullName}#${parsedIssue.number}`;
  const id = `github:${repository.owner}/${repository.name}:${parsedIssue.externalId}`;

  return {
    id,
    provider: "github",
    externalId: parsedIssue.externalId,
    key,
    number: parsedIssue.number,
    title: parsedIssue.title,
    description: parsedIssue.description,
    state: parsedIssue.state,
    stage,
    priority,
    labels: parsedIssue.labels,
    repository: {
      id: repository.id,
      name: fullName,
      owner: repository.owner,
      url: repository.url,
    },
    teamName: null,
    assigneeName: firstString(parsedIssue.assigneeNames),
    authorName: parsedIssue.authorName,
    commentCount: parsedIssue.commentCount,
    createdAt: parsedIssue.createdAt,
    updatedAt: parsedIssue.updatedAt,
    closedAt: parsedIssue.closedAt,
    url: parsedIssue.url,
    source: {
      provider: "github",
      externalId: parsedIssue.externalId,
      key,
      url: parsedIssue.url,
      importedAt: importedAtValue,
    },
  };
}

export async function importGitHubIssues(
  options: ImportGitHubIssuesOptions,
): Promise<IssueWorkflowImportResult> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const apiBaseUrl = options.apiBaseUrl ?? defaultGitHubIssuesApiBaseUrl;
  const apiVersion = options.apiVersion ?? defaultGitHubRestApiVersion;
  const importedAt = toImportedAt(options.importedAt ?? null);
  const perPage = clampPerPage(options.perPage ?? 50);
  const maxPages = Math.max(1, options.maxPages ?? 1);
  const issues: IssueWorkflowRecord[] = [];
  let pageCount = 0;

  for (let page = 1; page <= maxPages; page += 1) {
    const url = createGitHubIssuesUrl(apiBaseUrl, options, perPage, page);
    const response = await fetchImpl(url, {
      headers: createGitHubHeaders(options.token, apiVersion),
    });

    if (!response.ok) {
      throw new IssueWorkflowImportHttpError(
        "github",
        response.status,
        `GitHub issues import failed with status ${response.status}.`,
      );
    }

    const payload: unknown = await response.json();
    const pageItems = requireArray("github", payload, "GitHub issues response");

    for (const item of pageItems) {
      const normalizedIssue = normalizeGitHubIssue({
        issue: item,
        repository: options.repository,
        importedAt,
        ...(options.stageResolver === undefined ? {} : { stageResolver: options.stageResolver }),
      });

      if (normalizedIssue !== null) {
        issues.push(normalizedIssue);
      }
    }

    pageCount = page;

    if (pageItems.length < perPage) {
      break;
    }
  }

  return {
    provider: "github",
    importedAt,
    issues,
    pageCount,
  };
}

export function parseGitHubIssue(issue: unknown): ParsedGitHubIssue | null {
  const record = requireRecord("github", issue, "GitHub issue");

  if (readRecord(record, "pull_request") !== null) {
    return null;
  }

  const externalId = String(readRequiredNumber("github", record, "id"));
  const number = readRequiredNumber("github", record, "number");
  const title = readRequiredString("github", record, "title");
  const stateText = readRequiredString("github", record, "state");
  const state = stateText === "closed" ? "closed" : "open";
  const body = readString(record, "body");
  const labels = readGitHubLabels(record);
  const assigneeNames = readGitHubAssignees(record);
  const user = readRecord(record, "user");
  const authorName = user === null ? null : readString(user, "login");
  const commentCount = readNumber(record, "comments") ?? 0;

  return {
    externalId,
    number,
    title,
    description: body,
    state,
    labels,
    assigneeNames,
    authorName,
    commentCount,
    createdAt: normalizeDateString(readString(record, "created_at")),
    updatedAt: normalizeDateString(readString(record, "updated_at")),
    closedAt: normalizeDateString(readString(record, "closed_at")),
    url: readString(record, "html_url"),
  };
}

export function inferGitHubIssueWorkflowStage(issue: ParsedGitHubIssue): IssueWorkflowStage {
  return inferIssueWorkflowStage({
    state: issue.state,
    stateType: null,
    labels: issue.labels,
    closed: issue.state === "closed",
  });
}

export function inferGitHubIssueWorkflowPriority(issue: ParsedGitHubIssue): IssueWorkflowPriority {
  return inferIssueWorkflowPriority(issue.labels);
}

function createGitHubIssuesUrl(
  apiBaseUrl: string,
  options: ImportGitHubIssuesOptions,
  perPage: number,
  page: number,
): string {
  const url = new URL(
    `/repos/${encodeURIComponent(options.repository.owner)}/${encodeURIComponent(options.repository.name)}/issues`,
    apiBaseUrl,
  );

  url.searchParams.set("state", options.state ?? "open");
  url.searchParams.set("per_page", String(perPage));
  url.searchParams.set("page", String(page));

  if (options.labels !== undefined && options.labels.length > 0) {
    url.searchParams.set("labels", options.labels.join(","));
  }

  if (options.since !== undefined) {
    const since =
      options.since instanceof Date
        ? options.since.toISOString()
        : normalizeDateString(options.since);

    if (since !== null) {
      url.searchParams.set("since", since);
    }
  }

  return url.toString();
}

function createGitHubHeaders(token: string | undefined, apiVersion: string): HeadersInit {
  const headers = new Headers({
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": apiVersion,
  });

  if (token !== undefined && token.length > 0) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  return headers;
}

function readGitHubLabels(record: UnknownRecord): readonly string[] {
  const labels: string[] = [];

  for (const value of readArray(record, "labels")) {
    if (typeof value === "string" && value.length > 0) {
      labels.push(value);
      continue;
    }

    if (isUnknownRecord(value)) {
      const name = readString(value, "name");

      if (name !== null) {
        labels.push(name);
      }
    }
  }

  return labels;
}

function readGitHubAssignees(record: UnknownRecord): readonly string[] {
  const assignees: string[] = [];

  for (const value of readArray(record, "assignees")) {
    if (!isUnknownRecord(value)) {
      continue;
    }

    const login = readString(value, "login");

    if (login !== null) {
      assignees.push(login);
    }
  }

  return assignees;
}

function clampPerPage(value: number): number {
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
