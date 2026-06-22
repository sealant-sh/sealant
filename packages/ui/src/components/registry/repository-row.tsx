import { Skeleton } from "@sealant/ui/components/ui/skeleton";
import { cn } from "@sealant/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import { ChevronRight, Tag } from "lucide-react";
import * as React from "react";

export interface RepositoryRowProps {
  registryId: string;
  repository: string;
  /** Called when row is first expanded to fetch tags */
  onLoadTags: (repository: string) => Promise<string[]>;
  className?: string;
}

export function RepositoryRow({
  registryId,
  repository,
  onLoadTags,
  className,
}: RepositoryRowProps) {
  const [expanded, setExpanded] = React.useState(false);
  const [tags, setTags] = React.useState<string[] | null>(null);
  const [loading, setLoading] = React.useState(false);

  const handleToggle = React.useCallback(async () => {
    const next = !expanded;
    setExpanded(next);
    if (next && tags === null) {
      setLoading(true);
      try {
        const result = await onLoadTags(repository);
        setTags(result);
      } finally {
        setLoading(false);
      }
    }
  }, [expanded, tags, repository, onLoadTags]);

  const encodedRepo = encodeURIComponent(repository);

  return (
    <div className={cn("border-b border-border last:border-b-0", className)}>
      {/* Row header — clickable */}
      <button
        type="button"
        onClick={handleToggle}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors duration-200 hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none"
        aria-expanded={expanded}
      >
        <ChevronRight
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform duration-150",
            expanded && "rotate-90",
          )}
        />
        <span className="flex-1 truncate font-mono text-sm text-foreground">{repository}</span>
        {tags !== null && (
          <span className="flex shrink-0 items-center gap-1 font-mono text-xs text-faint">
            <Tag className="size-3" />
            {tags.length}
          </span>
        )}
      </button>

      {/* Expanded tag list */}
      {expanded && (
        <div className="px-8 pb-4 pt-1">
          {loading ? (
            <div className="flex flex-wrap gap-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-6 w-20 rounded-md" />
              ))}
            </div>
          ) : tags && tags.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {tags.map((tag) => (
                <Link
                  key={tag}
                  to="/registry/$registryId/$repo/$tag"
                  params={{ registryId, repo: encodedRepo, tag }}
                  className="no-underline"
                >
                  <span className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-border px-2.5 py-1 font-mono text-xs text-faint transition-colors duration-200 hover:border-primary hover:text-primary">
                    {tag}
                  </span>
                </Link>
              ))}
            </div>
          ) : (
            <p className="font-mono text-xs text-muted-foreground">No tags found</p>
          )}
        </div>
      )}
    </div>
  );
}
