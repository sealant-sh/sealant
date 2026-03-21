import { Badge } from "@sealant/ui";
import { Link } from "@tanstack/react-router";

import type { RunRecord } from "@/lib/navigation/workspace-data";

interface RunRowsProps {
  readonly runs: readonly RunRecord[];
}

export function RunRows({ runs }: RunRowsProps) {
  return (
    <div className="border border-border">
      {runs.map((run) => (
        <Link
          key={run.id}
          to={`/runs/${encodeURIComponent(run.id)}` as never}
          className="grid gap-3 border-b border-border px-4 py-3 no-underline transition-colors duration-200 last:border-b-0 hover:bg-muted/40 lg:grid-cols-[1fr_1fr_auto_auto] lg:items-center"
        >
          <div>
            <p className="font-mono text-[0.62rem] tracking-[0.13em] uppercase text-muted-foreground">Run</p>
            <p className="mt-1 text-sm font-semibold text-foreground">{run.id}</p>
          </div>
          <div>
            <p className="font-mono text-[0.62rem] tracking-[0.13em] uppercase text-muted-foreground">Repository</p>
            <p className="mt-1 font-mono text-xs text-foreground">{run.repoId}</p>
          </div>
          <div>
            <p className="font-mono text-[0.62rem] tracking-[0.13em] uppercase text-muted-foreground">Profile</p>
            <p className="mt-1 font-mono text-xs text-foreground">{run.profileId}</p>
          </div>
          <div className="flex items-center justify-between gap-3 lg:justify-end">
            <Badge className={badgeClassName(run.status)}>{run.status}</Badge>
            <span className="font-mono text-[0.62rem] tracking-[0.13em] uppercase text-muted-foreground">{run.startedAt}</span>
          </div>
        </Link>
      ))}
    </div>
  );
}

function badgeClassName(status: RunRecord["status"]): string {
  if (status === "active") {
    return "rounded-none bg-primary text-primary-foreground font-mono text-[0.58rem] tracking-[0.11em] uppercase";
  }

  if (status === "failed") {
    return "rounded-none border border-border bg-muted text-foreground font-mono text-[0.58rem] tracking-[0.11em] uppercase";
  }

  return "rounded-none border border-border bg-card text-muted-foreground font-mono text-[0.58rem] tracking-[0.11em] uppercase";
}
