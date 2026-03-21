import type { ReactNode } from "react";

import { WorkspacePage } from "@/components/app/workspace-page";
import type { ProfileRecord } from "@/lib/navigation/workspace-data";

interface ProfileDetailSectionProps {
  readonly profile: ProfileRecord | null;
  readonly section: string;
  readonly description: string;
  readonly children: ReactNode;
}

export function ProfileDetailSection({ profile, section, description, children }: ProfileDetailSectionProps) {
  if (profile === null) {
    return (
      <WorkspacePage
        kicker="Profiles"
        title="Profile not found"
        description="The selected profile is not present in the current workspace catalog."
      />
    );
  }

  return (
    <WorkspacePage
      kicker="Profile"
      title={`${profile.name} ${section}`}
      description={description}
      metrics={[
        { label: "Environment", value: profile.environment },
        { label: "Packages", value: String(profile.packageCount) },
        { label: "Secrets", value: String(profile.secretCount) },
      ]}
    >
      {children}
    </WorkspacePage>
  );
}
