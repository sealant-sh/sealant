import { createFileRoute } from "@tanstack/react-router";

import { WorkspacePage } from "@/components/app/workspace-page";
import { WorkspaceRows } from "@/components/app/workspace-rows";
import { runningWorkspacesQueryOptions } from "@/lib/workspace/workspace.query";

export const Route = createFileRoute("/_authenticated/workspaces/active")({
  loader: ({ context }) => {
    return context.queryClient.ensureQueryData(runningWorkspacesQueryOptions(context.trpc));
  },
  component: ActiveWorkspacesPage,
});

function ActiveWorkspacesPage() {
  const activeWorkspaces = Route.useLoaderData().items;

  return (
    <WorkspacePage
      kicker="Workspaces"
      title="Running workspaces"
      description="Monitor live workspace builds and verify execution capacity across your active environments."
      metrics={[
        { label: "Running", value: String(activeWorkspaces.length) },
        {
          label: "Latest update",
          value:
            activeWorkspaces[0] === undefined
              ? "n/a"
              : new Date(activeWorkspaces[0].updatedAt).toLocaleTimeString(),
        },
        { label: "Route", value: "/workspaces/active" },
      ]}
    >
      <WorkspaceRows workspaces={activeWorkspaces} />
    </WorkspacePage>
  );
}
