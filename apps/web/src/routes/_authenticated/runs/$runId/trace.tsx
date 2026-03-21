import { createFileRoute } from "@tanstack/react-router";

import { RunDetailSection } from "@/components/app/run-detail-section";
import { getRunById } from "@/lib/navigation/workspace-data";

export const Route = createFileRoute("/_authenticated/runs/$runId/trace" as never)({
  loader: ({ params }: { params: { runId: string } }) => getRunById(params.runId),
  component: RunTracePage,
});

function RunTracePage() {
  const run = Route.useLoaderData() as ReturnType<typeof getRunById>;

  return (
    <RunDetailSection
      run={run}
      section="Trace"
      description="Inspect timeline events across the run lifecycle to locate exactly where workflow execution degraded."
    >
      <div className="border border-border">
        {[
          ["00:00", "Environment provisioned"],
          ["00:09", "Spec parsed and dependencies installed"],
          ["00:18", "Validation suite started"],
          ["00:42", "Artifact upload completed"],
        ].map(([time, message]) => (
          <div
            key={`${time}-${message}`}
            className="grid gap-2 border-b border-border px-4 py-3 last:border-b-0 sm:grid-cols-[auto_1fr] sm:items-center"
          >
            <p className="font-mono text-[0.62rem] tracking-[0.13em] text-muted-foreground">
              {time}
            </p>
            <p className="text-sm text-foreground">{message}</p>
          </div>
        ))}
      </div>
    </RunDetailSection>
  );
}
