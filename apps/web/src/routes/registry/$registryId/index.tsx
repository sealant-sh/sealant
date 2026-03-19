import { createFileRoute } from '@tanstack/react-router'
import { Link } from '@tanstack/react-router'
import { ArrowLeft } from 'lucide-react'
import { Badge, RepositoryList, Separator, Skeleton } from '@sealant/ui'
import { getRegistry, listRepositories, getRepositoryTags } from '@/lib/api/registry-service'

export const Route = createFileRoute('/registry/$registryId/')({
  loader: async ({ params }) => {
    const [registry, repositories] = await Promise.all([
      getRegistry(params.registryId),
      listRepositories(params.registryId),
    ])
    return { registry, repositories }
  },
  pendingComponent: RegistryDetailSkeleton,
  component: RegistryDetailPage,
})

function RegistryDetailPage() {
  const { registry, repositories } = Route.useLoaderData()

  async function loadTags(repo: string) {
    const result = await getRepositoryTags(registry.id, repo)
    return result.tags
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-8">
      {/* Breadcrumb */}
      <nav className="mb-6 flex items-center gap-2 font-mono text-xs tracking-widest uppercase text-muted-foreground">
        <Link
          to="/registry"
          className="text-muted-foreground no-underline hover:text-foreground transition-colors flex items-center gap-1"
        >
          <ArrowLeft className="size-3" />
          REGISTRY
        </Link>
        <span className="text-muted-foreground/40">/</span>
        <span className="text-foreground">{registry.name.toUpperCase()}</span>
      </nav>

      {/* Registry metadata */}
      <div className="mb-8">
        <h1 className="font-black text-4xl tracking-tight uppercase text-foreground leading-none">
          {registry.name.toUpperCase()}
        </h1>
        <div className="mt-4 flex flex-wrap items-center gap-4">
          <span className="font-mono text-sm text-secondary">{registry.baseUrl}</span>
          <Badge
            className={
              registry.hasBasicAuth
                ? 'rounded-none bg-primary text-primary-foreground font-mono text-[10px] tracking-widest uppercase'
                : 'rounded-none bg-muted text-muted-foreground font-mono text-[10px] tracking-widest uppercase'
            }
          >
            {registry.hasBasicAuth ? 'BASIC AUTH' : 'NO AUTH'}
          </Badge>
        </div>
        <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-2">
          <MetaField label="BASE URL" value={registry.baseUrl} />
          <MetaField label="PUSH REGISTRY" value={registry.pushRegistry} />
        </div>
      </div>

      <Separator className="mb-8 bg-border" />

      {/* Repositories */}
      <div>
        <div className="mb-4 flex items-baseline gap-3">
          <h2 className="font-black text-sm tracking-widest uppercase text-foreground">
            REPOSITORIES
          </h2>
          <span className="font-mono text-xs text-muted-foreground">
            ({repositories.length})
          </span>
        </div>
        <RepositoryList
          registryId={registry.id}
          repositories={repositories}
          onLoadTags={loadTags}
        />
      </div>
    </div>
  )
}

interface MetaFieldProps {
  label: string
  value: string
}

function MetaField({ label, value }: MetaFieldProps) {
  return (
    <div>
      <p className="font-mono text-[10px] tracking-widest uppercase text-muted-foreground/60">
        {label}
      </p>
      <p className="mt-0.5 font-mono text-xs text-secondary truncate" title={value}>
        {value}
      </p>
    </div>
  )
}

function RegistryDetailSkeleton() {
  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-8">
      <Skeleton className="mb-6 h-3 w-32 rounded-none" />
      <Skeleton className="h-10 w-56 rounded-none mb-4" />
      <div className="flex gap-4 mb-3">
        <Skeleton className="h-3 w-48 rounded-none" />
        <Skeleton className="h-5 w-20 rounded-none" />
      </div>
      <div className="grid grid-cols-2 gap-4 mb-8">
        <Skeleton className="h-8 rounded-none" />
        <Skeleton className="h-8 rounded-none" />
      </div>
      <Skeleton className="h-px w-full rounded-none mb-8" />
      <Skeleton className="h-3 w-28 rounded-none mb-4" />
      <div className="border border-border">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 border-b border-border px-4 py-3 last:border-b-0">
            <Skeleton className="h-3 w-3 rounded-none" />
            <Skeleton className="h-3 flex-1 rounded-none" />
            <Skeleton className="h-5 w-10 rounded-none" />
          </div>
        ))}
      </div>
    </div>
  )
}
