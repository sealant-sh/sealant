import { createFileRoute } from "@tanstack/react-router";

import { WorkspacePage } from "@/components/app/workspace-page";
import { WorkspaceRows } from "@/components/app/workspace-rows";
import { allWorkspacesQueryOptions } from "@/lib/workspace/workspace.query";

export const Route = createFileRoute("/_authenticated/workspaces/")({
  loader: ({ context }) => {
    return context.queryClient.ensureQueryData(allWorkspacesQueryOptions(context.trpc));
  },
  component: WorkspacesPage,
});

function WorkspacesPage() {
  const workspaces = Route.useLoaderData().items;
  const runningCount = workspaces.filter((workspace) => workspace.status === "running").length;
  const failedCount = workspaces.filter((workspace) => workspace.status === "failed").length;

  return (
    <WorkspacePage
      kicker="Workspaces"
      title="Workspace Fleet"
      description="Track workspace lifecycle, isolate failed builds quickly, and open detailed traces without leaving this workspace."
      metrics={[
        { label: "Total workspaces", value: String(workspaces.length) },
        { label: "Running", value: String(runningCount) },
        { label: "Failed", value: String(failedCount) },
      ]}
    >
      <WorkspaceRows workspaces={workspaces} />
    </WorkspacePage>
  );
}
