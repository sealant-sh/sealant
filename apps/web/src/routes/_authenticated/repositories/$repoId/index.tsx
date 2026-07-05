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
      <div className="overflow-hidden rounded-2xl border border-border bg-popover shadow-[var(--shadow-sm)]">
        <dl className="divide-y divide-rule-faint">
          {[
            ["Default branch", repository?.branch ?? "Unknown"],
            ["Policy profile", "Operational strict"],
            ["Last synced", "14m ago"],
            ["Pending updates", "2"],
          ].map(([label, value]) => (
            <div key={label} className="flex items-baseline justify-between gap-4 px-5 py-3.5">
              <dt className="font-mono text-[0.7rem] tracking-[0.02em] text-label">{label}</dt>
              <dd className="font-mono text-xs text-ink-2">{value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </RepositoryDetailSection>
  );
}
