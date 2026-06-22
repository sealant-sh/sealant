import { RepositoryList, Separator, Skeleton } from "@sealant/ui";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";

import { useTRPC } from "@/lib/trpc/react";

export const Route = createFileRoute("/_authenticated/registry/$registryId/")({
  loader: async ({ context, params }) => {
    const [registry, repositories] = await Promise.all([
      context.queryClient.ensureQueryData(
        context.trpc.registry.byId.queryOptions({ registryId: params.registryId }),
      ),
      context.queryClient.ensureQueryData(
        context.trpc.registry.repositories.queryOptions({ registryId: params.registryId }),
      ),
    ]);

    return { registry, repositories };
  },
  pendingComponent: RegistryDetailSkeleton,
  component: RegistryDetailPage,
});

function RegistryDetailPage() {
  const { registry, repositories } = Route.useLoaderData();
  const queryClient = useQueryClient();
  const trpc = useTRPC();

  async function loadTags(repository: string) {
    const result = await queryClient.fetchQuery(
      trpc.registry.tags.queryOptions({
        registryId: registry.id,
        repository,
      }),
    );

    return result.tags;
  }

  return (
    <div className="overflow-hidden border border-border bg-card p-6 sm:p-8">
      <nav className="mb-6 flex items-center gap-2 font-mono text-xs text-faint">
        <Link
          to="/registry"
          className="flex items-center gap-1 text-muted-foreground no-underline transition-colors hover:text-primary"
        >
          <ArrowLeft className="size-3" />
          Registry
        </Link>
        <span className="text-faint">/</span>
        <span className="text-foreground">{registry.name}</span>
      </nav>

      <div className="mb-8">
        <h1 className="font-mono text-2xl font-medium text-primary sm:text-[1.7rem]">
          {registry.name}
        </h1>
        <div className="mt-4 flex flex-wrap items-center gap-4">
          <span className="font-mono text-sm text-ink-2">{registry.baseUrl}</span>
          <span
            className={
              registry.hasBasicAuth
                ? "flex items-center gap-1.5 text-xs text-success"
                : "flex items-center gap-1.5 text-xs text-muted-foreground"
            }
          >
            <span
              className={
                registry.hasBasicAuth
                  ? "size-1.5 rounded-full bg-success-dot"
                  : "size-1.5 rounded-full border-[1.5px] border-faint"
              }
            />
            {registry.hasBasicAuth ? "Basic auth" : "No auth"}
          </span>
        </div>
        <div className="mt-4 grid grid-cols-1 gap-x-8 gap-y-3 sm:grid-cols-2">
          <MetaField label="Base URL" value={registry.baseUrl} />
          <MetaField label="Push registry" value={registry.pushRegistry} />
        </div>
      </div>

      <Separator className="mb-8 bg-border" />

      <div>
        <div className="mb-4 flex items-baseline gap-3">
          <h2 className="text-base font-medium text-foreground">Repositories</h2>
          <span className="font-mono text-xs text-faint">({repositories.length})</span>
        </div>
        <RepositoryList
          registryId={registry.id}
          repositories={repositories}
          onLoadTags={loadTags}
        />
      </div>
    </div>
  );
}

function MetaField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="ev-eyebrow">{label}</p>
      <p className="mt-1 font-mono text-xs text-foreground truncate" title={value}>
        {value}
      </p>
    </div>
  );
}

function RegistryDetailSkeleton() {
  return (
    <div className="overflow-hidden border border-border bg-card p-6 sm:p-8">
      <Skeleton className="mb-6 h-3 w-32 rounded-md bg-muted" />
      <Skeleton className="mb-4 h-10 w-56 rounded-md bg-muted" />
      <div className="mb-3 flex gap-4">
        <Skeleton className="h-3 w-48 rounded-md bg-muted" />
        <Skeleton className="h-5 w-20 rounded-md bg-muted" />
      </div>
      <div className="mb-8 grid grid-cols-2 gap-4">
        <Skeleton className="h-8 rounded-md bg-muted" />
        <Skeleton className="h-8 rounded-md bg-muted" />
      </div>
      <Skeleton className="mb-8 h-px w-full rounded-md bg-muted" />
      <Skeleton className="mb-4 h-3 w-28 rounded-md bg-muted" />
      <div className="border border-border">
        {Array.from({ length: 4 }).map((_, index) => (
          <div
            key={index}
            className="flex items-center gap-3 border-b border-border px-4 py-3 last:border-b-0"
          >
            <Skeleton className="h-3 w-3 rounded-md bg-muted" />
            <Skeleton className="h-3 flex-1 rounded-md bg-muted" />
            <Skeleton className="h-5 w-10 rounded-md bg-muted" />
          </div>
        ))}
      </div>
    </div>
  );
}
