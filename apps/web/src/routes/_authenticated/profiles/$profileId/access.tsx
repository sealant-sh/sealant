import { createFileRoute } from "@tanstack/react-router";

import { ProfileDetailSection } from "@/components/app/profile-detail-section";
import { getProfileById } from "@/lib/navigation/workspace-data";

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
      <div className="divide-y divide-rule-faint rounded-2xl border border-border bg-popover px-5 shadow-[var(--shadow-sm)]">
        {[
          ["Access mode", profile?.access ?? "Unknown"],
          ["SSH key set", "ops-default"],
          ["Host allowlist", "10.20.0.0/16"],
          ["Session timeout", "45m"],
        ].map(([label, value]) => (
          <div key={label} className="flex items-baseline justify-between gap-4 py-3.5">
            <p className="font-mono text-[0.7rem] tracking-[0.02em] text-label">{label}</p>
            <p className="font-mono text-xs text-ink-2">{value}</p>
          </div>
        ))}
      </div>
    </ProfileDetailSection>
  );
}
