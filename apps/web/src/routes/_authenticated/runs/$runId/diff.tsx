import { createFileRoute } from "@tanstack/react-router";

import { RunDetailSection } from "@/components/app/run-detail-section";
import { getRunById } from "@/lib/navigation/workspace-data";

export const Route = createFileRoute("/_authenticated/runs/$runId/diff" as never)({
  loader: ({ params }: { params: { runId: string } }) => getRunById(params.runId),
  component: RunDiffPage,
});

function RunDiffPage() {
  const run = Route.useLoaderData() as ReturnType<typeof getRunById>;

  return (
    <RunDetailSection
      run={run}
      section="Diff"
      description="Review exactly what changed in this execution before promoting it into a broader profile or repository workflow."
    >
      <div className="border border-border">
        {[
          ["M", "services/order-allocator/src/validate.ts", "+41 -12"],
          ["A", "services/order-allocator/src/rules/new-rule.ts", "+88"],
          ["M", "profiles/staging-smoke/spec.yaml", "+7 -1"],
        ].map(([kind, path, delta]) => (
          <div
            key={path}
            className="grid gap-2 border-b border-border px-4 py-3 last:border-b-0 sm:grid-cols-[auto_1fr_auto] sm:items-center"
          >
            <span className="font-mono text-[0.62rem] tracking-[0.13em] text-muted-foreground">
              {kind}
            </span>
            <p className="font-mono text-xs text-foreground">{path}</p>
            <p className="font-mono text-[0.62rem] tracking-[0.13em] text-muted-foreground">
              {delta}
            </p>
          </div>
        ))}
      </div>
    </RunDetailSection>
  );
}
