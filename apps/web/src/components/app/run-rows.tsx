import { Link } from "@tanstack/react-router";

import type { RunRecord } from "@/lib/navigation/sandbox-data";

interface RunRowsProps {
  readonly runs: readonly RunRecord[];
}

export function RunRows({ runs }: RunRowsProps) {
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-[var(--shadow-sm)]">
      {runs.map((run) => (
        <Link
          key={run.id}
          to="/sandboxes/$sandboxId"
          params={{ sandboxId: run.id }}
          className="group grid grid-cols-1 gap-4 border-b border-rule-faint px-6 py-5 no-underline transition-[transform,box-shadow,background-color] duration-200 last:border-b-0 hover:-translate-y-0.5 hover:bg-accent/40 hover:shadow-[var(--shadow-md)] lg:grid-cols-[1.2fr_1fr_1fr_auto] lg:items-center"
        >
          <div className="flex items-center gap-2.5">
            {run.status === "active" ? <RecordingPulse /> : null}
            <span className="font-mono text-xs text-ink-2">{run.id}</span>
          </div>
          <div>
            <p className="ev-eyebrow">Repository</p>
            <p className="mt-1.5 font-mono text-xs text-ink-2">{run.repoId}</p>
          </div>
          <div>
            <p className="ev-eyebrow">Profile</p>
            <p className="mt-1.5 font-mono text-xs text-ink-2">{run.profileId}</p>
          </div>
          <div className="flex items-center justify-between gap-4 lg:flex-col lg:items-end lg:gap-2">
            <RunStatusIndicator status={run.status} />
            <span className="font-mono text-xs text-faint">{run.startedAt}</span>
          </div>
        </Link>
      ))}
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

function RunStatusIndicator({ status }: { readonly status: RunRecord["status"] }) {
  const { dotClassName, textClassName, label } = statusPresentation(status);

  return (
    <span className="inline-flex items-center gap-2 text-sm font-medium">
      <span className={`size-2 shrink-0 rounded-full ${dotClassName}`} aria-hidden="true" />
      <span className={textClassName}>{label}</span>
    </span>
  );
}

function statusPresentation(status: RunRecord["status"]): {
  readonly dotClassName: string;
  readonly textClassName: string;
  readonly label: string;
} {
  switch (status) {
    case "active":
      return { dotClassName: "bg-success-dot", textClassName: "text-success", label: "Running" };
    case "completed":
      return { dotClassName: "bg-success-dot", textClassName: "text-success", label: "Passed" };
    case "failed":
      return { dotClassName: "bg-danger-dot", textClassName: "text-danger", label: "Failed" };
  }
}
