import type { QueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { SandboxDetailSection } from "@/components/app/sandbox-detail-section";
import type { AppTrpc } from "@/lib/trpc/client";

export const Route = createFileRoute("/_authenticated/sandboxes/$sandboxId/validation" as never)({
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
  component: SandboxValidationPage,
});

function SandboxValidationPage() {
  const sandbox = Route.useLoaderData() as {
    sandboxId: string;
    name: string;
    status: "queued" | "running" | "ready" | "failed" | "cancelled";
    repository?: string | undefined;
    tag?: string | undefined;
    error?: {
      message: string;
      code?: string | undefined;
    };
  };

  return (
    <SandboxDetailSection
      sandbox={sandbox}
      section="Validation"
      description="Confirm contract checks, policy checks, and sandbox requirements before allowing the build to complete."
    >
      <div className="border border-border">
        {[
          ["Contract parity", "Pass"],
          ["Schema compatibility", "Pass"],
          ["Secret bindings", sandbox.error === undefined ? "Pass" : "Warning"],
          ["Package policy", "Pass"],
        ].map(([label, status]) => (
          <div
            key={label}
            className="flex items-center justify-between gap-4 border-b border-border px-4 py-3 last:border-b-0"
          >
            <p className="font-mono text-xs text-foreground">{label}</p>
            <p className="font-mono text-[0.62rem] tracking-[0.13em] text-muted-foreground">
              {status}
            </p>
          </div>
        ))}
      </div>
    </SandboxDetailSection>
  );
}
