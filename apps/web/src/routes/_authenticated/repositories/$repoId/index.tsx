import { createFileRoute } from "@tanstack/react-router";

import { RepositoryDetailSection } from "@/components/app/repository-detail-section";
import { getRepositoryById } from "@/lib/navigation/sandbox-data";

export const Route = createFileRoute("/_authenticated/repositories/$repoId/")({
  loader: ({ params }: { params: { repoId: string } }) => getRepositoryById(params.repoId),
  component: RepositoryOverviewPage,
});

function RepositoryOverviewPage() {
  const repository = Route.useLoaderData() as ReturnType<typeof getRepositoryById>;

  return (
    <RepositoryDetailSection
      repository={repository}
      section="Overview"
      description="Review repository ownership, branch posture, and operational health before changing setup or run behavior."
    >
      <div className="rounded-md border border-border">
        {[
          ["Default branch", repository?.branch ?? "Unknown"],
          ["Policy profile", "Operational strict"],
          ["Last synced", "14m ago"],
          ["Pending updates", "2"],
        ].map(([label, value]) => (
          <div
            key={label}
            className="flex items-center justify-between gap-4 border-b border-border px-4 py-3 last:border-b-0"
          >
            <p className="text-sm text-label">{label}</p>
            <p className="font-mono text-[0.72rem] text-foreground">{value}</p>
          </div>
        ))}
      </div>
    </RepositoryDetailSection>
  );
}
