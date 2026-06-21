import { createFileRoute } from "@tanstack/react-router";

import { RepositoryRows } from "@/components/app/repository-rows";
import { SandboxPage } from "@/components/app/sandbox-page";
import { REPOSITORIES } from "@/lib/navigation/sandbox-data";

export const Route = createFileRoute("/_authenticated/repositories/")({
  component: RepositoriesPage,
});

function RepositoriesPage() {
  return (
    <SandboxPage
      kicker="Repositories"
      title="Repository setup"
      description="Configure repositories, verify ownership, and inspect run readiness from one rule-driven surface."
      metrics={[
        { label: "Configured", value: String(REPOSITORIES.length) },
        {
          label: "Stable",
          value: String(REPOSITORIES.filter((repository) => repository.health === "Stable").length),
        },
        {
          label: "Watch",
          value: String(REPOSITORIES.filter((repository) => repository.health === "Watch").length),
        },
      ]}
    >
      <RepositoryRows repositories={REPOSITORIES} />
    </SandboxPage>
  );
}
