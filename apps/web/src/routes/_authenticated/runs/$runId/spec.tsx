import { createFileRoute } from "@tanstack/react-router";

import { RunDetailSection } from "@/components/app/run-detail-section";
import { getRunById } from "@/lib/navigation/workspace-data";

export const Route = createFileRoute("/_authenticated/runs/$runId/spec" as never)({
  loader: ({ params }: { params: { runId: string } }) => getRunById(params.runId),
  component: RunSpecPage,
});

function RunSpecPage() {
  const run = Route.useLoaderData() as ReturnType<typeof getRunById>;

  return (
    <RunDetailSection
      run={run}
      section="Spec"
      description="Read the execution specification exactly as applied so the team can verify environment, package, and runtime intent."
    >
      <div className="border border-border bg-muted/20 p-4">
        <pre className="overflow-x-auto font-mono text-[0.68rem] leading-6 text-foreground">
          {`profile: ${run?.profileId ?? "unknown"}
repo: ${run?.repoId ?? "unknown"}
runtime:
 node: "22"
 packageManager: "pnpm"
checks:
 - lint
 - typecheck
 - validation`}
        </pre>
      </div>
    </RunDetailSection>
  );
}
