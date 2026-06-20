import { useQuery } from "@tanstack/react-query";

import { sealantApi } from "./client";

export const queryKeys = {
  home: ["mobile", "home"],
  sandboxes: ["mobile", "sandboxes"],
  sandbox: (sandboxId: string) => ["mobile", "sandbox", sandboxId],
  sandboxAttempts: (sandboxId: string) => ["mobile", "sandbox", sandboxId, "attempts"],
  sandboxEvents: (sandboxId: string) => ["mobile", "sandbox", sandboxId, "events"],
  repositories: ["mobile", "repositories"],
  issues: ["mobile", "issues"],
  issue: (issueId: string) => ["mobile", "issue", issueId],
  workflows: ["mobile", "workflows"],
  workflow: (workflowId: string) => ["mobile", "workflow", workflowId],
  approvals: ["mobile", "approvals"],
  approval: (approvalId: string) => ["mobile", "approval", approvalId],
  runRecords: ["mobile", "run-records"],
  runRecord: (recordId: string) => ["mobile", "run-record", recordId],
};

export const useHomeSnapshot = () =>
  useQuery({
    queryKey: queryKeys.home,
    queryFn: () => sealantApi.getHomeSnapshot(),
    staleTime: 15_000,
  });

export const useSandboxes = () =>
  useQuery({
    queryKey: queryKeys.sandboxes,
    queryFn: () => sealantApi.listSandboxes(),
    staleTime: 10_000,
  });

export const useSandbox = (sandboxId: string) =>
  useQuery({
    queryKey: queryKeys.sandbox(sandboxId),
    queryFn: () => sealantApi.getSandbox(sandboxId),
    enabled: sandboxId.length > 0,
    staleTime: 10_000,
  });

export const useSandboxAttempts = (sandboxId: string) =>
  useQuery({
    queryKey: queryKeys.sandboxAttempts(sandboxId),
    queryFn: () => sealantApi.listSandboxAttempts(sandboxId),
    enabled: sandboxId.length > 0,
    staleTime: 10_000,
  });

export const useSandboxEvents = (sandboxId: string) =>
  useQuery({
    queryKey: queryKeys.sandboxEvents(sandboxId),
    queryFn: () => sealantApi.listSandboxEvents(sandboxId),
    enabled: sandboxId.length > 0,
    staleTime: 5_000,
  });

export const useRepositories = () =>
  useQuery({
    queryKey: queryKeys.repositories,
    queryFn: () => sealantApi.listRepositories(),
    staleTime: 60_000,
  });

export const useIssues = () =>
  useQuery({
    queryKey: queryKeys.issues,
    queryFn: () => sealantApi.listIssues(),
    staleTime: 30_000,
  });

export const useIssue = (issueId: string) =>
  useQuery({
    queryKey: queryKeys.issue(issueId),
    queryFn: () => sealantApi.getIssue(issueId),
    enabled: issueId.length > 0,
    staleTime: 30_000,
  });

export const useWorkflows = () =>
  useQuery({
    queryKey: queryKeys.workflows,
    queryFn: () => sealantApi.listIssueWorkflows(),
    staleTime: 15_000,
  });

export const useWorkflow = (workflowId: string) =>
  useQuery({
    queryKey: queryKeys.workflow(workflowId),
    queryFn: () => sealantApi.getIssueWorkflow(workflowId),
    enabled: workflowId.length > 0,
    staleTime: 15_000,
  });

export const useApprovals = () =>
  useQuery({
    queryKey: queryKeys.approvals,
    queryFn: () => sealantApi.listApprovals(),
    staleTime: 10_000,
  });

export const useApproval = (approvalId: string) =>
  useQuery({
    queryKey: queryKeys.approval(approvalId),
    queryFn: () => sealantApi.getApproval(approvalId),
    enabled: approvalId.length > 0,
    staleTime: 10_000,
  });

export const useRunRecords = () =>
  useQuery({
    queryKey: queryKeys.runRecords,
    queryFn: () => sealantApi.listRunRecords(),
    staleTime: 30_000,
  });

export const useRunRecord = (recordId: string) =>
  useQuery({
    queryKey: queryKeys.runRecord(recordId),
    queryFn: () => sealantApi.getRunRecord(recordId),
    enabled: recordId.length > 0,
    staleTime: 30_000,
  });
