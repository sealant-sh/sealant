import { createFileRoute } from "@tanstack/react-router";

import { RepositoryDetailSection } from "@/components/app/repository-detail-section";
import { getRepositoryById } from "@/lib/navigation/sandbox-data";

export const Route = createFileRoute("/_authenticated/repositories/$repoId/" as never)({
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
      <div className="border border-border">
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
            <p className="font-mono text-[0.62rem] tracking-[0.13em] text-muted-foreground">
              {label}
            </p>
            <p className="text-sm font-semibold text-foreground">{value}</p>
          </div>
        ))}
      </div>
    </RepositoryDetailSection>
  );
}
