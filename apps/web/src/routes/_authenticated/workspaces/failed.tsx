import { createFileRoute } from "@tanstack/react-router";

import { WorkspacePage } from "@/components/app/workspace-page";
import { WorkspaceRows } from "@/components/app/workspace-rows";
import { failedWorkspacesQueryOptions } from "@/lib/workspace/workspace.query";

export const Route = createFileRoute("/_authenticated/workspaces/failed")({
  loader: ({ context }) => {
    return context.queryClient.ensureQueryData(failedWorkspacesQueryOptions(context.trpc));
  },
  component: FailedWorkspacesPage,
});

function FailedWorkspacesPage() {
  const failedWorkspaces = Route.useLoaderData().items;

  return (
    <WorkspacePage
      kicker="Workspaces"
      title="Failed workspaces"
      description="Review failed builds, inspect traces, and rerun workspaces with full execution context in one place."
      metrics={[
        { label: "Failed", value: String(failedWorkspaces.length) },
        {
          label: "Latest failure",
          value:
            failedWorkspaces[0] === undefined
              ? "n/a"
              : new Date(failedWorkspaces[0].updatedAt).toLocaleTimeString(),
        },
        { label: "Recovery", value: "Trace + rerun" },
      ]}
    >
      <WorkspaceRows workspaces={failedWorkspaces} />
    </WorkspacePage>
  );
}
