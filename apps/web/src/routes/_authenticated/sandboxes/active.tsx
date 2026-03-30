import { createFileRoute } from "@tanstack/react-router";

import { SandboxPage } from "@/components/app/sandbox-page";
import { SandboxRows } from "@/components/app/sandbox-rows";
import { runningSandboxesQueryOptions } from "@/lib/sandbox/sandbox.query";

export const Route = createFileRoute("/_authenticated/sandboxes/active")({
  loader: ({ context }) => {
    return context.queryClient.ensureQueryData(runningSandboxesQueryOptions(context.trpc));
  },
  component: ActiveSandboxesPage,
});

function ActiveSandboxesPage() {
  const activeSandboxes = Route.useLoaderData().items;

  return (
    <SandboxPage
      kicker="Sandboxes"
      title="Running sandboxes"
      description="Monitor live sandbox builds and verify execution capacity across your active environments."
      metrics={[
        { label: "Running", value: String(activeSandboxes.length) },
        {
          label: "Latest update",
          value:
            activeSandboxes[0] === undefined
              ? "n/a"
              : new Date(activeSandboxes[0].updatedAt).toLocaleTimeString(),
        },
        { label: "Route", value: "/sandboxes/active" },
      ]}
    >
      <SandboxRows sandboxes={activeSandboxes} />
    </SandboxPage>
  );
}
