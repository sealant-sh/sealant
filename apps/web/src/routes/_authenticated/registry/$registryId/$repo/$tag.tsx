import { ManifestDetail, Skeleton } from "@sealant/ui";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";

import { getManifest, getRegistry } from "@/lib/api/registry-service";

export const Route = createFileRoute("/_authenticated/registry/$registryId/$repo/$tag")({
  loader: async ({ params }) => {
    const repository = decodeURIComponent(params.repo);
    const [registry, manifest] = await Promise.all([
      getRegistry(params.registryId),
      getManifest(params.registryId, repository, params.tag),
    ]);

    return { registry, manifest, repository };
  },
  pendingComponent: ManifestSkeleton,
  component: ManifestPage,
});

function ManifestPage() {
  const { registry, manifest, repository } = Route.useLoaderData();
  const { registryId } = Route.useParams();

  return (
    <div className="overflow-hidden border border-white/10 bg-slate-950/60 p-6 sm:p-8">
      <nav className="mb-6 flex flex-wrap items-center gap-2 font-mono text-xs tracking-[0.28em] uppercase text-slate-400">
        <Link to="/registry" className="text-slate-400 no-underline transition-colors hover:text-white">
          Registry
        </Link>
        <span className="text-slate-600">/</span>
        <Link to="/registry/$registryId" params={{ registryId }} className="text-slate-400 no-underline transition-colors hover:text-white">
          {registry.name.toUpperCase()}
        </Link>
        <span className="text-slate-600">/</span>
        <Link to="/registry/$registryId" params={{ registryId }} className="text-slate-400 no-underline transition-colors hover:text-white">
          {repository}
        </Link>
        <span className="text-slate-600">/</span>
        <span className="text-white">{manifest.reference}</span>
      </nav>

      <Link
        to="/registry/$registryId"
        params={{ registryId }}
        className="mb-6 inline-flex items-center gap-1.5 font-mono text-xs tracking-[0.28em] uppercase text-slate-400 no-underline transition-colors hover:text-white"
      >
        <ArrowLeft className="size-3" />
        Back to registry
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
  );
}

function ManifestSkeleton() {
  return (
    <div className="overflow-hidden border border-white/10 bg-slate-950/60 p-6 sm:p-8">
      <Skeleton className="mb-6 h-3 w-64 rounded-none bg-white/10" />
      <Skeleton className="mb-6 h-3 w-32 rounded-none bg-white/10" />
      <div className="mb-6 border border-white/10 bg-white/5 p-6">
        <Skeleton className="mb-2 h-2 w-16 rounded-none bg-white/10" />
        <Skeleton className="mb-3 h-8 w-3/4 rounded-none bg-white/10" />
        <Skeleton className="h-3 w-48 rounded-none bg-white/10" />
      </div>
      <div className="mb-6 grid grid-cols-3 gap-px border border-white/10 bg-white/10">
        {Array.from({ length: 3 }).map((_, index) => (
          <div key={index} className="bg-slate-950/80 p-4">
            <Skeleton className="mb-2 h-2 w-20 rounded-none bg-white/10" />
            <Skeleton className="h-4 w-24 rounded-none bg-white/10" />
          </div>
        ))}
      </div>
      <Skeleton className="mb-3 h-3 w-16 rounded-none bg-white/10" />
      <div className="border border-white/10">
        {Array.from({ length: 3 }).map((_, index) => (
          <div key={index} className="flex items-center gap-4 border-b border-white/10 px-4 py-2.5 last:border-b-0">
            <Skeleton className="h-3 flex-1 rounded-none bg-white/10" />
            <Skeleton className="h-3 w-16 rounded-none bg-white/10" />
            <Skeleton className="h-5 w-24 rounded-none bg-white/10" />
          </div>
        ))}
      </div>
    </div>
  );
}
