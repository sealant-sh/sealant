import { Link } from "@tanstack/react-router";

import type { RepositoryRecord } from "@/lib/navigation/sandbox-data";

interface RepositoryRowsProps {
  readonly repositories: readonly RepositoryRecord[];
}

export function RepositoryRows({ repositories }: RepositoryRowsProps) {
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-[var(--shadow-sm)]">
      {repositories.map((repository) => (
        <Link
          key={repository.id}
          to="/repositories/$repoId"
          params={{ repoId: repository.id }}
          className="group grid gap-4 border-b border-rule-faint px-6 py-5 no-underline transition-[transform,box-shadow,background-color] duration-200 last:border-b-0 hover:-translate-y-0.5 hover:bg-accent/40 hover:shadow-[var(--shadow-md)] lg:grid-cols-[1fr_auto_auto_auto] lg:items-center"
        >
          <div className="min-w-0">
            <p className="ev-eyebrow">Repository</p>
            <p className="mt-1.5 truncate text-sm font-medium text-foreground transition-colors group-hover:text-primary">
              {repository.name}
            </p>
            <p className="mt-1 font-mono text-xs text-faint">{repository.id}</p>
          </div>
          <RepositoryFact label="Owner">{repository.owner}</RepositoryFact>
          <RepositoryFact label="Branch">{repository.branch}</RepositoryFact>
          <RepositoryFact label="Health">{repository.health}</RepositoryFact>
        </Link>
      ))}
    </div>
  );
}

function RepositoryFact({
  label,
  children,
}: {
  readonly label: string;
  readonly children: string;
}) {
  return (
    <div className="lg:text-right">
      <p className="ev-eyebrow">{label}</p>
      <p className="mt-1.5 font-mono text-xs text-ink-2">{children}</p>
    </div>
  );
}
