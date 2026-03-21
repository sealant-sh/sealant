import { createFileRoute } from "@tanstack/react-router";

import { RunDetailSection } from "@/components/app/run-detail-section";
import { getRunById } from "@/lib/navigation/workspace-data";

export const Route = createFileRoute("/_authenticated/runs/$runId/validation" as never)({
  loader: ({ params }: { params: { runId: string } }) => getRunById(params.runId),
  component: RunValidationPage,
});

function RunValidationPage() {
  const run = Route.useLoaderData() as ReturnType<typeof getRunById>;

  return (
    <RunDetailSection
      run={run}
      section="Validation"
      description="Confirm contract checks, policy checks, and profile requirements before allowing the run to complete."
    >
      <div className="border border-border">
        {[
          ["Contract parity", "Pass"],
          ["Schema compatibility", "Pass"],
          ["Secret bindings", "Warning"],
          ["Package policy", "Pass"],
        ].map(([label, status]) => (
          <div key={label} className="flex items-center justify-between gap-4 border-b border-border px-4 py-3 last:border-b-0">
            <p className="font-mono text-xs text-foreground">{label}</p>
            <p className="font-mono text-[0.62rem] uppercase tracking-[0.13em] text-muted-foreground">{status}</p>
          </div>
        ))}
      </div>
    </RunDetailSection>
  );
}
