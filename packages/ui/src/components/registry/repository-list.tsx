import { cn } from "@sealant/ui/lib/utils";
import * as React from "react";

import { RepositoryRow } from "./repository-row";

export interface RepositoryListProps {
  registryId: string;
  repositories: string[];
  onLoadTags: (repository: string) => Promise<string[]>;
  className?: string;
}

export function RepositoryList({
  registryId,
  repositories,
  onLoadTags,
  className,
}: RepositoryListProps) {
  if (repositories.length === 0) {
    return (
      <div
        className={cn(
          "flex items-center justify-center rounded-md border border-border py-16",
          className,
        )}
      >
        <p className="font-mono text-xs text-muted-foreground">No repositories found</p>
      </div>
    );
  }

  return (
    <div className={cn("rounded-md border border-border bg-card", className)}>
      {repositories.map((repo) => (
        <RepositoryRow
          key={repo}
          registryId={registryId}
          repository={repo}
          onLoadTags={onLoadTags}
        />
      ))}
    </div>
  );
}
