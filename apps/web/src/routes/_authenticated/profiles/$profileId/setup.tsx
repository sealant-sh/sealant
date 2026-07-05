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
      description="Capture setup defaults once and apply them across run execution workflows."
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {[
          ["Startup script", "bootstrap.sh"],
          ["Validation profile", "strict"],
          ["Artifact retention", "7 days"],
        ].map(([label, value]) => (
          <div
            key={label}
            className="rounded-2xl border border-border bg-popover px-5 py-5 shadow-[var(--shadow-sm)] transition-[transform,box-shadow] duration-200 hover:-translate-y-1 hover:shadow-[var(--shadow-md)]"
          >
            <p className="ev-eyebrow">{label}</p>
            <p className="mt-2 font-mono text-xs text-foreground">{value}</p>
          </div>
        ))}
      </div>
    </ProfileDetailSection>
  );
}
