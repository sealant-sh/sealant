import { createFileRoute } from "@tanstack/react-router";

import { ProfileDetailSection } from "@/components/app/profile-detail-section";
import { getProfileById } from "@/lib/navigation/sandbox-data";

export const Route = createFileRoute("/_authenticated/profiles/$profileId/")({
  loader: ({ params }: { params: { profileId: string } }) => getProfileById(params.profileId),
  component: ProfileOverviewPage,
});

function ProfileOverviewPage() {
  const profile = Route.useLoaderData() as ReturnType<typeof getProfileById>;

  return (
    <ProfileDetailSection
      profile={profile}
      section="Overview"
      description="Inspect baseline environment scope before changing packages, secrets, or access controls."
    >
      <div className="divide-y divide-rule-faint rounded-2xl border border-border bg-popover px-5 shadow-[var(--shadow-sm)]">
        {[
          ["Environment", profile?.environment ?? "Unknown"],
          ["Access mode", profile?.access ?? "Unknown"],
          ["Packages", String(profile?.packageCount ?? 0)],
          ["Secrets", String(profile?.secretCount ?? 0)],
        ].map(([label, value]) => (
          <div key={label} className="flex items-baseline justify-between gap-4 py-3.5">
            <p className="font-mono text-[0.7rem] tracking-[0.02em] text-label">{label}</p>
            <p className="text-sm font-medium text-foreground">{value}</p>
          </div>
        ))}
      </div>
    </ProfileDetailSection>
  );
}
