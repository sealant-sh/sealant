import { createFileRoute } from "@tanstack/react-router";

import { RunRows } from "@/components/app/run-rows";
import { WorkspacePage } from "@/components/app/workspace-page";
import { RUNS } from "@/lib/navigation/workspace-data";

export const Route = createFileRoute("/_authenticated/runs/active" as never)({
  component: ActiveRunsPage,
});

function ActiveRunsPage() {
  const activeRuns = RUNS.filter((run) => run.status === "active");

  return (
    <WorkspacePage
      kicker="Runs"
      title="Active runs"
      description="Monitor live executions and confirm every delegated issue is progressing inside its expected profile."
      metrics={[
        { label: "Live now", value: String(activeRuns.length) },
        { label: "Queued", value: "3" },
        { label: "Median startup", value: "39s" },
      ]}
    >
      <RunRows runs={activeRuns} />
    </WorkspacePage>
  );
}
