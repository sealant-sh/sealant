import type { QueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";

import type { AppTrpc } from "@/lib/trpc/client";

// Reserved URL — a workspace's diff lives on its latest run record; without runs, fall back to the spec.
export const Route = createFileRoute("/_authenticated/workspaces/$workspaceId/diff")({
  loader: async ({
    context,
    params,
  }: {
    context: { queryClient: QueryClient; trpc: AppTrpc };
    params: { workspaceId: string };
  }) => {
    const runs = await context.queryClient.ensureQueryData(
      context.trpc.run.list.queryOptions({ workspaceId: params.workspaceId, limit: 1 }),
    );
    const latest = runs.items[0];
    if (latest !== undefined) {
      throw redirect({
        to: "/workspaces/$workspaceId/runs/$runId",
        params: { workspaceId: params.workspaceId, runId: latest.runId },
      });
    }
    throw redirect({
      to: "/workspaces/$workspaceId/spec",
      params: { workspaceId: params.workspaceId },
    });
  },
  component: () => null,
});
