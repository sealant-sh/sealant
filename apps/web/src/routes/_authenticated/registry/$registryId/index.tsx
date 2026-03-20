import { Badge, RepositoryList, Separator, Skeleton } from "@sealant/ui";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";

import { getRegistry, getRepositoryTags, listRepositories } from "@/lib/api/registry-service";

export const Route = createFileRoute("/_authenticated/registry/$registryId/")({
  loader: async ({ params }) => {
    const [registry, repositories] = await Promise.all([
      getRegistry(params.registryId),
      listRepositories(params.registryId),
    ]);

    return { registry, repositories };
  },
  pendingComponent: RegistryDetailSkeleton,
  component: RegistryDetailPage,
});

function RegistryDetailPage() {
  const { registry, repositories } = Route.useLoaderData();

  async function loadTags(repository: string) {
    const result = await getRepositoryTags(registry.id, repository);
    return result.tags;
  }

  return (
    <div className="overflow-hidden border border-white/10 bg-slate-950/60 p-6 sm:p-8">
      <nav className="mb-6 flex items-center gap-2 font-mono text-xs tracking-[0.28em] uppercase text-slate-400">
        <Link to="/registry" className="flex items-center gap-1 text-slate-400 no-underline transition-colors hover:text-white">
          <ArrowLeft className="size-3" />
          Registry
        </Link>
        <span className="text-slate-600">/</span>
        <span className="text-white">{registry.name.toUpperCase()}</span>
      </nav>

      <div className="mb-8">
        <h1 className="text-4xl font-black tracking-[-0.05em] uppercase text-white leading-none">{registry.name.toUpperCase()}</h1>
        <div className="mt-4 flex flex-wrap items-center gap-4">
          <span className="font-mono text-sm text-cyan-200">{registry.baseUrl}</span>
          <Badge
            className={
              registry.hasBasicAuth
                ? "rounded-none bg-cyan-300 text-slate-950 font-mono text-[10px] tracking-[0.28em] uppercase"
                : "rounded-none bg-slate-700 text-slate-200 font-mono text-[10px] tracking-[0.28em] uppercase"
            }
          >
            {registry.hasBasicAuth ? "Basic auth" : "No auth"}
          </Badge>
        </div>
        <div className="mt-4 grid grid-cols-1 gap-x-8 gap-y-3 sm:grid-cols-2">
          <MetaField label="Base URL" value={registry.baseUrl} />
          <MetaField label="Push registry" value={registry.pushRegistry} />
        </div>
      </div>

      <Separator className="mb-8 bg-white/10" />

      <div>
        <div className="mb-4 flex items-baseline gap-3">
          <h2 className="text-sm font-black tracking-[0.3em] uppercase text-white">Repositories</h2>
          <span className="font-mono text-xs text-slate-400">({repositories.length})</span>
        </div>
        <RepositoryList registryId={registry.id} repositories={repositories} onLoadTags={loadTags} />
      </div>
    </div>
  );
}

function MetaField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="font-mono text-[10px] tracking-[0.28em] uppercase text-slate-500">{label}</p>
      <p className="mt-1 font-mono text-xs text-slate-200 truncate" title={value}>
        {value}
      </p>
    </div>
  );
}

function RegistryDetailSkeleton() {
  return (
    <div className="overflow-hidden border border-white/10 bg-slate-950/60 p-6 sm:p-8">
      <Skeleton className="mb-6 h-3 w-32 rounded-none bg-white/10" />
      <Skeleton className="mb-4 h-10 w-56 rounded-none bg-white/10" />
      <div className="mb-3 flex gap-4">
        <Skeleton className="h-3 w-48 rounded-none bg-white/10" />
        <Skeleton className="h-5 w-20 rounded-none bg-white/10" />
      </div>
      <div className="mb-8 grid grid-cols-2 gap-4">
        <Skeleton className="h-8 rounded-none bg-white/10" />
        <Skeleton className="h-8 rounded-none bg-white/10" />
      </div>
      <Skeleton className="mb-8 h-px w-full rounded-none bg-white/10" />
      <Skeleton className="mb-4 h-3 w-28 rounded-none bg-white/10" />
      <div className="border border-white/10">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="flex items-center gap-3 border-b border-white/10 px-4 py-3 last:border-b-0">
            <Skeleton className="h-3 w-3 rounded-none bg-white/10" />
            <Skeleton className="h-3 flex-1 rounded-none bg-white/10" />
            <Skeleton className="h-5 w-10 rounded-none bg-white/10" />
          </div>
        ))}
      </div>
    </div>
  );
}
