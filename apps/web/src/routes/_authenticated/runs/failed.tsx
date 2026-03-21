import { createFileRoute } from "@tanstack/react-router";

import { RunRows } from "@/components/app/run-rows";
import { WorkspacePage } from "@/components/app/workspace-page";
import { RUNS } from "@/lib/navigation/workspace-data";

export const Route = createFileRoute("/_authenticated/runs/failed" as never)({
  component: FailedRunsPage,
});

function FailedRunsPage() {
  const failedRuns = RUNS.filter((run) => run.status === "failed");

  return (
    <WorkspacePage
      kicker="Runs"
      title="Failed runs"
      description="Review the runs that stopped execution and jump into diff, validation, or trace details without changing context."
      metrics={[
        { label: "Failed", value: String(failedRuns.length) },
        { label: "Escalated", value: "1" },
        { label: "Avg triage", value: "7m" },
      ]}
    >
      <RunRows runs={failedRuns} />
    </WorkspacePage>
  );
}
