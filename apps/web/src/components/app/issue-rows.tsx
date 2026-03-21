import { Link } from "@tanstack/react-router";

import type { IssueRecord } from "@/lib/navigation/workspace-data";

interface IssueRowsProps {
  readonly issues: readonly IssueRecord[];
}

export function IssueRows({ issues }: IssueRowsProps) {
  return (
    <div className="border border-border">
      {issues.map((issue) => (
        <div
          key={issue.id}
          className="grid gap-3 border-b border-border px-4 py-3 last:border-b-0 lg:grid-cols-[auto_1fr_auto_auto] lg:items-center"
        >
          <p className="font-mono text-[0.62rem] tracking-[0.13em] text-muted-foreground">
            {issue.id}
          </p>
          <p className="text-sm text-foreground">{issue.title}</p>
          <p className="font-mono text-[0.62rem] tracking-[0.13em] text-muted-foreground">
            {issue.repoId}
          </p>
          <Link
            to={"/runs" as never}
            className="justify-self-start border border-border px-3 py-2 font-mono text-[0.62rem] tracking-[0.12em] text-muted-foreground no-underline transition-colors hover:border-foreground hover:text-foreground"
          >
            Open runs
          </Link>
        </div>
      ))}
    </div>
  );
}
