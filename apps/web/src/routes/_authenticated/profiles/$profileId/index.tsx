import { createFileRoute } from "@tanstack/react-router";

import { ProfileDetailSection } from "@/components/app/profile-detail-section";
import { getProfileById } from "@/lib/navigation/workspace-data";

export const Route = createFileRoute("/_authenticated/profiles/$profileId/" as never)({
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
      <div className="border border-border">
        {[
          ["Environment", profile?.environment ?? "Unknown"],
          ["Access mode", profile?.access ?? "Unknown"],
          ["Packages", String(profile?.packageCount ?? 0)],
          ["Secrets", String(profile?.secretCount ?? 0)],
        ].map(([label, value]) => (
          <div key={label} className="flex items-center justify-between gap-4 border-b border-border px-4 py-3 last:border-b-0">
            <p className="font-mono text-[0.62rem] uppercase tracking-[0.13em] text-muted-foreground">{label}</p>
            <p className="text-sm font-semibold text-foreground">{value}</p>
          </div>
        ))}
      </div>
    </ProfileDetailSection>
  );
}
