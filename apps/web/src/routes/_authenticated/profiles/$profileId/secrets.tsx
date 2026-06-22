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
        {(
          [
            ["AWS_ACCESS_KEY_ID", "Mapped"],
            ["AWS_SECRET_ACCESS_KEY", "Mapped"],
            ["REGISTRY_TOKEN", "Mapped"],
            ["SLACK_WEBHOOK", "Missing"],
          ] as const
        ).map(([key, value]) => (
          <div
            key={key}
            className="flex items-center justify-between gap-4 border-b border-[var(--sw-faint-rule)] px-4 py-3 last:border-b-0"
          >
            <p className="font-mono text-xs text-foreground">{key}</p>
            <SecretBindingStatus value={value} />
          </div>
        ))}
      </div>
    </ProfileDetailSection>
  );
}

function SecretBindingStatus(props: { readonly value: string }) {
  const isMapped = props.value === "Mapped";

  return (
    <span
      className={`flex items-center gap-1.5 text-xs ${isMapped ? "text-success" : "text-warning"}`}
    >
      <span
        className={`size-1.5 rounded-full ${isMapped ? "bg-success-dot" : "bg-warning-dot"}`}
      />
      {props.value}
    </span>
  );
}
