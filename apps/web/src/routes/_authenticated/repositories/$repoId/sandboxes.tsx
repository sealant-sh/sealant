import { createFileRoute } from "@tanstack/react-router";

import { RepositoryDetailSection } from "@/components/app/repository-detail-section";
import { RunRows } from "@/components/app/run-rows";
import { RUNS, getRepositoryById } from "@/lib/navigation/workspace-data";

export const Route = createFileRoute("/_authenticated/repositories/$repoId/sandboxes" as never)({
  loader: ({ params }: { params: { repoId: string } }) => getRepositoryById(params.repoId),
  component: RepositoryRunsPage,
});

function RepositoryRunsPage() {
  const repository = Route.useLoaderData() as ReturnType<typeof getRepositoryById>;
  const runs = RUNS.filter((run) => run.repoId === repository?.id);

  return (
    <RepositoryDetailSection
      repository={repository}
      section="Sandboxes"
      description="Inspect execution history for this repository and open failed sandboxes directly into their detailed workspace navigation."
    >
      <RunRows runs={runs} />
    </RepositoryDetailSection>
  );
}
