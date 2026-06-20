export const issueWorkflowProviderValues: readonly ["github", "linear"] = ["github", "linear"];
export type IssueWorkflowProvider = (typeof issueWorkflowProviderValues)[number];

export const issueWorkflowStageValues: readonly ["triage", "ready", "active", "review", "done"] = [
  "triage",
  "ready",
  "active",
  "review",
  "done",
];
export type IssueWorkflowStage = (typeof issueWorkflowStageValues)[number];

export const issueWorkflowPriorityValues: readonly ["none", "low", "medium", "high", "urgent"] = [
  "none",
  "low",
  "medium",
  "high",
  "urgent",
];
export type IssueWorkflowPriority = (typeof issueWorkflowPriorityValues)[number];

export type IssueWorkflowState = "open" | "closed";

export interface IssueWorkflowRepositoryRef {
  readonly id: string | null;
  readonly name: string;
  readonly owner: string | null;
  readonly url: string | null;
}

export interface IssueWorkflowSourceRef {
  readonly provider: IssueWorkflowProvider;
  readonly externalId: string;
  readonly key: string;
  readonly url: string | null;
  readonly importedAt: string;
}

export interface IssueWorkflowRecord {
  readonly id: string;
  readonly provider: IssueWorkflowProvider;
  readonly externalId: string;
  readonly key: string;
  readonly number: number | null;
  readonly title: string;
  readonly description: string | null;
  readonly state: IssueWorkflowState;
  readonly stage: IssueWorkflowStage;
  readonly priority: IssueWorkflowPriority;
  readonly labels: readonly string[];
  readonly repository: IssueWorkflowRepositoryRef;
  readonly teamName: string | null;
  readonly assigneeName: string | null;
  readonly authorName: string | null;
  readonly commentCount: number;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  readonly closedAt: string | null;
  readonly url: string | null;
  readonly source: IssueWorkflowSourceRef;
}

export interface IssueWorkflowImportResult {
  readonly provider: IssueWorkflowProvider;
  readonly importedAt: string;
  readonly issues: readonly IssueWorkflowRecord[];
  readonly pageCount: number;
}

export interface IssueWorkflowBoardColumn {
  readonly id: IssueWorkflowStage;
  readonly title: string;
  readonly description: string;
}

export interface IssueWorkflowBoardOrder {
  readonly triage: readonly string[];
  readonly ready: readonly string[];
  readonly active: readonly string[];
  readonly review: readonly string[];
  readonly done: readonly string[];
}

export interface IssueWorkflowBoardMovement {
  readonly issueId: string;
  readonly sourceStage: IssueWorkflowStage;
  readonly targetStage: IssueWorkflowStage;
  readonly sourceIndex: number;
  readonly targetIndex: number;
}

export class IssueWorkflowImportHttpError extends Error {
  readonly provider: IssueWorkflowProvider;
  readonly statusCode: number;

  constructor(provider: IssueWorkflowProvider, statusCode: number, message: string) {
    super(message);
    this.name = "IssueWorkflowImportHttpError";
    this.provider = provider;
    this.statusCode = statusCode;
  }
}

export class IssueWorkflowImportParseError extends Error {
  readonly provider: IssueWorkflowProvider;

  constructor(provider: IssueWorkflowProvider, message: string) {
    super(message);
    this.name = "IssueWorkflowImportParseError";
    this.provider = provider;
  }
}
