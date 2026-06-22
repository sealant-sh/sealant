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
      <div className="rounded-md border border-border">
        {[
          ["Protected branch enforcement", "Enabled"],
          ["Auto rerun on flaky checks", "Disabled"],
          ["Artifact signing", "Enabled"],
          ["Escalation channel", "#sealant-ops"],
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
