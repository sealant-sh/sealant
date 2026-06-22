import { createFileRoute } from "@tanstack/react-router";

import { RepositoryDetailSection } from "@/components/app/repository-detail-section";
import { getRepositoryById } from "@/lib/navigation/sandbox-data";

export const Route = createFileRoute("/_authenticated/repositories/$repoId/setup")({
  loader: ({ params }: { params: { repoId: string } }) => getRepositoryById(params.repoId),
  component: RepositorySetupPage,
});

function RepositorySetupPage() {
  const repository = Route.useLoaderData() as ReturnType<typeof getRepositoryById>;

  return (
    <RepositoryDetailSection
      repository={repository}
      section="Setup"
      description="Keep setup contracts explicit so each run starts with predictable build, validation, and runtime behavior."
    >
      <div className="grid gap-px border border-border bg-border sm:grid-cols-2">
        {[
          ["Package manager", "pnpm"],
          ["Node runtime", "22"],
          ["Validation preset", "strict"],
          ["Artifact retention", "14 days"],
        ].map(([label, value]) => (
          <div key={label} className="bg-card px-4 py-4">
            <p className="ev-eyebrow">{label}</p>
            <p className="mt-2 font-mono text-[0.78rem] text-foreground">{value}</p>
          </div>
        ))}
      </div>
    </RepositoryDetailSection>
  );
}
