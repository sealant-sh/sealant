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
    <div className="overflow-hidden border border-border bg-card p-6 sm:p-8">
      <nav className="mb-6 flex flex-wrap items-center gap-2 font-mono text-xs tracking-[0.1em] text-muted-foreground">
        <Link
          to="/registry"
          className="text-muted-foreground no-underline transition-colors hover:text-foreground"
        >
          Registry
        </Link>
        <span className="text-muted-foreground/60">/</span>
        <Link
          to="/registry/$registryId"
          params={{ registryId }}
          className="text-muted-foreground no-underline transition-colors hover:text-foreground"
        >
          {registry.name.toUpperCase()}
        </Link>
        <span className="text-muted-foreground/60">/</span>
        <Link
          to="/registry/$registryId"
          params={{ registryId }}
          className="text-muted-foreground no-underline transition-colors hover:text-foreground"
        >
          {repository}
        </Link>
        <span className="text-muted-foreground/60">/</span>
        <span className="text-foreground">{manifest.reference}</span>
      </nav>

      <Link
        to="/registry/$registryId"
        params={{ registryId }}
        className="mb-6 inline-flex items-center gap-1.5 font-mono text-xs tracking-[0.1em] text-muted-foreground no-underline transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-3" />
        Back to registry
      </Link>

      <ManifestDetail
        repository={manifest.repository}
        reference={manifest.reference}
        {...(manifest.digest !== undefined ? { digest: manifest.digest } : {})}
        contentType={manifest.contentType}
        manifest={manifest.manifest}
        className="mt-6"
      />
    </div>
  );
}

function ManifestSkeleton() {
  return (
    <div className="overflow-hidden border border-border bg-card p-6 sm:p-8">
      <Skeleton className="mb-6 h-3 w-64 rounded-none bg-muted" />
      <Skeleton className="mb-6 h-3 w-32 rounded-none bg-muted" />
      <div className="mb-6 border border-border bg-muted/20 p-6">
        <Skeleton className="mb-2 h-2 w-16 rounded-none bg-muted" />
        <Skeleton className="mb-3 h-8 w-3/4 rounded-none bg-muted" />
        <Skeleton className="h-3 w-48 rounded-none bg-muted" />
      </div>
      <div className="mb-6 grid grid-cols-3 gap-px border border-border bg-border">
        {Array.from({ length: 3 }).map((_, index) => (
          <div key={index} className="bg-card p-4">
            <Skeleton className="mb-2 h-2 w-20 rounded-none bg-muted" />
            <Skeleton className="h-4 w-24 rounded-none bg-muted" />
          </div>
        ))}
      </div>
      <Skeleton className="mb-3 h-3 w-16 rounded-none bg-muted" />
      <div className="border border-border">
        {Array.from({ length: 3 }).map((_, index) => (
          <div
            key={index}
            className="flex items-center gap-4 border-b border-border px-4 py-2.5 last:border-b-0"
          >
            <Skeleton className="h-3 flex-1 rounded-none bg-muted" />
            <Skeleton className="h-3 w-16 rounded-none bg-muted" />
            <Skeleton className="h-5 w-24 rounded-none bg-muted" />
          </div>
        ))}
      </div>
    </div>
  );
}
