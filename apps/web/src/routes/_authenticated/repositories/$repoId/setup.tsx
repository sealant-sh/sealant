import { createFileRoute } from "@tanstack/react-router";

import { RepositoryDetailSection } from "@/components/app/repository-detail-section";
import { getRepositoryById } from "@/lib/navigation/workspace-data";

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
      <div className="grid gap-4 sm:grid-cols-2">
        {[
          ["Package manager", "pnpm"],
          ["Node runtime", "22"],
          ["Validation preset", "strict"],
          ["Artifact retention", "14 days"],
        ].map(([label, value]) => (
          <div
            key={label}
            className="rounded-2xl border border-border bg-popover px-5 py-5 shadow-[var(--shadow-sm)] transition-[transform,box-shadow] duration-200 hover:-translate-y-1 hover:shadow-[var(--shadow-md)]"
          >
            <p className="ev-eyebrow">{label}</p>
            <p className="mt-2 font-mono text-[0.78rem] text-ink-2">{value}</p>
          </div>
        ))}
      </div>
    </RepositoryDetailSection>
  );
}
