import { createFileRoute } from "@tanstack/react-router";

import { ProfileRows } from "@/components/app/profile-rows";
import { SandboxPage } from "@/components/app/sandbox-page";
import { PROFILES } from "@/lib/navigation/sandbox-data";

export const Route = createFileRoute("/_authenticated/profiles/")({
  component: ProfilesPage,
});

function ProfilesPage() {
  return (
    <SandboxPage
      kicker="Profiles"
      title="Reusable environments"
      description="Profiles define repeatable runtime context so runs and issue delegation stay deterministic across teams."
      metrics={[
        { label: "Profiles", value: String(PROFILES.length) },
        {
          label: "Staging",
          value: String(PROFILES.filter((profile) => profile.environment === "Staging").length),
        },
        {
          label: "Secrets",
          value: String(PROFILES.reduce((total, profile) => total + profile.secretCount, 0)),
        },
      ]}
    >
      <ProfileRows profiles={PROFILES} />
    </SandboxPage>
  );
}
