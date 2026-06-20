import {
  normalizeGitHubIssue,
  normalizeLinearIssue,
  type IssueWorkflowProvider,
  type IssueWorkflowRecord,
} from "@sealant/issues";

export interface IssueWorkflowImportSummary {
  readonly provider: IssueWorkflowProvider;
  readonly label: string;
  readonly count: number;
  readonly source: string;
}

export type LinearImportSearchStatus = "connected" | "configuration" | "error";

export function parseLinearImportSearchStatus(
  value: unknown,
): LinearImportSearchStatus | undefined {
  if (value === "connected" || value === "configuration" || value === "error") {
    return value;
  }

  return undefined;
}

const importedAt = "2026-06-20T09:30:00.000Z";

const gitHubRepository = {
  id: "repo-sealant-core",
  owner: "sealant-ops",
  name: "sealant-core",
  url: "https://github.com/sealant-ops/sealant-core",
};

const gitHubIssuePayloads: readonly unknown[] = [
  {
    id: 90101,
    number: 248,
    title: "Route GitHub installation drift into issue workflows",
    body: "Incoming GitHub installation changes need to be visible before sandbox launch.",
    state: "open",
    labels: [{ name: "ready" }, { name: "p1" }, { name: "integration" }],
    assignees: [{ login: "yiannis" }],
    user: { login: "ops-robot" },
    comments: 7,
    created_at: "2026-06-18T08:15:00Z",
    updated_at: "2026-06-20T07:42:00Z",
    closed_at: null,
    html_url: "https://github.com/sealant-ops/sealant-core/issues/248",
  },
  {
    id: 90102,
    number: 251,
    title: "Capture package validation gaps before profile handoff",
    body: "Profiles should show unresolved package validation issues in the workflow queue.",
    state: "open",
    labels: [{ name: "triage" }, { name: "workflow" }],
    assignees: [],
    user: { login: "field-team" },
    comments: 3,
    created_at: "2026-06-19T13:24:00Z",
    updated_at: "2026-06-20T08:10:00Z",
    closed_at: null,
    html_url: "https://github.com/sealant-ops/sealant-core/issues/251",
  },
  {
    id: 90103,
    number: 253,
    title: "Review generated diff summary before completing workflow",
    body: "The output summary needs validation before the issue workflow is marked complete.",
    state: "open",
    labels: [{ name: "review" }, { name: "p2" }],
    assignees: [{ login: "maia" }],
    user: { login: "qa-platform" },
    comments: 11,
    created_at: "2026-06-17T16:35:00Z",
    updated_at: "2026-06-20T06:02:00Z",
    closed_at: null,
    html_url: "https://github.com/sealant-ops/sealant-core/issues/253",
  },
  {
    id: 90104,
    number: 239,
    title: "Archive completed onboarding issue workflow",
    body: "The onboarding workflow completed and should stop showing as active.",
    state: "closed",
    labels: [{ name: "done" }, { name: "low" }],
    assignees: [{ login: "yiannis" }],
    user: { login: "product-ops" },
    comments: 5,
    created_at: "2026-06-13T10:10:00Z",
    updated_at: "2026-06-19T14:48:00Z",
    closed_at: "2026-06-19T14:48:00Z",
    html_url: "https://github.com/sealant-ops/sealant-core/issues/239",
  },
];

const linearIssuePayloads: readonly unknown[] = [
  {
    id: "b8eb9b69-b7b1-4f87-9e2f-issue-302",
    identifier: "SEL-302",
    number: 302,
    title: "Import Linear triage issues into the workflow board",
    description: "Linear triage should land in the same issue workflow model as GitHub.",
    priority: 2,
    url: "https://linear.app/sealant/issue/SEL-302/import-linear-triage-issues",
    createdAt: "2026-06-18T12:05:00Z",
    updatedAt: "2026-06-20T08:29:00Z",
    completedAt: null,
    canceledAt: null,
    archivedAt: null,
    assignee: { id: "usr-1", name: "Ari Lane", displayName: "Ari" },
    creator: { id: "usr-2", name: "Nia Chen", displayName: "Nia" },
    team: { id: "team-product", name: "Product Systems" },
    project: { id: "proj-workflows", name: "sealant/web" },
    state: { id: "state-triage", name: "Triage", type: "triage" },
    labels: { nodes: [{ id: "label-integration", name: "integration" }] },
  },
  {
    id: "b8eb9b69-b7b1-4f87-9e2f-issue-318",
    identifier: "SEL-318",
    number: 318,
    title: "Start sandbox-backed workflow from imported issue",
    description: "The board should make it obvious which issues are active in a sandbox.",
    priority: 3,
    url: "https://linear.app/sealant/issue/SEL-318/start-sandbox-backed-workflow",
    createdAt: "2026-06-19T09:18:00Z",
    updatedAt: "2026-06-20T09:03:00Z",
    completedAt: null,
    canceledAt: null,
    archivedAt: null,
    assignee: { id: "usr-3", name: "Mika Rao", displayName: "Mika" },
    creator: { id: "usr-2", name: "Nia Chen", displayName: "Nia" },
    team: { id: "team-runtime", name: "Runtime" },
    project: { id: "proj-workflows", name: "sealant/web" },
    state: { id: "state-active", name: "In Progress", type: "started" },
    labels: { nodes: [{ id: "label-workflow", name: "workflow" }] },
  },
  {
    id: "b8eb9b69-b7b1-4f87-9e2f-issue-321",
    identifier: "SEL-321",
    number: 321,
    title: "Prepare issue workflow copy for repository operators",
    description: "Ready issues need concrete language before they move into workflow execution.",
    priority: 4,
    url: "https://linear.app/sealant/issue/SEL-321/prepare-issue-workflow-copy",
    createdAt: "2026-06-19T15:44:00Z",
    updatedAt: "2026-06-20T05:22:00Z",
    completedAt: null,
    canceledAt: null,
    archivedAt: null,
    assignee: { id: "usr-4", name: "Jo Vale", displayName: "Jo" },
    creator: { id: "usr-5", name: "Remy Park", displayName: "Remy" },
    team: { id: "team-product", name: "Product Systems" },
    project: { id: "proj-workflows", name: "sealant/web" },
    state: { id: "state-ready", name: "Ready for workflow", type: "unstarted" },
    labels: { nodes: [{ id: "label-ready", name: "ready" }] },
  },
];

const GITHUB_ISSUE_WORKFLOW_RECORDS = createGitHubIssueWorkflowRecords();
const LINEAR_ISSUE_WORKFLOW_RECORDS = createLinearIssueWorkflowRecords();

export const ISSUE_WORKFLOW_RECORDS: readonly IssueWorkflowRecord[] = [
  ...GITHUB_ISSUE_WORKFLOW_RECORDS,
  ...LINEAR_ISSUE_WORKFLOW_RECORDS,
];

export const ISSUE_WORKFLOW_IMPORT_SUMMARIES: readonly IssueWorkflowImportSummary[] = [
  {
    provider: "github",
    label: "GitHub",
    count: GITHUB_ISSUE_WORKFLOW_RECORDS.length,
    source: "sealant-ops/sealant-core",
  },
  {
    provider: "linear",
    label: "Linear",
    count: LINEAR_ISSUE_WORKFLOW_RECORDS.length,
    source: "Sealant workspace",
  },
];

function createGitHubIssueWorkflowRecords(): readonly IssueWorkflowRecord[] {
  const issues: IssueWorkflowRecord[] = [];

  for (const payload of gitHubIssuePayloads) {
    const issue = normalizeGitHubIssue({
      issue: payload,
      repository: gitHubRepository,
      importedAt,
    });

    if (issue !== null) {
      issues.push(issue);
    }
  }

  return issues;
}

function createLinearIssueWorkflowRecords(): readonly IssueWorkflowRecord[] {
  const issues: IssueWorkflowRecord[] = [];

  for (const payload of linearIssuePayloads) {
    issues.push(
      normalizeLinearIssue({
        issue: payload,
        importedAt,
      }),
    );
  }

  return issues;
}
