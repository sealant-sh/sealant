import type { CreateSandboxInput, SealantMobileApi } from "../types/client";
import type { HomeSnapshot, SandboxSummary } from "../types/models";
import {
  mockApprovals,
  mockIssues,
  mockRepositories,
  mockRunRecords,
  mockSandboxAttempts,
  mockSandboxEvents,
  mockSandboxes,
  mockWorkflows,
} from "./mock-data";

const sleep = (durationMs: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, durationMs);
  });

const networkDelay = () => sleep(120);

const findById = <Item>(
  items: readonly Item[],
  getId: (item: Item) => string,
  id: string,
): Item | null => {
  return items.find((item) => getId(item) === id) ?? null;
};

const activeSandboxStatuses: ReadonlySet<SandboxSummary["status"]> = new Set([
  "queued",
  "running",
  "ready",
  "failed",
]);

export const mockSealantApi: SealantMobileApi = {
  getHomeSnapshot: async (): Promise<HomeSnapshot> => {
    await networkDelay();

    return {
      dataMode: "mock",
      activeSandboxes: mockSandboxes.filter((sandbox) => activeSandboxStatuses.has(sandbox.status)),
      readyIssues: mockIssues.filter((issue) => issue.status === "ready"),
      activeWorkflows: mockWorkflows,
      waitingApprovals: mockApprovals.filter((approval) => approval.status === "pending"),
      recentRunRecords: mockRunRecords,
    };
  },

  listSandboxes: async () => {
    await networkDelay();
    return mockSandboxes;
  },

  getSandbox: async (sandboxId: string) => {
    await networkDelay();
    return findById(mockSandboxes, (sandbox) => sandbox.sandboxId, sandboxId);
  },

  listSandboxAttempts: async (sandboxId: string) => {
    await networkDelay();
    return mockSandboxAttempts[sandboxId] ?? [];
  },

  listSandboxEvents: async (sandboxId: string) => {
    await networkDelay();
    return mockSandboxEvents[sandboxId] ?? [];
  },

  listRepositories: async () => {
    await networkDelay();
    return mockRepositories;
  },

  createSandbox: async (input: CreateSandboxInput) => {
    await networkDelay();

    return {
      sandboxId: `sbx-${input.repository.name}-${input.templateTag}`.toLowerCase(),
      name: input.name,
      ownerUserId: "user-demo",
      status: "queued",
      registryId: "default",
      repository: `sealant/sandboxes/${input.repository.name}`,
      tag: input.templateTag,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  },

  listIssues: async () => {
    await networkDelay();
    return mockIssues;
  },

  getIssue: async (issueId: string) => {
    await networkDelay();
    return findById(mockIssues, (issue) => issue.issueId, issueId);
  },

  listIssueWorkflows: async () => {
    await networkDelay();
    return mockWorkflows;
  },

  getIssueWorkflow: async (workflowId: string) => {
    await networkDelay();
    return findById(mockWorkflows, (workflow) => workflow.workflowId, workflowId);
  },

  listApprovals: async () => {
    await networkDelay();
    return mockApprovals;
  },

  getApproval: async (approvalId: string) => {
    await networkDelay();
    return findById(mockApprovals, (approval) => approval.approvalId, approvalId);
  },

  listRunRecords: async () => {
    await networkDelay();
    return mockRunRecords;
  },

  getRunRecord: async (recordId: string) => {
    await networkDelay();
    return findById(mockRunRecords, (record) => record.recordId, recordId);
  },
};
