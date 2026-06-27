import { createFileRoute } from "@tanstack/react-router";

import { ProfileDetailSection } from "@/components/app/profile-detail-section";
import { getProfileById } from "@/lib/navigation/sandbox-data";

export const Route = createFileRoute("/_authenticated/profiles/$profileId/env-variables")({
  loader: ({ params }: { params: { profileId: string } }) => getProfileById(params.profileId),
  component: ProfileEnvVariablesPage,
});

function ProfileEnvVariablesPage() {
  const profile = Route.useLoaderData() as ReturnType<typeof getProfileById>;

  return (
    <ProfileDetailSection
      profile={profile}
      section="Env Variables"
      description="Use explicit environment variables so run behavior remains predictable under operational pressure."
    >
      <div className="divide-y divide-rule-faint rounded-2xl border border-border bg-popover px-5 shadow-[var(--shadow-sm)]">
        {[
          ["NODE_ENV", "production"],
          ["SEALANT_REGION", "eu-west-1"],
          ["VALIDATION_LEVEL", "strict"],
        ].map(([key, value]) => (
          <div
            key={key}
            className="grid gap-2 py-3.5 sm:grid-cols-[1fr_2fr] sm:items-baseline"
          >
            <p className="font-mono text-xs text-foreground">{key}</p>
            <p className="font-mono text-xs text-ink-2">{value}</p>
          </div>
        ))}
      </div>
    </ProfileDetailSection>
  );
}
