import type { ReactNode } from "react";

import { SandboxPage } from "@/components/app/sandbox-page";

type SandboxStatus = "queued" | "running" | "ready" | "failed" | "cancelled";

interface SandboxDetail {
  readonly sandboxId: string;
  readonly name: string;
  readonly status: SandboxStatus;
  readonly repository?: string | undefined;
  readonly tag?: string | undefined;
}

interface SandboxDetailSectionProps {
  readonly sandbox: SandboxDetail | null;
  readonly section: string;
  readonly description: string;
  readonly children: ReactNode;
}

export function SandboxDetailSection({
  sandbox,
  section,
  description,
  children,
}: SandboxDetailSectionProps) {
  if (sandbox === null) {
    return (
      <SandboxPage
        kicker="Sandboxes"
        title="Sandbox not found"
        description="The selected sandbox does not exist in the current sandbox view."
      />
    );
  }

  return (
    <SandboxPage
      kicker="Sandbox detail"
      title={`${sandbox.name} ${section}`}
      description={description}
    >
      <div className="space-y-8">
        <RunRecordPanel
          recordId={sandbox.sandboxId}
          status={sandbox.status}
          rows={[
            { label: "Sandbox", value: sandbox.sandboxId },
            { label: "Repository", value: sandbox.repository ?? "Unknown" },
            { label: "Tag", value: sandbox.tag ?? "n/a" },
          ]}
        />
        {children}
      </div>
    </SandboxPage>
  );
}

function RunRecordPanel({
  recordId,
  status,
  rows,
}: {
  readonly recordId: string;
  readonly status: SandboxStatus;
  readonly rows: readonly { readonly label: string; readonly value: string }[];
}) {
  const { dotClassName, textClassName, label } = statusPresentation(status);

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-[var(--shadow-sm)]">
      <div className="flex items-center justify-between gap-3 border-b border-rule-faint px-6 py-4">
        <span className="inline-flex items-center gap-2.5">
          {status === "running" ? <RecordingPulse /> : null}
          <span className="font-mono text-xs text-ink-2">sandbox · {recordId}</span>
        </span>
        <span className="inline-flex items-center gap-2 text-xs font-medium">
          <span className={`size-1.5 shrink-0 rounded-full ${dotClassName}`} aria-hidden="true" />
          <span className={textClassName}>{label}</span>
        </span>
      </div>
      <dl className="divide-y divide-rule-faint px-6">
        {rows.map((row) => (
          <div key={row.label} className="grid grid-cols-[8rem_1fr] gap-3 py-3.5">
            <dt className="ev-eyebrow self-center">{row.label}</dt>
            <dd className="font-mono text-xs leading-relaxed text-ink-2">{row.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function RecordingPulse() {
  return (
    <span
      className="relative inline-flex size-2.5 shrink-0 items-center justify-center"
      aria-hidden="true"
    >
      <span className="absolute inline-flex size-2.5 rounded-full bg-primary/40 motion-safe:animate-ping" />
      <span className="relative size-2 rounded-full bg-primary" />
    </span>
  );
}

function statusPresentation(status: SandboxStatus): {
  readonly dotClassName: string;
  readonly textClassName: string;
  readonly label: string;
} {
  switch (status) {
    case "running":
      return { dotClassName: "bg-success-dot", textClassName: "text-success", label: "Running" };
    case "ready":
      return { dotClassName: "bg-success-dot", textClassName: "text-success", label: "Ready" };
    case "queued":
      return { dotClassName: "bg-warning-dot", textClassName: "text-warning", label: "Queued" };
    case "failed":
      return { dotClassName: "bg-danger-dot", textClassName: "text-danger", label: "Failed" };
    case "cancelled":
      return {
        dotClassName: "border-[1.5px] border-input bg-transparent",
        textClassName: "text-ink-2",
        label: "Cancelled",
      };
  }
}
