import type { ReactNode } from "react";

import { WorkspacePage } from "@/components/app/workspace-page";
import type { RepositoryRecord } from "@/lib/navigation/workspace-data";

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
      <WorkspacePage
        kicker="Repositories"
        title="Repository not found"
        description="The selected repository is not present in the current workspace catalog."
      />
    );
  }

  return (
    <WorkspacePage
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
    </WorkspacePage>
  );
}
