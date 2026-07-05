import type { ReactNode } from "react";

import { SandboxPage } from "@/components/app/sandbox-page";
import type { RepositoryRecord } from "@/lib/navigation/sandbox-data";

interface RepositoryDetailSectionProps {
  readonly repository: RepositoryRecord | null;
  readonly section: string;
  readonly description: string;
  readonly children: ReactNode;
}

export function RepositoryDetailSection({
  repository,
  section,
  description,
  children,
}: RepositoryDetailSectionProps) {
  if (repository === null) {
    return (
      <SandboxPage
        kicker="Repositories"
        title="Repository not found"
        description="The selected repository is not present in the current sandbox catalog."
      />
    );
  }

  const health = healthPresentation(repository.health);

  return (
    <SandboxPage
      kicker="Repository"
      title={`${repository.id} ${section}`}
      description={description}
    >
      <div className="space-y-8">
        <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-[var(--shadow-sm)]">
          <div className="flex items-center justify-between gap-3 border-b border-rule-faint px-6 py-4">
            <span className="font-mono text-xs text-ink-2">repo · {repository.id}</span>
            <span className="inline-flex items-center gap-2 text-xs font-medium">
              <span
                className={`size-1.5 shrink-0 rounded-full ${health.dotClassName}`}
                aria-hidden="true"
              />
              <span className={health.textClassName}>{repository.health}</span>
            </span>
          </div>
          <dl className="divide-y divide-rule-faint px-6">
            <EvidenceRow label="Name">{repository.name}</EvidenceRow>
            <EvidenceRow label="Owner">{repository.owner}</EvidenceRow>
            <EvidenceRow label="Branch">{repository.branch}</EvidenceRow>
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

function healthPresentation(health: string): {
  readonly dotClassName: string;
  readonly textClassName: string;
} {
  const normalized = health.toLowerCase();

  if (normalized === "stable") {
    return { dotClassName: "bg-success-dot", textClassName: "text-success" };
  }

  if (normalized === "watch") {
    return { dotClassName: "bg-warning-dot", textClassName: "text-warning" };
  }

  return {
    dotClassName: "border-[1.5px] border-input bg-transparent",
    textClassName: "text-ink-2",
  };
}
