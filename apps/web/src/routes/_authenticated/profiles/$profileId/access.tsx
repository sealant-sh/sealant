import { createFileRoute } from "@tanstack/react-router";

import { ProfileDetailSection } from "@/components/app/profile-detail-section";
import { getProfileById } from "@/lib/navigation/sandbox-data";

export const Route = createFileRoute("/_authenticated/profiles/$profileId/access")({
  loader: ({ params }: { params: { profileId: string } }) => getProfileById(params.profileId),
  component: ProfileAccessPage,
});

function ProfileAccessPage() {
  const profile = Route.useLoaderData() as ReturnType<typeof getProfileById>;

  return (
    <ProfileDetailSection
      profile={profile}
      section="SSH / Access"
      description="Define SSH and access posture once so every run launched with this profile inherits the same control boundaries."
    >
      <div className="border border-border">
        {[
          ["Access mode", profile?.access ?? "Unknown"],
          ["SSH key set", "ops-default"],
          ["Host allowlist", "10.20.0.0/16"],
          ["Session timeout", "45m"],
        ].map(([label, value]) => (
          <div
            key={label}
            className="flex items-center justify-between gap-4 border-b border-[var(--sw-faint-rule)] px-4 py-3 last:border-b-0"
          >
            <p className="text-sm text-label">{label}</p>
            <p className="font-mono text-[0.78rem] text-foreground">{value}</p>
          </div>
        ))}
      </div>
    </ProfileDetailSection>
  );
}
