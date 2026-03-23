import { createFileRoute } from "@tanstack/react-router";

import { SandboxRows } from "@/components/app/sandbox-rows";
import { WorkspacePage } from "@/components/app/workspace-page";
import { failedSandboxesQueryOptions } from "@/lib/sandbox/sandbox.query";

export const Route = createFileRoute("/_authenticated/sandboxes/failed")({
  loader: ({ context }) => {
    return context.queryClient.ensureQueryData(failedSandboxesQueryOptions(context.trpc));
  },
  component: FailedSandboxesPage,
});

function FailedSandboxesPage() {
  const failedSandboxes = Route.useLoaderData().items;

  return (
    <WorkspacePage
      kicker="Sandboxes"
      title="Failed sandboxes"
      description="Review failed builds, inspect traces, and rerun sandboxes with full execution context in one place."
      metrics={[
        { label: "Failed", value: String(failedSandboxes.length) },
        {
          label: "Latest failure",
          value:
            failedSandboxes[0] === undefined
              ? "n/a"
              : new Date(failedSandboxes[0].updatedAt).toLocaleTimeString(),
        },
        { label: "Recovery", value: "Trace + rerun" },
      ]}
    >
      <SandboxRows sandboxes={failedSandboxes} />
    </WorkspacePage>
  );
}
