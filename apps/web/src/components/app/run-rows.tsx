import { Link } from "@tanstack/react-router";

import type { RunRecord } from "@/lib/navigation/sandbox-data";

interface RunRowsProps {
  readonly runs: readonly RunRecord[];
}

export function RunRows({ runs }: RunRowsProps) {
  return (
    <div className="border border-border rounded-md">
      {runs.map((run) => (
        <Link
          key={run.id}
          to="/sandboxes/$sandboxId"
          params={{ sandboxId: run.id }}
          className="grid grid-cols-3 gap-3 border-b border-rule-faint px-4 py-3 no-underline transition-colors duration-200 last:border-b-0 hover:bg-muted/40 lg:grid-cols-[1fr_1fr_auto_auto] lg:items-center"
        >
          <div>
            <p className="font-mono text-xs text-ink-2">{run.id}</p>
          </div>
          <div>
            <p className="ev-eyebrow">Repository</p>
            <p className="mt-1 font-mono text-xs text-ink-2">{run.repoId}</p>
          </div>
          <div>
            <p className="ev-eyebrow">Profile</p>
            <p className="mt-1 font-mono text-xs text-ink-2">{run.profileId}</p>
          </div>
          <div className="flex items-center justify-between gap-3 lg:justify-end">
            <RunStatusIndicator status={run.status} />
            <span className="font-mono text-xs text-faint">{run.startedAt}</span>
          </div>
        </Link>
      ))}
    </div>
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
