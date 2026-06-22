import { RegistryCard, Skeleton } from "@sealant/ui";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/registry/")({
  loader: ({ context }) => {
    return context.queryClient.ensureQueryData(context.trpc.registry.list.queryOptions(undefined));
  },
  pendingComponent: RegistryListSkeleton,
  component: RegistryListPage,
});

function RegistryListPage() {
  const registries = Route.useLoaderData();

  return (
    <div className="overflow-hidden border border-border bg-card p-6 sm:p-8">
      <div className="mb-8">
        <p className="ev-eyebrow">Instances</p>
        <h1 className="mt-3 text-2xl text-foreground sm:text-[1.7rem]">Registry</h1>
        <p className="mt-3 font-mono text-xs text-faint">
          {registries.length} configured instance{registries.length !== 1 ? "s" : ""}
        </p>
      </div>

      {registries.length === 0 ? (
        <div className="flex items-center justify-center border border-border py-24">
          <p className="text-sm text-muted-foreground">No registries configured</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
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
  );
}

function RegistryListSkeleton() {
  return (
    <div className="overflow-hidden border border-border bg-card p-6 sm:p-8">
      <div className="mb-8">
        <Skeleton className="mb-2 h-3 w-24 rounded-md bg-muted" />
        <Skeleton className="h-12 w-48 rounded-md bg-muted" />
        <Skeleton className="mt-4 h-3 w-40 rounded-md bg-muted" />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 3 }).map((_, index) => (
          <div key={index} className="border border-border bg-muted/20 p-4">
            <Skeleton className="h-5 w-32 rounded-md bg-muted" />
            <Skeleton className="mt-4 h-3 w-full rounded-md bg-muted" />
            <Skeleton className="mt-2 h-3 w-3/4 rounded-md bg-muted" />
            <Skeleton className="mt-6 h-9 w-full rounded-md bg-muted" />
          </div>
        ))}
      </div>
    </div>
  );
}
