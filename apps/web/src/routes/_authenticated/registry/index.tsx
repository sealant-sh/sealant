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
    <div className="space-y-8 p-8 lg:p-10">
      <header>
        <p className="ev-eyebrow">Instances</p>
        <h1 className="mt-3 font-display text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
          Registry
        </h1>
        <p className="mt-2 font-mono text-xs text-faint">
          {registries.length} configured instance{registries.length !== 1 ? "s" : ""}
        </p>
      </header>

      {registries.length === 0 ? (
        <div className="flex items-center justify-center rounded-2xl border border-border bg-popover py-24 shadow-[var(--shadow-sm)]">
          <p className="text-sm text-muted-foreground">No registries configured</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3">
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
    <div className="space-y-8 p-8 lg:p-10">
      <div>
        <Skeleton className="mb-2 h-3 w-24 rounded-lg bg-muted" />
        <Skeleton className="h-9 w-48 rounded-lg bg-muted" />
        <Skeleton className="mt-3 h-3 w-40 rounded-lg bg-muted" />
      </div>
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 3 }).map((_, index) => (
          <div
            key={index}
            className="rounded-2xl border border-border bg-popover p-6 shadow-[var(--shadow-sm)]"
          >
            <Skeleton className="h-5 w-32 rounded-lg bg-muted" />
            <Skeleton className="mt-4 h-3 w-full rounded-lg bg-muted" />
            <Skeleton className="mt-2 h-3 w-3/4 rounded-lg bg-muted" />
            <Skeleton className="mt-6 h-9 w-full rounded-lg bg-muted" />
          </div>
        ))}
      </div>
    </div>
  );
}
