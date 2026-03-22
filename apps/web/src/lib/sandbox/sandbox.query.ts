import type { AppTrpc } from "@/lib/trpc/client";

export const sidebarSandboxesQueryOptions = (trpc: AppTrpc) => {
  return trpc.sandbox.list.queryOptions({
    limit: 12,
  });
};

export const allSandboxesQueryOptions = (trpc: AppTrpc) => {
  return trpc.sandbox.list.queryOptions({
    limit: 100,
  });
};

export const runningSandboxesQueryOptions = (trpc: AppTrpc) => {
  return trpc.sandbox.list.queryOptions({
    status: "running",
    limit: 100,
  });
};

export const failedSandboxesQueryOptions = (trpc: AppTrpc) => {
  return trpc.sandbox.list.queryOptions({
    status: "failed",
    limit: 100,
  });
};
