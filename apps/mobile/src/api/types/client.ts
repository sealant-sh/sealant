import type {
  ApprovalRequest,
  HomeSnapshot,
  IssueSummary,
  IssueWorkflowSummary,
  RepositoryOption,
  RunRecordSummary,
  SandboxAttempt,
  SandboxEvent,
  SandboxSummary,
} from "./models";

export interface CreateSandboxInput {
  readonly repository: RepositoryOption;
  readonly ref: string;
  readonly templateTag: string;
  readonly name: string;
}

export interface SealantMobileApi {
  readonly getHomeSnapshot: () => Promise<HomeSnapshot>;
  readonly listSandboxes: () => Promise<readonly SandboxSummary[]>;
  readonly getSandbox: (sandboxId: string) => Promise<SandboxSummary | null>;
  readonly listSandboxAttempts: (sandboxId: string) => Promise<readonly SandboxAttempt[]>;
  readonly listSandboxEvents: (sandboxId: string) => Promise<readonly SandboxEvent[]>;
  readonly listRepositories: () => Promise<readonly RepositoryOption[]>;
  readonly createSandbox: (input: CreateSandboxInput) => Promise<SandboxSummary>;
  readonly listIssues: () => Promise<readonly IssueSummary[]>;
  readonly getIssue: (issueId: string) => Promise<IssueSummary | null>;
  readonly listIssueWorkflows: () => Promise<readonly IssueWorkflowSummary[]>;
  readonly getIssueWorkflow: (workflowId: string) => Promise<IssueWorkflowSummary | null>;
  readonly listApprovals: () => Promise<readonly ApprovalRequest[]>;
  readonly getApproval: (approvalId: string) => Promise<ApprovalRequest | null>;
  readonly listRunRecords: () => Promise<readonly RunRecordSummary[]>;
  readonly getRunRecord: (recordId: string) => Promise<RunRecordSummary | null>;
}
