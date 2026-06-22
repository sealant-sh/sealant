import type { ReactNode } from "react";

import { SandboxPage } from "@/components/app/sandbox-page";
import type { ProfileRecord } from "@/lib/navigation/sandbox-data";

interface ProfileDetailSectionProps {
  readonly profile: ProfileRecord | null;
  readonly section: string;
  readonly description: string;
  readonly children: ReactNode;
}

export function ProfileDetailSection({
  profile,
  section,
  description,
  children,
}: ProfileDetailSectionProps) {
  if (profile === null) {
    return (
      <SandboxPage
        kicker="Profiles"
        title="Profile not found"
        description="The selected profile is not present in the current sandbox catalog."
      />
    );
  }

  return (
    <SandboxPage kicker="Profile" title={`${profile.name} ${section}`} description={description}>
      <div className="space-y-8">
        <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-[var(--shadow-sm)]">
          <div className="flex items-center justify-between gap-3 border-b border-rule-faint px-6 py-4">
            <span className="font-mono text-xs text-ink-2">profile · {profile.id}</span>
            <span className="inline-flex items-center gap-2 text-xs font-medium text-ink-2">
              <span
                className="size-1.5 shrink-0 rounded-full border-[1.5px] border-input bg-transparent"
                aria-hidden="true"
              />
              {profile.environment}
            </span>
          </div>
          <dl className="divide-y divide-rule-faint px-6">
            <EvidenceRow label="Environment">{profile.environment}</EvidenceRow>
            <EvidenceRow label="Packages">{`${profile.packageCount}`}</EvidenceRow>
            <EvidenceRow label="Secrets">{`${profile.secretCount}`}</EvidenceRow>
            <EvidenceRow label="Access">{profile.access}</EvidenceRow>
          </dl>
        </div>
        {children}
      </div>
    </SandboxPage>
  );
}

function EvidenceRow({ label, children }: { readonly label: string; readonly children: string }) {
  return (
    <div className="grid grid-cols-[8rem_1fr] gap-3 py-3.5">
      <dt className="ev-eyebrow self-center">{label}</dt>
      <dd className="font-mono text-xs leading-relaxed text-ink-2">{children}</dd>
    </div>
  );
}
