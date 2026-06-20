import type { IssueWorkflowPriority, IssueWorkflowStage } from "./types.js";

export const DEFAULT_ISSUE_WORKFLOW_COLUMNS = [
  {
    id: "triage",
    title: "Triage",
    description: "Needs ownership, source context, or reproduction signal.",
  },
  {
    id: "ready",
    title: "Ready",
    description: "Has enough context to start an issue workflow.",
  },
  {
    id: "active",
    title: "Active",
    description: "Currently moving through a sandbox-backed workflow.",
  },
  {
    id: "review",
    title: "Review",
    description: "Output is waiting for validation or handoff.",
  },
  {
    id: "done",
    title: "Done",
    description: "Completed, closed, or no longer actionable.",
  },
] satisfies ReadonlyArray<{
  readonly id: IssueWorkflowStage;
  readonly title: string;
  readonly description: string;
}>;

export const ISSUE_WORKFLOW_COLUMN_DROP_ID_PREFIX = "issue-workflow-column:";

export function createIssueWorkflowColumnDropId(stage: IssueWorkflowStage): string {
  return `${ISSUE_WORKFLOW_COLUMN_DROP_ID_PREFIX}${stage}`;
}

export function parseIssueWorkflowColumnDropId(value: unknown): IssueWorkflowStage | null {
  if (typeof value !== "string" || !value.startsWith(ISSUE_WORKFLOW_COLUMN_DROP_ID_PREFIX)) {
    return null;
  }

  return parseIssueWorkflowStage(value.slice(ISSUE_WORKFLOW_COLUMN_DROP_ID_PREFIX.length));
}

export function parseIssueWorkflowStage(value: unknown): IssueWorkflowStage | null {
  if (value === "triage") {
    return "triage";
  }

  if (value === "ready") {
    return "ready";
  }

  if (value === "active") {
    return "active";
  }

  if (value === "review") {
    return "review";
  }

  if (value === "done") {
    return "done";
  }

  return null;
}

export function getIssueWorkflowStageLabel(stage: IssueWorkflowStage): string {
  switch (stage) {
    case "triage":
      return "Triage";
    case "ready":
      return "Ready";
    case "active":
      return "Active";
    case "review":
      return "Review";
    case "done":
      return "Done";
  }
}

export function getIssueWorkflowPriorityLabel(priority: IssueWorkflowPriority): string {
  switch (priority) {
    case "none":
      return "No priority";
    case "low":
      return "Low";
    case "medium":
      return "Medium";
    case "high":
      return "High";
    case "urgent":
      return "Urgent";
  }
}

export function inferIssueWorkflowStage(input: {
  readonly state: string | null;
  readonly stateType: string | null;
  readonly labels: readonly string[];
  readonly closed: boolean;
}): IssueWorkflowStage {
  if (input.closed) {
    return "done";
  }

  const searchableText = [input.state, input.stateType, ...input.labels]
    .filter((value) => value !== null)
    .join(" ")
    .toLowerCase();

  if (hasAnyToken(searchableText, ["done", "complete", "completed", "closed", "fixed"])) {
    return "done";
  }

  if (hasAnyToken(searchableText, ["review", "verify", "validation", "handoff", "pr"])) {
    return "review";
  }

  if (
    hasAnyToken(searchableText, ["ready", "unblocked", "todo", "to do", "planned", "unstarted"])
  ) {
    return "ready";
  }

  if (hasAnyToken(searchableText, ["active", "started", "progress", "doing", "working"])) {
    return "active";
  }

  return "triage";
}

export function inferIssueWorkflowPriority(labels: readonly string[]): IssueWorkflowPriority {
  const searchableText = labels.join(" ").toLowerCase();

  if (hasAnyToken(searchableText, ["urgent", "p0", "sev0"])) {
    return "urgent";
  }

  if (hasAnyToken(searchableText, ["high", "p1", "sev1"])) {
    return "high";
  }

  if (hasAnyToken(searchableText, ["medium", "normal", "p2", "sev2"])) {
    return "medium";
  }

  if (hasAnyToken(searchableText, ["low", "p3", "p4"])) {
    return "low";
  }

  return "none";
}

function hasAnyToken(value: string, tokens: readonly string[]): boolean {
  return tokens.some((token) => value.includes(token));
}
