import type { QueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { RunDetailSection } from "@/components/app/run-detail-section";
import type { AppTrpc } from "@/lib/trpc/client";

export const Route = createFileRoute("/_authenticated/runs/$runId/spec" as never)({
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
  component: RunSpecPage,
});

function RunSpecPage() {
  const sandbox = Route.useLoaderData() as {
    sandboxId: string;
    status: "queued" | "running" | "ready" | "failed" | "cancelled";
    repository?: string | undefined;
    tag?: string | undefined;
    spec?: unknown;
  };

  return (
    <RunDetailSection
      sandbox={sandbox}
      section="Spec"
      description="Read the applied sandbox specification so the team can verify environment, package, and runtime intent."
    >
      <div className="border border-border bg-muted/20 p-4">
        <pre className="overflow-x-auto font-mono text-[0.68rem] leading-6 text-foreground">
          {`sandboxId: ${sandbox.sandboxId}
repo: ${sandbox.repository ?? "unknown"}
tag: ${sandbox.tag ?? "unknown"}
runtime:
 node: "22"
 packageManager: "pnpm"
checks:
  - lint
  - typecheck
  - validation

rawSpec:
${JSON.stringify(sandbox.spec ?? {}, null, 2)}`}
        </pre>
      </div>
    </RunDetailSection>
  );
}
