import { createFileRoute } from "@tanstack/react-router";

import { SandboxRows } from "@/components/app/sandbox-rows";
import { WorkspacePage } from "@/components/app/workspace-page";
import { allSandboxesQueryOptions } from "@/lib/sandbox/sandbox.query";

export const Route = createFileRoute("/_authenticated/runs/")({
  loader: ({ context }) => {
    return context.queryClient.ensureQueryData(allSandboxesQueryOptions(context.trpc));
  },
  component: SandboxesPage,
});

function SandboxesPage() {
  const sandboxes = Route.useLoaderData().items;
  const runningCount = sandboxes.filter((sandbox) => sandbox.status === "running").length;
  const failedCount = sandboxes.filter((sandbox) => sandbox.status === "failed").length;

  return (
    <WorkspacePage
      kicker="Sandboxes"
      title="Sandbox Fleet"
      description="Track sandbox lifecycle, isolate failed builds quickly, and open detailed traces without leaving this workspace."
      metrics={[
        { label: "Total sandboxes", value: String(sandboxes.length) },
        { label: "Running", value: String(runningCount) },
        { label: "Failed", value: String(failedCount) },
      ]}
    >
      <SandboxRows sandboxes={sandboxes} />
    </WorkspacePage>
  );
}
