import type { QueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";

import type { AppTrpc } from "@/lib/trpc/client";

// Reserved URL — validation evidence lives on the latest run record; without runs, fall back to the spec.
export const Route = createFileRoute("/_authenticated/sandboxes/$sandboxId/validation")({
  loader: async ({
    context,
    params,
  }: {
    context: { queryClient: QueryClient; trpc: AppTrpc };
    params: { sandboxId: string };
  }) => {
    const runs = await context.queryClient.ensureQueryData(
      context.trpc.run.list.queryOptions({ sandboxId: params.sandboxId, limit: 1 }),
    );
    const latest = runs.items[0];
    if (latest !== undefined) {
      throw redirect({
        to: "/sandboxes/$sandboxId/runs/$runId",
        params: { sandboxId: params.sandboxId, runId: latest.runId },
      });
    }
    throw redirect({ to: "/sandboxes/$sandboxId/spec", params: { sandboxId: params.sandboxId } });
  },
  component: () => null,
});
