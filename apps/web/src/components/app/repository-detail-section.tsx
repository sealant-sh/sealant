import type { ReactNode } from "react";

import { SandboxPage } from "@/components/app/sandbox-page";
import type { RepositoryRecord } from "@/lib/navigation/sandbox-data";

interface RepositoryDetailSectionProps {
  readonly repository: RepositoryRecord | null;
  readonly section: string;
  readonly description: string;
  readonly children: ReactNode;
}

export function RepositoryDetailSection({
  repository,
  section,
  description,
  children,
}: RepositoryDetailSectionProps) {
  if (repository === null) {
    return (
      <SandboxPage
        kicker="Repositories"
        title="Repository not found"
        description="The selected repository is not present in the current sandbox catalog."
      />
    );
  }

  return (
    <SandboxPage
      kicker="Repository"
      title={`${repository.id} ${section}`}
      description={description}
      metrics={[
        { label: "Owner", value: repository.owner },
        { label: "Branch", value: repository.branch },
        { label: "Health", value: repository.health },
      ]}
    >
      {children}
    </SandboxPage>
  );
}
