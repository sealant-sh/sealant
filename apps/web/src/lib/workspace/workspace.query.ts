import type { AppTrpc } from "@/lib/trpc/client";

export const sidebarWorkspacesQueryOptions = (trpc: AppTrpc) => {
  return trpc.workspace.list.queryOptions({
    limit: 12,
  });
};

export const allWorkspacesQueryOptions = (trpc: AppTrpc) => {
  return trpc.workspace.list.queryOptions({
    limit: 100,
  });
};

export const runningWorkspacesQueryOptions = (trpc: AppTrpc) => {
  return trpc.workspace.list.queryOptions({
    status: "running",
    limit: 100,
  });
};

export const failedWorkspacesQueryOptions = (trpc: AppTrpc) => {
  return trpc.workspace.list.queryOptions({
    status: "failed",
    limit: 100,
  });
};
