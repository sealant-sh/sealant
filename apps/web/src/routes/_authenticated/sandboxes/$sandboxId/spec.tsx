import type { QueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { SandboxDetailSection } from "@/components/app/sandbox-detail-section";
import type { AppTrpc } from "@/lib/trpc/client";

export const Route = createFileRoute("/_authenticated/sandboxes/$sandboxId/spec")({
  loader: ({
    context,
    params,
  }: {
    context: { queryClient: QueryClient; trpc: AppTrpc };
    params: { sandboxId: string };
  }) => {
    return context.queryClient.ensureQueryData(
      context.trpc.sandbox.byId.queryOptions({ sandboxId: params.sandboxId }),
    );
  },
  component: SandboxSpecPage,
});

function SandboxSpecPage() {
  const sandbox = Route.useLoaderData() as {
    sandboxId: string;
    name: string;
    status: "queued" | "running" | "ready" | "failed" | "cancelled";
    repository?: string | undefined;
    tag?: string | undefined;
    spec?: unknown;
  };

  return (
    <SandboxDetailSection
      sandbox={sandbox}
      section="Spec"
      description="Inspect the exact sandbox spec payload submitted during creation."
    >
      {sandbox.spec === undefined ? (
        <div className="rounded-2xl border border-border bg-popover px-5 py-5 shadow-[var(--shadow-sm)]">
          <p className="font-mono text-[0.68rem] text-muted-foreground">
            Spec payload is not available for this sandbox.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-border bg-popover shadow-[var(--shadow-sm)]">
          <div className="flex items-center gap-2.5 border-b border-rule-faint px-5 py-3.5">
            <span className="font-mono text-[0.7rem] tracking-[0.02em] text-label">spec.json</span>
          </div>
          <pre className="overflow-x-auto bg-background p-5 font-mono text-[0.68rem] leading-6 text-ink-2">
            {JSON.stringify(sandbox.spec, null, 2)}
          </pre>
        </div>
      )}
    </SandboxDetailSection>
  );
}
