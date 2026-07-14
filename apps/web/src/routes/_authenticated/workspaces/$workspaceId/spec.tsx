import type { QueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { WorkspaceDetailSection } from "@/components/app/workspace-detail-section";
import type { AppTrpc } from "@/lib/trpc/client";

export const Route = createFileRoute("/_authenticated/workspaces/$workspaceId/spec")({
  loader: ({
    context,
    params,
  }: {
    context: { queryClient: QueryClient; trpc: AppTrpc };
    params: { workspaceId: string };
  }) => {
    return context.queryClient.ensureQueryData(
      context.trpc.workspace.byId.queryOptions({ workspaceId: params.workspaceId }),
    );
  },
  component: WorkspaceSpecPage,
});

function WorkspaceSpecPage() {
  const workspace = Route.useLoaderData() as {
    workspaceId: string;
    name: string;
    status: "queued" | "running" | "ready" | "failed" | "cancelled" | "stopped";
    repository?: string | undefined;
    tag?: string | undefined;
    spec?: unknown;
  };

  return (
    <WorkspaceDetailSection
      workspace={workspace}
      section="Spec"
      description="Inspect the exact workspace spec payload submitted during creation."
    >
      {workspace.spec === undefined ? (
        <div className="rounded-2xl border border-border bg-popover px-5 py-5 shadow-[var(--shadow-sm)]">
          <p className="font-mono text-[0.68rem] text-muted-foreground">
            Spec payload is not available for this workspace.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-border bg-popover shadow-[var(--shadow-sm)]">
          <div className="flex items-center gap-2.5 border-b border-rule-faint px-5 py-3.5">
            <span className="font-mono text-[0.7rem] tracking-[0.02em] text-label">spec.json</span>
          </div>
          <pre className="overflow-x-auto bg-background p-5 font-mono text-[0.68rem] leading-6 text-ink-2">
            {JSON.stringify(workspace.spec, null, 2)}
          </pre>
        </div>
      )}
    </WorkspaceDetailSection>
  );
}
