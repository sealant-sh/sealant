import type { QueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { RunDetailSection } from "@/components/app/run-detail-section";
import type { AppTrpc } from "@/lib/trpc/client";

export const Route = createFileRoute("/_authenticated/runs/$runId/diff" as never)({
  loader: ({
    context,
    params,
  }: {
    context: { queryClient: QueryClient; trpc: AppTrpc };
    params: { runId: string };
  }) => {
    return context.queryClient.ensureQueryData(
      context.trpc.sandbox.byId.queryOptions({ sandboxId: params.runId }),
    );
  },
  component: RunDiffPage,
});

function RunDiffPage() {
  const sandbox = Route.useLoaderData() as {
    sandboxId: string;
    status: "queued" | "running" | "ready" | "failed" | "cancelled";
    repository?: string | undefined;
    tag?: string | undefined;
  };

  return (
    <RunDetailSection
      sandbox={sandbox}
      section="Diff"
      description="Review exactly what changed in this sandbox attempt before promoting it into broader environment usage."
    >
      <div className="border border-border">
        {[
          ["M", "services/order-allocator/src/validate.ts", "+41 -12"],
          ["A", "services/order-allocator/src/rules/new-rule.ts", "+88"],
          ["M", "profiles/staging-smoke/spec.yaml", "+7 -1"],
        ].map(([kind, path, delta]) => (
          <div
            key={path}
            className="grid gap-2 border-b border-border px-4 py-3 last:border-b-0 sm:grid-cols-[auto_1fr_auto] sm:items-center"
          >
            <span className="font-mono text-[0.62rem] tracking-[0.13em] text-muted-foreground">
              {kind}
            </span>
            <p className="font-mono text-xs text-foreground">{path}</p>
            <p className="font-mono text-[0.62rem] tracking-[0.13em] text-muted-foreground">
              {delta}
            </p>
          </div>
        ))}
      </div>
    </RunDetailSection>
  );
}
