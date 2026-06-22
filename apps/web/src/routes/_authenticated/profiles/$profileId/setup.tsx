import { createFileRoute } from "@tanstack/react-router";

import { ProfileDetailSection } from "@/components/app/profile-detail-section";
import { getProfileById } from "@/lib/navigation/sandbox-data";

export const Route = createFileRoute("/_authenticated/profiles/$profileId/setup")({
  loader: ({ params }: { params: { profileId: string } }) => getProfileById(params.profileId),
  component: ProfileSetupPage,
});

function ProfileSetupPage() {
  const profile = Route.useLoaderData() as ReturnType<typeof getProfileById>;

  return (
    <ProfileDetailSection
      profile={profile}
      section="Setup"
      description="Capture setup defaults once and apply them across issue delegation and run execution workflows."
    >
      <div className="grid gap-px border border-border bg-border sm:grid-cols-2">
        {[
          ["Startup script", "bootstrap.sh"],
          ["Validation profile", "strict"],
          ["Artifact retention", "7 days"],
          ["Issue handoff", "enabled"],
        ].map(([label, value]) => (
          <div key={label} className="bg-card px-4 py-4">
            <p className="text-sm text-label">{label}</p>
            <p className="mt-2 font-mono text-[0.78rem] text-foreground">{value}</p>
          </div>
        ))}
      </div>
    </ProfileDetailSection>
  );
}
