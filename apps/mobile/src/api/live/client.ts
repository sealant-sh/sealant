import { mockSealantApi } from "../mock/client";
import type { CreateSandboxInput, SealantMobileApi } from "../types/client";
import type { HomeSnapshot } from "../types/models";
import { controlPlaneClient } from "./control-plane-client";

export const liveSealantApi: SealantMobileApi = {
  getHomeSnapshot: async (): Promise<HomeSnapshot> => {
    const [sandboxes, mockSnapshot] = await Promise.all([
      controlPlaneClient.listSandboxes(),
      mockSealantApi.getHomeSnapshot(),
    ]);

    return {
      ...mockSnapshot,
      dataMode: "live",
      activeSandboxes: sandboxes,
    };
  },

  listSandboxes: () => controlPlaneClient.listSandboxes(),
  getSandbox: (sandboxId: string) => controlPlaneClient.getSandbox(sandboxId),
  listSandboxAttempts: (sandboxId: string) => controlPlaneClient.listSandboxAttempts(sandboxId),
  listSandboxEvents: (sandboxId: string) => controlPlaneClient.listSandboxEvents(sandboxId),
  listRepositories: () => mockSealantApi.listRepositories(),
  createSandbox: (input: CreateSandboxInput) => mockSealantApi.createSandbox(input),
  listIssues: () => mockSealantApi.listIssues(),
  getIssue: (issueId: string) => mockSealantApi.getIssue(issueId),
  listIssueWorkflows: () => mockSealantApi.listIssueWorkflows(),
  getIssueWorkflow: (workflowId: string) => mockSealantApi.getIssueWorkflow(workflowId),
  listApprovals: () => mockSealantApi.listApprovals(),
  getApproval: (approvalId: string) => mockSealantApi.getApproval(approvalId),
  listRunRecords: () => mockSealantApi.listRunRecords(),
  getRunRecord: (recordId: string) => mockSealantApi.getRunRecord(recordId),
};
