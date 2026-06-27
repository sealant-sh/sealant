import { ManifestDetail, Skeleton } from "@sealant/ui";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";

export const Route = createFileRoute("/_authenticated/registry/$registryId/$repo/$tag")({
  loader: async ({ context, params }) => {
    const repository = decodeURIComponent(params.repo);
    const [registry, manifest] = await Promise.all([
      context.queryClient.ensureQueryData(
        context.trpc.registry.byId.queryOptions({ registryId: params.registryId }),
      ),
      context.queryClient.ensureQueryData(
        context.trpc.registry.manifest.queryOptions({
          registryId: params.registryId,
          reference: params.tag,
          repository,
        }),
      ),
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
    <div className="space-y-8 p-8 lg:p-10">
      <nav className="flex flex-wrap items-center gap-2 font-mono text-xs text-faint">
        <Link
          to="/registry"
          className="text-muted-foreground no-underline transition-colors hover:text-primary"
        >
          Registry
        </Link>
        <span className="text-faint">/</span>
        <Link
          to="/registry/$registryId"
          params={{ registryId }}
          className="text-muted-foreground no-underline transition-colors hover:text-primary"
        >
          {registry.name}
        </Link>
        <span className="text-faint">/</span>
        <Link
          to="/registry/$registryId"
          params={{ registryId }}
          className="text-muted-foreground no-underline transition-colors hover:text-primary"
        >
          {repository}
        </Link>
        <span className="text-faint">/</span>
        <span className="text-foreground">{manifest.reference}</span>
      </nav>

      <Link
        to="/registry/$registryId"
        params={{ registryId }}
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground no-underline transition-colors hover:text-primary"
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
      />
    </div>
  );
}

function ManifestSkeleton() {
  return (
    <div className="space-y-8 p-8 lg:p-10">
      <Skeleton className="h-3 w-64 rounded-lg bg-muted" />
      <Skeleton className="h-3 w-32 rounded-lg bg-muted" />
      <div className="rounded-2xl border border-border bg-popover p-6 shadow-[var(--shadow-sm)]">
        <Skeleton className="mb-2 h-2 w-16 rounded-lg bg-muted" />
        <Skeleton className="mb-3 h-8 w-3/4 rounded-lg bg-muted" />
        <Skeleton className="h-3 w-48 rounded-lg bg-muted" />
      </div>
      <div className="grid grid-cols-3 gap-px overflow-hidden rounded-2xl border border-border bg-rule-faint shadow-[var(--shadow-sm)]">
        {Array.from({ length: 3 }).map((_, index) => (
          <div key={index} className="bg-popover p-5">
            <Skeleton className="mb-2 h-2 w-20 rounded-lg bg-muted" />
            <Skeleton className="h-4 w-24 rounded-lg bg-muted" />
          </div>
        ))}
      </div>
      <Skeleton className="h-3 w-16 rounded-lg bg-muted" />
      <div className="divide-y divide-rule-faint rounded-2xl border border-border bg-popover px-5 shadow-[var(--shadow-sm)]">
        {Array.from({ length: 3 }).map((_, index) => (
          <div key={index} className="flex items-center gap-4 py-3">
            <Skeleton className="h-3 flex-1 rounded-lg bg-muted" />
            <Skeleton className="h-3 w-16 rounded-lg bg-muted" />
            <Skeleton className="h-5 w-24 rounded-lg bg-muted" />
          </div>
        ))}
      </div>
    </div>
  );
}
