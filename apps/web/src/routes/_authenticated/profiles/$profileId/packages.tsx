import { createFileRoute } from "@tanstack/react-router";

import { ProfileDetailSection } from "@/components/app/profile-detail-section";
import { getProfileById } from "@/lib/navigation/sandbox-data";

export const Route = createFileRoute("/_authenticated/profiles/$profileId/packages")({
  loader: ({ params }: { params: { profileId: string } }) => getProfileById(params.profileId),
  component: ProfilePackagesPage,
});

function ProfilePackagesPage() {
  const profile = Route.useLoaderData() as ReturnType<typeof getProfileById>;

  return (
    <ProfileDetailSection
      profile={profile}
      section="Packages"
      description="Package constraints belong to the profile so repository runs can stay lightweight and consistent."
    >
      <div className="divide-y divide-rule-faint rounded-2xl border border-border bg-popover px-5 shadow-[var(--shadow-sm)]">
        {[
          ["node", "22.4.1"],
          ["pnpm", "10.32.1"],
          ["typescript", "5.9.3"],
          ["oxlint", "1.55.0"],
        ].map(([name, version]) => (
          <div
            key={name}
            className="grid gap-2 py-3.5 sm:grid-cols-[1fr_auto] sm:items-baseline"
          >
            <p className="font-mono text-xs text-foreground">{name}</p>
            <p className="font-mono text-xs text-ink-2">{version}</p>
          </div>
        ))}
      </div>
    </ProfileDetailSection>
  );
}
