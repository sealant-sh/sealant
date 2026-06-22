import { Button } from "@sealant/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useRouterState } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import { useTRPC } from "@/lib/trpc/react";

export const Route = createFileRoute("/_authenticated/github/setup")({
  component: GitHubSetupPage,
});

const readGitHubSetupSearch = (search: string) => {
  const params = new URLSearchParams(search);
  const installationId = params.get("installation_id")?.trim();
  const setupAction = params.get("setup_action")?.trim();

  return {
    installationId:
      installationId === undefined || installationId.length === 0 ? undefined : installationId,
    setupAction: setupAction === undefined || setupAction.length === 0 ? undefined : setupAction,
  };
};

function GitHubSetupPage() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const locationSearch = useRouterState({ select: (state) => state.location.searchStr });
  const search = useMemo(() => readGitHubSetupSearch(locationSearch), [locationSearch]);
  const [externalInstallationId, setExternalInstallationId] = useState(search.installationId ?? "");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const attemptedImportIdsRef = useRef<Set<string>>(new Set());

  const installationsQuery = useQuery({
    ...trpc.github.installations.queryOptions(),
    staleTime: 1000 * 30,
  });
  const importInstallationMutation = useMutation(
    trpc.github.importInstallation.mutationOptions({
      onSuccess: async (response) => {
        setStatusMessage(
          `Imported ${response.installation.accountLogin} and synced ${response.syncedRepositoryCount} repositories.`,
        );
        await queryClient.invalidateQueries({ queryKey: trpc.github.installations.pathKey() });
      },
    }),
  );
  const syncInstallationMutation = useMutation(
    trpc.github.syncInstallation.mutationOptions({
      onSuccess: async (response) => {
        setStatusMessage(
          `Repository sync completed. ${response.syncedRepositoryCount} repositories refreshed.`,
        );
        await queryClient.invalidateQueries({ queryKey: trpc.github.installations.pathKey() });
      },
    }),
  );

  useEffect(() => {
    if (search.installationId !== undefined) {
      setExternalInstallationId(search.installationId);
    }
  }, [search.installationId]);

  useEffect(() => {
    const installationId = search.installationId?.trim();

    if (
      installationId === undefined ||
      installationId.length === 0 ||
      attemptedImportIdsRef.current.has(installationId)
    ) {
      return;
    }

    attemptedImportIdsRef.current.add(installationId);
    importInstallationMutation.mutate({ externalInstallationId: installationId });
  }, [importInstallationMutation, search.installationId]);

  const importErrorMessage = useMemo(() => {
    return importInstallationMutation.error instanceof Error
      ? importInstallationMutation.error.message
      : null;
  }, [importInstallationMutation.error]);

  const syncErrorMessage = useMemo(() => {
    return syncInstallationMutation.error instanceof Error
      ? syncInstallationMutation.error.message
      : null;
  }, [syncInstallationMutation.error]);

  const installations = installationsQuery.data?.items ?? [];

  const handleManualImport = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    event.stopPropagation();

    const normalizedInstallationId = externalInstallationId.trim();
    if (normalizedInstallationId.length === 0) {
      setStatusMessage("Paste a GitHub installation id to import it.");
      return;
    }

    setStatusMessage(null);
    await importInstallationMutation.mutateAsync({
      externalInstallationId: normalizedInstallationId,
    });
  };

  return (
    <section className="overflow-hidden border border-border bg-card">
      <div className="h-1 w-full bg-primary" />

      <div className="grid min-h-[calc(100svh-9.5rem)] gap-0 xl:grid-cols-[1.15fr_0.85fr]">
        <div className="border-b border-border xl:border-b-0 xl:border-r">
          <header className="border-b border-border px-6 py-7 sm:px-8 sm:py-8">
            <p className="ev-eyebrow">github.app</p>
            <h1 className="mt-3 text-2xl text-foreground sm:text-[1.7rem]">
              Connect GitHub access
            </h1>
            <p className="mt-5 max-w-3xl text-sm leading-7 text-muted-foreground">
              Import a GitHub App installation into Sealant, sync its repositories, and make it
              available for sandbox launches without requiring webhook delivery first.
            </p>
          </header>

          <section className="border-t border-border px-6 py-6 sm:px-8 sm:py-7">
            <h2 className="flex items-baseline gap-3 text-lg text-foreground">
              <span className="font-mono text-sm font-medium text-primary">01</span>
              Callback intake
            </h2>
            <div className="mt-4 space-y-4">
              <div className="border border-border bg-background px-4 py-4">
                <p className="ev-eyebrow">Callback status</p>
                <p className="mt-3 text-sm leading-7 text-foreground">
                  {search.installationId === undefined || search.installationId.length === 0
                    ? "Open this page after GitHub redirects back with an installation id, or import manually below."
                    : `Detected installation ${search.installationId}${search.setupAction === undefined ? "" : ` with action '${search.setupAction}'.`}`}
                </p>
              </div>

              {importInstallationMutation.isPending && search.installationId !== undefined ? (
                <div className="border-l-2 border-primary pl-3 text-sm leading-6 text-foreground">
                  Importing installation {search.installationId} and syncing repositories...
                </div>
              ) : null}

              {importErrorMessage === null ? null : (
                <div className="border-l-2 border-[var(--sw-red)] pl-3 text-sm leading-6 text-danger">
                  {importErrorMessage}
                </div>
              )}
            </div>
          </section>

          <section className="border-t border-border px-6 py-6 sm:px-8 sm:py-7">
            <h2 className="flex items-baseline gap-3 text-lg text-foreground">
              <span className="font-mono text-sm font-medium text-primary">02</span>
              Manual import
            </h2>
            <form className="mt-4 space-y-4" onSubmit={handleManualImport}>
              <label className="flex flex-col gap-2">
                <span className="text-sm font-medium text-foreground">
                  External installation id
                </span>
                <input
                  value={externalInstallationId}
                  onChange={(event) => {
                    setExternalInstallationId(event.target.value);
                    setStatusMessage(null);
                  }}
                  className="h-11 w-full rounded-md border border-input bg-background px-3 font-mono text-sm text-foreground placeholder:text-faint focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:outline-none"
                  placeholder="12345678"
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>

              <div className="flex flex-col gap-3 sm:flex-row">
                <Button
                  type="submit"
                  className="h-11 px-5"
                  disabled={importInstallationMutation.isPending}
                >
                  {importInstallationMutation.isPending ? "Importing..." : "Import installation"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="h-11 px-5"
                  onClick={() => {
                    window.location.assign("/sandboxes/new");
                  }}
                >
                  Go to sandbox builder
                </Button>
              </div>
            </form>
          </section>
        </div>

        <aside className="bg-background px-6 py-7 sm:px-8 xl:px-6 xl:py-8">
          <div className="xl:sticky xl:top-6">
            <h2 className="text-xl text-foreground">Connected installs</h2>

            {statusMessage === null ? null : (
              <div className="mt-6 border-l-2 border-primary pl-3 text-sm leading-6 text-foreground">
                {statusMessage}
              </div>
            )}

            {syncErrorMessage === null ? null : (
              <div className="mt-6 border-l-2 border-[var(--sw-red)] pl-3 text-sm leading-6 text-danger">
                {syncErrorMessage}
              </div>
            )}

            <div className="mt-6 border-t border-border pt-6">
              <p className="ev-eyebrow">Installation cache</p>

              {installationsQuery.isLoading ? (
                <div className="mt-4 border border-border bg-card px-4 py-4 text-sm text-muted-foreground">
                  Loading granted installations...
                </div>
              ) : installations.length === 0 ? (
                <div className="mt-4 border border-border bg-card px-4 py-4 text-sm leading-7 text-muted-foreground">
                  No granted installations are available yet. Import one above, then head back to
                  the sandbox builder.
                </div>
              ) : (
                <div className="mt-4 space-y-3">
                  {installations.map((installation) => {
                    const isRefreshing =
                      syncInstallationMutation.isPending &&
                      syncInstallationMutation.variables?.installationId ===
                        installation.installationId;

                    return (
                      <div
                        key={installation.installationId}
                        className="border border-border bg-card px-4 py-4"
                      >
                        <div className="flex items-start justify-between gap-4">
                          <div>
                            <p className="font-mono text-sm font-medium text-primary break-all">
                              {installation.accountLogin}
                            </p>
                            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                              <span className="font-mono text-xs text-faint">
                                {installation.accountType} · {installation.repositorySelection}
                              </span>
                              <InstallationStatus status={installation.status} />
                            </div>
                          </div>
                          <Button
                            type="button"
                            variant="outline"
                            className="h-10 px-3"
                            disabled={isRefreshing}
                            onClick={() => {
                              setStatusMessage(null);
                              syncInstallationMutation.mutate({
                                installationId: installation.installationId,
                              });
                            }}
                          >
                            {isRefreshing ? "Syncing..." : "Refresh repos"}
                          </Button>
                        </div>

                        <div className="mt-4 grid gap-3 sm:grid-cols-2">
                          <MetaField label="Installation id" value={installation.installationId} />
                          <MetaField
                            label="Last synced"
                            value={installation.lastSyncedAt ?? "Never synced"}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </aside>
      </div>
    </section>
  );
}

const INSTALLATION_STATUS_PRESENTATION = {
  active: { dot: "bg-success-dot", text: "text-success", label: "Active" },
  suspended: { dot: "bg-warning-dot", text: "text-warning", label: "Suspended" },
  deleted: { dot: "bg-danger-dot", text: "text-danger", label: "Deleted" },
} as const;

function InstallationStatus(props: { readonly status: string }) {
  const presentation =
    INSTALLATION_STATUS_PRESENTATION[
      props.status as keyof typeof INSTALLATION_STATUS_PRESENTATION
    ];

  if (presentation === undefined) {
    return <span className="font-mono text-xs text-faint">{props.status}</span>;
  }

  return (
    <span className={`flex items-center gap-1.5 text-xs ${presentation.text}`}>
      <span className={`size-1.5 rounded-full ${presentation.dot}`} />
      {presentation.label}
    </span>
  );
}

function MetaField(props: { readonly label: string; readonly value: string }) {
  return (
    <div>
      <p className="ev-eyebrow">{props.label}</p>
      <p className="mt-1 font-mono text-[0.68rem] text-foreground break-all">{props.value}</p>
    </div>
  );
}
