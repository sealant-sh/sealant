import { RepositoryList, Skeleton } from "@sealant/ui";
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
    <div className="space-y-8 p-8 lg:p-10">
      <nav className="flex items-center gap-2 font-mono text-xs text-faint">
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

      <header>
        <p className="ev-eyebrow">Registry instance</p>
        <h1 className="mt-3 font-display text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
          {registry.name}
        </h1>
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
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
      </header>

      <div className="grid grid-cols-1 gap-px overflow-hidden rounded-2xl border border-border bg-rule-faint shadow-[var(--shadow-sm)] sm:grid-cols-2">
        <MetaField label="Base URL" value={registry.baseUrl} />
        <MetaField label="Push registry" value={registry.pushRegistry} />
      </div>

      <div className="space-y-4">
        <div className="flex items-baseline gap-3">
          <h2 className="text-base font-semibold tracking-[-0.01em] text-foreground">
            Repositories
          </h2>
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
    <div className="bg-popover px-5 py-4">
      <p className="ev-eyebrow">{label}</p>
      <p className="mt-1.5 font-mono text-xs text-foreground truncate" title={value}>
        {value}
      </p>
    </div>
  );
}

function RegistryDetailSkeleton() {
  return (
    <div className="space-y-8 p-8 lg:p-10">
      <Skeleton className="h-3 w-32 rounded-lg bg-muted" />
      <div>
        <Skeleton className="h-9 w-56 rounded-lg bg-muted" />
        <div className="mt-3 flex gap-4">
          <Skeleton className="h-3 w-48 rounded-lg bg-muted" />
          <Skeleton className="h-5 w-20 rounded-lg bg-muted" />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4 rounded-2xl border border-border bg-popover p-5 shadow-[var(--shadow-sm)]">
        <Skeleton className="h-8 rounded-lg bg-muted" />
        <Skeleton className="h-8 rounded-lg bg-muted" />
      </div>
      <Skeleton className="h-3 w-28 rounded-lg bg-muted" />
      <div className="divide-y divide-rule-faint rounded-2xl border border-border bg-popover px-5 shadow-[var(--shadow-sm)]">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="flex items-center gap-3 py-3.5">
            <Skeleton className="h-3 w-3 rounded-full bg-muted" />
            <Skeleton className="h-3 flex-1 rounded-lg bg-muted" />
            <Skeleton className="h-5 w-10 rounded-lg bg-muted" />
          </div>
        ))}
      </div>
    </div>
  );
}
