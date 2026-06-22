import { Link } from "@tanstack/react-router";

import type { RepositoryRecord } from "@/lib/navigation/sandbox-data";

interface RepositoryRowsProps {
  readonly repositories: readonly RepositoryRecord[];
}

export function RepositoryRows({ repositories }: RepositoryRowsProps) {
  return (
    <div className="border border-border rounded-md">
      {repositories.map((repository) => (
        <Link
          key={repository.id}
          to={`/repositories/${encodeURIComponent(repository.id)}` as never}
          className="grid gap-3 border-b border-rule-faint px-4 py-3 no-underline transition-colors duration-200 last:border-b-0 hover:bg-muted/40 lg:grid-cols-[1fr_auto_auto_auto] lg:items-center"
        >
          <div>
            <p className="ev-eyebrow">Repository</p>
            <p className="mt-1 text-sm font-medium text-foreground">{repository.name}</p>
          </div>
          <p className="font-mono text-xs text-faint">{repository.owner}</p>
          <p className="font-mono text-xs text-faint">{repository.branch}</p>
          <p className="font-mono text-xs text-faint">{repository.health}</p>
        </Link>
      ))}
    </div>
  );
}
