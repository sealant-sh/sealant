import { createFileRoute } from "@tanstack/react-router";

import { RepositoryDetailSection } from "@/components/app/repository-detail-section";
import { getRepositoryById } from "@/lib/navigation/sandbox-data";

export const Route = createFileRoute("/_authenticated/repositories/$repoId/settings")({
  loader: ({ params }: { params: { repoId: string } }) => getRepositoryById(params.repoId),
  component: RepositorySettingsPage,
});

function RepositorySettingsPage() {
  const repository = Route.useLoaderData() as ReturnType<typeof getRepositoryById>;

  return (
    <RepositoryDetailSection
      repository={repository}
      section="Settings"
      description="Adjust repository-level controls with strict defaults so risk stays explicit and reviewable."
    >
      <div className="overflow-hidden rounded-2xl border border-border bg-popover shadow-[var(--shadow-sm)]">
        <dl className="divide-y divide-rule-faint">
          {[
            ["Protected branch enforcement", "Enabled"],
            ["Auto rerun on flaky checks", "Disabled"],
            ["Artifact signing", "Enabled"],
            ["Escalation channel", "#sealant-ops"],
          ].map(([label, value]) => (
            <div
              key={label}
              className="flex items-baseline justify-between gap-4 px-5 py-3.5"
            >
              <dt className="font-mono text-[0.7rem] tracking-[0.02em] text-label">{label}</dt>
              <dd className="font-mono text-xs text-ink-2">{value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </RepositoryDetailSection>
  );
}
