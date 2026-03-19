import { createFileRoute } from '@tanstack/react-router'
import { RegistryCard } from '@sealant/ui'
import { Skeleton } from '@sealant/ui'
import { listRegistries } from '@/lib/api/registry-service'

export const Route = createFileRoute('/registry/')({
  loader: () => listRegistries(),
  pendingComponent: RegistryListSkeleton,
  component: RegistryListPage,
})

function RegistryListPage() {
  const registries = Route.useLoaderData()

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-8">
      {/* Page heading */}
      <div className="mb-8">
        <p className="font-mono text-xs tracking-widest uppercase text-secondary mb-2">
          INSTANCES
        </p>
        <h1 className="font-black text-5xl tracking-tight uppercase text-foreground leading-none">
          REGISTRY
        </h1>
        <p className="mt-3 font-mono text-xs tracking-widest uppercase text-muted-foreground">
          {registries.length} CONFIGURED INSTANCE{registries.length !== 1 ? 'S' : ''}
        </p>
      </div>

      {/* Registry grid */}
      {registries.length === 0 ? (
        <div className="flex items-center justify-center border border-border py-24">
          <p className="font-mono text-xs tracking-widest uppercase text-muted-foreground/60">
            NO REGISTRIES CONFIGURED
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {registries.map((registry) => (
            <RegistryCard
              key={registry.id}
              id={registry.id}
              name={registry.name}
              baseUrl={registry.baseUrl}
              pushRegistry={registry.pushRegistry}
              hasBasicAuth={registry.hasBasicAuth}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function RegistryListSkeleton() {
  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-8">
      <div className="mb-8">
        <Skeleton className="h-3 w-24 rounded-none mb-2" />
        <Skeleton className="h-12 w-48 rounded-none" />
        <Skeleton className="h-3 w-36 rounded-none mt-3" />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="border border-border bg-card">
            <div className="border-b border-border p-4 flex justify-between">
              <div className="flex flex-col gap-2">
                <Skeleton className="h-2 w-16 rounded-none" />
                <Skeleton className="h-5 w-32 rounded-none" />
              </div>
              <Skeleton className="h-5 w-14 rounded-none" />
            </div>
            <div className="p-4 flex flex-col gap-3">
              <Skeleton className="h-3 w-full rounded-none" />
              <Skeleton className="h-3 w-3/4 rounded-none" />
            </div>
            <div className="border-t border-border p-4">
              <Skeleton className="h-7 w-full rounded-none" />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
