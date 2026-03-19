import { createFileRoute } from '@tanstack/react-router'
import { Link } from '@tanstack/react-router'
import { ArrowLeft } from 'lucide-react'
import { ManifestDetail, Skeleton } from '@sealant/ui'
import { getRegistry, getManifest } from '@/lib/api/registry-service'

export const Route = createFileRoute('/registry/$registryId/$repo/$tag')({
  loader: async ({ params }) => {
    const repo = decodeURIComponent(params.repo)
    const [registry, manifest] = await Promise.all([
      getRegistry(params.registryId),
      getManifest(params.registryId, repo, params.tag),
    ])
    return { registry, manifest, repo }
  },
  pendingComponent: ManifestSkeleton,
  component: ManifestPage,
})

function ManifestPage() {
  const { registry, manifest, repo } = Route.useLoaderData()
  const { registryId } = Route.useParams()

  return (
    <div className="mx-auto w-full max-w-4xl px-6 py-8">
      {/* Breadcrumb */}
      <nav className="mb-6 flex flex-wrap items-center gap-2 font-mono text-xs tracking-widest uppercase text-muted-foreground">
        <Link
          to="/registry"
          className="text-muted-foreground no-underline hover:text-foreground transition-colors"
        >
          REGISTRY
        </Link>
        <span className="text-muted-foreground/40">/</span>
        <Link
          to="/registry/$registryId"
          params={{ registryId }}
          className="text-muted-foreground no-underline hover:text-foreground transition-colors flex items-center gap-1"
        >
          {registry.name.toUpperCase()}
        </Link>
        <span className="text-muted-foreground/40">/</span>
        <Link
          to="/registry/$registryId"
          params={{ registryId }}
          className="text-muted-foreground no-underline hover:text-foreground transition-colors"
        >
          {repo}
        </Link>
        <span className="text-muted-foreground/40">/</span>
        <span className="text-foreground">{manifest.reference}</span>
      </nav>

      <Link
        to="/registry/$registryId"
        params={{ registryId }}
        className="mb-6 inline-flex items-center gap-1.5 font-mono text-xs tracking-widest uppercase text-muted-foreground no-underline hover:text-foreground transition-colors"
      >
        <ArrowLeft className="size-3" />
        BACK TO REGISTRY
      </Link>

      <ManifestDetail
        repository={manifest.repository}
        reference={manifest.reference}
        digest={manifest.digest}
        contentType={manifest.contentType}
        manifest={manifest.manifest}
        className="mt-6"
      />
    </div>
  )
}

function ManifestSkeleton() {
  return (
    <div className="mx-auto w-full max-w-4xl px-6 py-8">
      <Skeleton className="mb-6 h-3 w-64 rounded-none" />
      <Skeleton className="mb-6 h-3 w-32 rounded-none" />
      <div className="border border-border bg-card p-6 mb-6">
        <Skeleton className="h-2 w-16 rounded-none mb-2" />
        <Skeleton className="h-8 w-3/4 rounded-none mb-3" />
        <Skeleton className="h-3 w-48 rounded-none" />
      </div>
      <div className="grid grid-cols-3 gap-px border border-border bg-border mb-6">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="bg-card p-4">
            <Skeleton className="h-2 w-20 rounded-none mb-2" />
            <Skeleton className="h-4 w-24 rounded-none" />
          </div>
        ))}
      </div>
      <Skeleton className="h-3 w-16 rounded-none mb-3" />
      <div className="border border-border">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 border-b border-border px-4 py-2.5 last:border-b-0">
            <Skeleton className="h-3 flex-1 rounded-none" />
            <Skeleton className="h-3 w-16 rounded-none" />
            <Skeleton className="h-5 w-24 rounded-none" />
          </div>
        ))}
      </div>
    </div>
  )
}
