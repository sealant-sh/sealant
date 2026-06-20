import type {
  ApprovalRequest,
  IssueSummary,
  IssueWorkflowSummary,
  RepositoryOption,
  RuntimeRef,
  RunRecordSummary,
  SandboxAttempt,
  SandboxEvent,
  SandboxSummary,
} from "../types/models";

const phaseRunnerRuntime: RuntimeRef = {
  adapter: "docker",
  resourceId: "container-issue-workflow-runtime",
  reference: "sealant/sandboxes/issue-workflow-runtime:node-22",
  status: "running",
  endpoint: "ssh://sbx-sbx-phase1-runner@ssh.sealant.dev:22",
};

const apiContractsRuntime: RuntimeRef = {
  adapter: "docker",
  resourceId: "container-api-contracts",
  reference: "sealant/sandboxes/api-contracts:effect",
  status: "running",
  endpoint: "ssh://sbx-sbx-api-contracts@ssh.sealant.dev:22",
};

export const mockRepositories: readonly RepositoryOption[] = [
  {
    repositoryId: "repo-sealant-core",
    installationRepositoryId: "install-repo-sealant-core",
    installationId: "gh-install-sealant",
    owner: "Selant",
    name: "sealant-core",
    fullName: "Selant/sealant-core",
    defaultBranch: "main",
    isPrivate: true,
  },
  {
    repositoryId: "repo-runtime-daemon",
    installationRepositoryId: "install-repo-runtime-daemon",
    installationId: "gh-install-sealant",
    owner: "Selant",
    name: "sealantd",
    fullName: "Selant/sealantd",
    defaultBranch: "main",
    isPrivate: true,
  },
];

export const mockSandboxes: readonly SandboxSummary[] = [
  {
    sandboxId: "sbx-phase1-runner",
    name: "Issue workflow runtime",
    ownerUserId: "user-demo",
    status: "running",
    registryId: "default",
    repository: "sealant/sandboxes/issue-workflow-runtime",
    tag: "node-22",
    runtime: phaseRunnerRuntime,
    createdAt: "2026-06-20T08:32:00.000Z",
    updatedAt: "2026-06-20T08:44:00.000Z",
    startedAt: "2026-06-20T08:34:00.000Z",
  },
  {
    sandboxId: "sbx-api-contracts",
    name: "API contracts review",
    ownerUserId: "user-demo",
    status: "ready",
    registryId: "default",
    repository: "sealant/sandboxes/api-contracts",
    tag: "effect",
    runtime: apiContractsRuntime,
    createdAt: "2026-06-20T07:12:00.000Z",
    updatedAt: "2026-06-20T07:31:00.000Z",
    startedAt: "2026-06-20T07:15:00.000Z",
  },
  {
    sandboxId: "sbx-registry-sync",
    name: "Registry sync repro",
    ownerUserId: "user-demo",
    status: "failed",
    registryId: "default",
    repository: "sealant/sandboxes/registry-sync",
    tag: "nix",
    error: {
      message: "Package resolution failed for libsecret during build.",
      code: "package-resolution",
    },
    createdAt: "2026-06-20T06:50:00.000Z",
    updatedAt: "2026-06-20T06:58:00.000Z",
    startedAt: "2026-06-20T06:52:00.000Z",
    finishedAt: "2026-06-20T06:58:00.000Z",
  },
];

export const mockSandboxAttempts: Record<string, readonly SandboxAttempt[]> = {
  "sbx-phase1-runner": [
    {
      attemptId: "attempt-phase1-launch",
      relation: "launch",
      status: "running",
      triggerType: "issue",
      triggerRef: "issue-314",
      runtime: phaseRunnerRuntime,
      queuedAt: "2026-06-20T08:32:00.000Z",
      createdAt: "2026-06-20T08:32:00.000Z",
      updatedAt: "2026-06-20T08:44:00.000Z",
      linkedAt: "2026-06-20T08:32:01.000Z",
      startedAt: "2026-06-20T08:34:00.000Z",
    },
  ],
  "sbx-api-contracts": [
    {
      attemptId: "attempt-api-contracts-launch",
      relation: "launch",
      status: "ready",
      triggerType: "manual",
      runtime: apiContractsRuntime,
      queuedAt: "2026-06-20T07:12:00.000Z",
      createdAt: "2026-06-20T07:12:00.000Z",
      updatedAt: "2026-06-20T07:31:00.000Z",
      linkedAt: "2026-06-20T07:12:03.000Z",
      startedAt: "2026-06-20T07:15:00.000Z",
      finishedAt: "2026-06-20T07:31:00.000Z",
      durationMs: 960000,
    },
  ],
  "sbx-registry-sync": [
    {
      attemptId: "attempt-registry-sync-launch",
      relation: "launch",
      status: "failed",
      triggerType: "manual",
      queuedAt: "2026-06-20T06:50:00.000Z",
      createdAt: "2026-06-20T06:50:00.000Z",
      updatedAt: "2026-06-20T06:58:00.000Z",
      linkedAt: "2026-06-20T06:50:01.000Z",
      startedAt: "2026-06-20T06:52:00.000Z",
      finishedAt: "2026-06-20T06:58:00.000Z",
      durationMs: 360000,
      error: {
        message: "Package resolution failed for libsecret during build.",
        code: "package-resolution",
      },
    },
  ],
};

export const mockSandboxEvents: Record<string, readonly SandboxEvent[]> = {
  "sbx-phase1-runner": [
    {
      eventId: "event-phase1-created",
      sandboxId: "sbx-phase1-runner",
      attemptId: "attempt-phase1-launch",
      type: "sandbox.created",
      occurredAt: "2026-06-20T08:32:00.000Z",
      message: "Sandbox created from Selant/sealant-core.",
    },
    {
      eventId: "event-phase1-running",
      sandboxId: "sbx-phase1-runner",
      attemptId: "attempt-phase1-launch",
      type: "attempt.running",
      occurredAt: "2026-06-20T08:34:00.000Z",
      message: "Build worker started the runtime image build.",
    },
    {
      eventId: "event-phase1-runtime",
      sandboxId: "sbx-phase1-runner",
      attemptId: "attempt-phase1-launch",
      type: "runtime.running",
      occurredAt: "2026-06-20T08:41:00.000Z",
      message: "Runtime is available for commands and evidence capture.",
    },
  ],
  "sbx-api-contracts": [
    {
      eventId: "event-api-created",
      sandboxId: "sbx-api-contracts",
      attemptId: "attempt-api-contracts-launch",
      type: "sandbox.created",
      occurredAt: "2026-06-20T07:12:00.000Z",
      message: "Sandbox created from registry template.",
    },
    {
      eventId: "event-api-ready",
      sandboxId: "sbx-api-contracts",
      attemptId: "attempt-api-contracts-launch",
      type: "attempt.succeeded",
      occurredAt: "2026-06-20T07:31:00.000Z",
      message: "Sandbox is ready.",
    },
  ],
  "sbx-registry-sync": [
    {
      eventId: "event-registry-created",
      sandboxId: "sbx-registry-sync",
      attemptId: "attempt-registry-sync-launch",
      type: "sandbox.created",
      occurredAt: "2026-06-20T06:50:00.000Z",
      message: "Sandbox created from package-backed template.",
    },
    {
      eventId: "event-registry-failed",
      sandboxId: "sbx-registry-sync",
      attemptId: "attempt-registry-sync-launch",
      type: "attempt.failed",
      occurredAt: "2026-06-20T06:58:00.000Z",
      message: "Build failed during package resolution.",
    },
  ],
};

export const mockIssues: readonly IssueSummary[] = [
  {
    issueId: "issue-314",
    repository: "Selant/sealant-core",
    number: 314,
    title: "Expose issue workflow run record summary to reviewers",
    status: "ready",
    owner: "Yiannis",
    labels: ["issue workflow", "review"],
    objective: "Create a reviewer packet that explains commands, files, validation, and PR state.",
    risk: "needs-review",
    updatedAt: "2026-06-20T08:25:00.000Z",
  },
  {
    issueId: "issue-302",
    repository: "Selant/sealant-core",
    number: 302,
    title: "Add registry catalog endpoint for sandbox templates",
    status: "blocked",
    owner: "Control Plane",
    labels: ["sandboxes", "api"],
    objective: "Expose repository catalog data that mobile can use for sandbox creation.",
    risk: "watching",
    updatedAt: "2026-06-20T06:40:00.000Z",
  },
];

export const mockWorkflows: readonly IssueWorkflowSummary[] = [
  {
    workflowId: "workflow-314",
    issueId: "issue-314",
    sandboxId: "sbx-phase1-runner",
    status: "waiting",
    harness: "opencode",
    policy: "standard-review",
    currentStep: "Waiting for network escalation approval",
    progressPercent: 64,
    startedAt: "2026-06-20T08:32:00.000Z",
    updatedAt: "2026-06-20T08:47:00.000Z",
    risk: "needs-review",
  },
];

export const mockApprovals: readonly ApprovalRequest[] = [
  {
    approvalId: "approval-network-314",
    kind: "network-escalation",
    status: "pending",
    title: "Approve outbound network for dependency audit",
    reason: "The workflow needs to fetch registry metadata for two packages before validation.",
    requestedBy: "workflow-314",
    linkedWorkflowId: "workflow-314",
    linkedSandboxId: "sbx-phase1-runner",
    risk: "needs-review",
    dueAt: "2026-06-20T09:02:00.000Z",
  },
  {
    approvalId: "approval-pr-302",
    kind: "pr-creation",
    status: "pending",
    title: "Approve PR creation for registry catalog endpoint",
    reason:
      "Validation passed, but the API surface is new and should be confirmed before opening a PR.",
    requestedBy: "workflow-302",
    risk: "watching",
    dueAt: "2026-06-20T10:30:00.000Z",
  },
];

export const mockRunRecords: readonly RunRecordSummary[] = [
  {
    recordId: "record-314",
    workflowId: "workflow-314",
    issueId: "issue-314",
    title: "Run Record: reviewer packet for issue workflow",
    status: "attention",
    objective: "Make issue workflow output understandable on mobile in under 60 seconds.",
    repository: "Selant/sealant-core",
    branch: "agent/issue-workflow-review-packet",
    prUrl: "https://github.com/Selant/sealant-core/pull/314",
    filesChanged: 7,
    commandsRun: 5,
    validations: [
      {
        checkKey: "format",
        status: "pass",
        message: "Formatting completed.",
        durationMs: 12000,
      },
      {
        checkKey: "typecheck",
        status: "warn",
        message: "Issue workflow HTTP contracts are still mocked for mobile.",
        durationMs: 42000,
      },
      {
        checkKey: "tests",
        status: "skip",
        message: "No mobile test harness exists yet.",
      },
    ],
    fileGroups: [
      {
        label: "Mobile review surface",
        intent: "Show compressed evidence before opening a PR.",
        files: [
          {
            path: "apps/mobile/src/app/run-records/[recordId].tsx",
            changeType: "added",
            additions: 212,
            deletions: 0,
            risk: "needs-review",
          },
          {
            path: "apps/mobile/src/features/run-record/review-packet.tsx",
            changeType: "added",
            additions: 168,
            deletions: 0,
            risk: "watching",
          },
        ],
      },
      {
        label: "Data boundary",
        intent: "Keep planned evidence data behind a swappable adapter.",
        files: [
          {
            path: "apps/mobile/src/api/mock/mock-data.ts",
            changeType: "added",
            additions: 380,
            deletions: 0,
            risk: "healthy",
          },
        ],
      },
    ],
    timeline: [
      {
        eventId: "timeline-314-objective",
        phase: "objective",
        level: "info",
        message: "Issue workflow started from ready inbox.",
        occurredAt: "2026-06-20T08:32:00.000Z",
      },
      {
        eventId: "timeline-314-commands",
        phase: "commands",
        level: "info",
        message: "Installed dependencies, generated mobile scaffold, ran validation.",
        occurredAt: "2026-06-20T08:43:00.000Z",
      },
      {
        eventId: "timeline-314-risk",
        phase: "risk",
        level: "warn",
        message: "Network escalation required for registry metadata fetch.",
        occurredAt: "2026-06-20T08:47:00.000Z",
      },
    ],
    risks: [
      {
        level: "needs-review",
        summary: "New mobile data model mirrors planned backend tables but is not live yet.",
      },
      {
        level: "watching",
        summary: "PR creation should wait for issue workflow endpoints.",
      },
    ],
    generatedAt: "2026-06-20T08:49:00.000Z",
  },
];
