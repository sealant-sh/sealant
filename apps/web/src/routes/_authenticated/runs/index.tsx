import { createFileRoute } from "@tanstack/react-router";

import { RunRows } from "@/components/app/run-rows";
import { WorkspacePage } from "@/components/app/workspace-page";
import { RUNS } from "@/lib/navigation/workspace-data";

export const Route = createFileRoute("/_authenticated/runs/" as never)({
  component: RunsPage,
});

function RunsPage() {
  const activeCount = RUNS.filter((run) => run.status === "active").length;
  const failedCount = RUNS.filter((run) => run.status === "failed").length;

  return (
    <WorkspacePage
      kicker="Runs"
      title="Execution History"
      description="Track every execution, isolate failed workflows quickly, and open run workspaces without leaving this surface."
      metrics={[
        { label: "Total runs", value: String(RUNS.length) },
        { label: "Active", value: String(activeCount) },
        { label: "Failed", value: String(failedCount) },
      ]}
    >
      <RunRows runs={RUNS} />
    </WorkspacePage>
  );
}
