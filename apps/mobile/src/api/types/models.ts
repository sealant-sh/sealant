export type DataMode = "live" | "mock";

export type SandboxStatus = "queued" | "running" | "ready" | "failed" | "cancelled";

export type RiskLevel = "healthy" | "watching" | "needs-review" | "blocked" | "critical";

export type ApprovalKind =
  | "secret-access"
  | "network-escalation"
  | "retry"
  | "pr-creation"
  | "repo-permission";

export type ApprovalStatus = "pending" | "approved" | "rejected";

export type IssueWorkflowStatus =
  | "ready"
  | "queued"
  | "running"
  | "waiting"
  | "completed"
  | "failed";

export type RunRecordStatus = "recording" | "ready" | "attention" | "blocked";

export interface RuntimeRef {
  readonly adapter: "docker" | "k8s" | "k3s";
  readonly resourceId: string;
  readonly reference: string;
  readonly status: "pending" | "running" | "ready" | "failed" | "stopped";
  readonly endpoint?: string;
}

export interface SandboxSummary {
  readonly sandboxId: string;
  readonly name: string;
  readonly ownerUserId: string;
  readonly status: SandboxStatus;
  readonly registryId?: string;
  readonly repository?: string;
  readonly tag?: string;
  readonly runtime?: RuntimeRef;
  readonly error?: {
    readonly message: string;
    readonly code?: string;
  };
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
}

export interface SandboxAttempt {
  readonly attemptId: string;
  readonly relation: "launch" | "rebuild" | "retry" | "resume";
  readonly status: SandboxStatus;
  readonly triggerType: "manual" | "issue" | "schedule" | "api" | "retry";
  readonly triggerRef?: string;
  readonly runtime?: RuntimeRef;
  readonly queuedAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly linkedAt: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly durationMs?: number;
  readonly error?: {
    readonly message: string;
    readonly code?: string;
  };
}

export interface SandboxEvent {
  readonly eventId: string;
  readonly sandboxId: string;
  readonly attemptId?: string;
  readonly type:
    | "sandbox.created"
    | "attempt.queued"
    | "attempt.running"
    | "attempt.succeeded"
    | "attempt.failed"
    | "attempt.cancelled"
    | "image.published"
    | "runtime.pending"
    | "runtime.running"
    | "runtime.failed"
    | "runtime.stopped";
  readonly occurredAt: string;
  readonly message?: string;
}

export interface RepositoryOption {
  readonly repositoryId: string;
  readonly installationRepositoryId: string;
  readonly installationId: string;
  readonly owner: string;
  readonly name: string;
  readonly fullName: string;
  readonly defaultBranch: string;
  readonly isPrivate: boolean;
}

export interface IssueSummary {
  readonly issueId: string;
  readonly repository: string;
  readonly number: number;
  readonly title: string;
  readonly status: "ready" | "blocked" | "running" | "review";
  readonly owner: string;
  readonly labels: readonly string[];
  readonly objective: string;
  readonly risk: RiskLevel;
  readonly updatedAt: string;
}

export interface IssueWorkflowSummary {
  readonly workflowId: string;
  readonly issueId: string;
  readonly sandboxId?: string;
  readonly status: IssueWorkflowStatus;
  readonly harness: string;
  readonly policy: string;
  readonly currentStep: string;
  readonly progressPercent: number;
  readonly startedAt?: string;
  readonly updatedAt: string;
  readonly risk: RiskLevel;
}

export interface ApprovalRequest {
  readonly approvalId: string;
  readonly kind: ApprovalKind;
  readonly status: ApprovalStatus;
  readonly title: string;
  readonly reason: string;
  readonly requestedBy: string;
  readonly linkedWorkflowId?: string;
  readonly linkedSandboxId?: string;
  readonly risk: RiskLevel;
  readonly dueAt: string;
}

export interface TimelineEvent {
  readonly eventId: string;
  readonly phase: string;
  readonly level: "debug" | "info" | "warn" | "error";
  readonly message: string;
  readonly occurredAt: string;
}

export interface ValidationResult {
  readonly checkKey: string;
  readonly status: "pass" | "warn" | "fail" | "skip";
  readonly message: string;
  readonly durationMs?: number;
}

export interface ChangedFileGroup {
  readonly label: string;
  readonly intent: string;
  readonly files: readonly {
    readonly path: string;
    readonly changeType: "added" | "modified" | "deleted" | "renamed";
    readonly additions: number;
    readonly deletions: number;
    readonly risk: RiskLevel;
  }[];
}

export interface RunRecordSummary {
  readonly recordId: string;
  readonly workflowId: string;
  readonly issueId: string;
  readonly title: string;
  readonly status: RunRecordStatus;
  readonly objective: string;
  readonly repository: string;
  readonly branch: string;
  readonly prUrl?: string;
  readonly filesChanged: number;
  readonly commandsRun: number;
  readonly validations: readonly ValidationResult[];
  readonly fileGroups: readonly ChangedFileGroup[];
  readonly timeline: readonly TimelineEvent[];
  readonly risks: readonly {
    readonly level: RiskLevel;
    readonly summary: string;
  }[];
  readonly generatedAt: string;
}

export interface HomeSnapshot {
  readonly dataMode: DataMode;
  readonly activeSandboxes: readonly SandboxSummary[];
  readonly readyIssues: readonly IssueSummary[];
  readonly activeWorkflows: readonly IssueWorkflowSummary[];
  readonly waitingApprovals: readonly ApprovalRequest[];
  readonly recentRunRecords: readonly RunRecordSummary[];
}
