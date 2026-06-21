import { createFileRoute } from "@tanstack/react-router";

import { ProfileDetailSection } from "@/components/app/profile-detail-section";
import { getProfileById } from "@/lib/navigation/sandbox-data";

export const Route = createFileRoute("/_authenticated/profiles/$profileId/secrets")({
  loader: ({ params }: { params: { profileId: string } }) => getProfileById(params.profileId),
  component: ProfileSecretsPage,
});

function ProfileSecretsPage() {
  const profile = Route.useLoaderData() as ReturnType<typeof getProfileById>;

  return (
    <ProfileDetailSection
      profile={profile}
      section="Secrets"
      description="Keep secret bindings minimal and auditable so profile behavior is secure and reproducible."
    >
      <div className="border border-border">
        {[
          ["AWS_ACCESS_KEY_ID", "Mapped"],
          ["AWS_SECRET_ACCESS_KEY", "Mapped"],
          ["REGISTRY_TOKEN", "Mapped"],
          ["SLACK_WEBHOOK", "Missing"],
        ].map(([key, value]) => (
          <div
            key={key}
            className="flex items-center justify-between gap-4 border-b border-border px-4 py-3 last:border-b-0"
          >
            <p className="font-mono text-xs text-foreground">{key}</p>
            <p className="font-mono text-[0.62rem] tracking-[0.13em] text-muted-foreground">
              {value}
            </p>
          </div>
        ))}
      </div>
    </ProfileDetailSection>
  );
}
