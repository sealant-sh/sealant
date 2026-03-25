import type { QueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { SandboxDetailSection } from "@/components/app/sandbox-detail-section";
import type { AppTrpc } from "@/lib/trpc/client";

export const Route = createFileRoute("/_authenticated/sandboxes/$sandboxId/spec" as never)({
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
        <div className="border border-border px-4 py-4">
          <p className="font-mono text-[0.68rem] tracking-[0.12em] text-muted-foreground">
            Spec payload is not available for this sandbox.
          </p>
        </div>
      ) : (
        <div className="border border-border bg-muted/20 p-4">
          <pre className="overflow-x-auto font-mono text-[0.68rem] leading-6 text-foreground">
            {JSON.stringify(sandbox.spec, null, 2)}
          </pre>
        </div>
      )}
    </SandboxDetailSection>
  );
}
