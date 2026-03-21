import type { ReactNode } from "react";

import { WorkspacePage } from "@/components/app/workspace-page";
import type { RunRecord } from "@/lib/navigation/workspace-data";

interface RunDetailSectionProps {
  readonly run: RunRecord | null;
  readonly section: string;
  readonly description: string;
  readonly children: ReactNode;
}

export function RunDetailSection({ run, section, description, children }: RunDetailSectionProps) {
  if (run === null) {
    return (
      <WorkspacePage
        kicker="Runs"
        title="Run not found"
        description="The selected run does not exist in the current workspace catalog."
      />
    );
  }

  return (
    <WorkspacePage
      kicker="Run Detail"
      title={`${run.id} ${section}`}
      description={description}
      metrics={[
        { label: "Repository", value: run.repoId },
        { label: "Profile", value: run.profileId },
        { label: "Status", value: run.status },
      ]}
    >
      {children}
    </WorkspacePage>
  );
}
