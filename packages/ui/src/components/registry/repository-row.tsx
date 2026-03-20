import * as React from "react"
import { Link } from "@tanstack/react-router"
import { ChevronRight, Tag } from "lucide-react"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"

export interface RepositoryRowProps {
  registryId: string
  repository: string
  /** Called when row is first expanded to fetch tags */
  onLoadTags: (repository: string) => Promise<string[]>
  className?: string
}

export function RepositoryRow({
  registryId,
  repository,
  onLoadTags,
  className,
}: RepositoryRowProps) {
  const [expanded, setExpanded] = React.useState(false)
  const [tags, setTags] = React.useState<string[] | null>(null)
  const [loading, setLoading] = React.useState(false)

  const handleToggle = React.useCallback(async () => {
    const next = !expanded
    setExpanded(next)
    if (next && tags === null) {
      setLoading(true)
      try {
        const result = await onLoadTags(repository)
        setTags(result)
      } finally {
        setLoading(false)
      }
    }
  }, [expanded, tags, repository, onLoadTags])

  const encodedRepo = encodeURIComponent(repository)

  return (
    <div className={cn("border-b border-border last:border-b-0", className)}>
      {/* Row header — clickable */}
      <button
        type="button"
        onClick={handleToggle}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:bg-muted/30"
        aria-expanded={expanded}
      >
        <ChevronRight
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform duration-150",
            expanded && "rotate-90"
          )}
        />
        <span className="flex-1 font-mono text-sm text-foreground truncate">
          {repository}
        </span>
        {tags !== null && (
          <Badge className="shrink-0 rounded-none bg-muted text-muted-foreground font-mono text-[10px] tracking-widest">
            <Tag className="size-2.5 mr-1" />
            {tags.length}
          </Badge>
        )}
      </button>

      {/* Expanded tag list */}
      {expanded && (
        <div className="px-8 pb-4 pt-1">
          {loading ? (
            <div className="flex flex-wrap gap-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-6 w-20 rounded-none" />
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
                  <span className="inline-flex items-center gap-1 border border-border bg-muted/20 px-2.5 py-1 font-mono text-xs text-muted-foreground transition-colors hover:bg-primary hover:text-primary-foreground hover:border-primary cursor-pointer">
                    {tag}
                  </span>
                </Link>
              ))}
            </div>
          ) : (
            <p className="font-mono text-xs text-muted-foreground/60 uppercase tracking-widest">
              NO TAGS FOUND
            </p>
          )}
        </div>
      )}
    </div>
  )
}
