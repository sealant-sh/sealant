import { createFileRoute } from "@tanstack/react-router";

import { RepositoryDetailSection } from "@/components/app/repository-detail-section";
import { getRepositoryById } from "@/lib/navigation/workspace-data";

export const Route = createFileRoute("/_authenticated/repositories/$repoId/settings" as never)({
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
      <div className="border border-border">
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
