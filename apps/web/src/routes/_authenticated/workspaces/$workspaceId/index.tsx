import { Button } from "@sealant/ui";
import { type NewWorkspace } from "@sealant/validators";
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
  type QueryClient,
} from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useRef, useState, type ReactNode } from "react";

import { runTitle } from "@/lib/run-record/format";
import type { AppTrpc } from "@/lib/trpc/client";
import { useTRPC } from "@/lib/trpc/react";

type WorkspaceStatus = "queued" | "running" | "ready" | "failed" | "cancelled" | "stopped";

interface WorkspaceSummary {
  readonly workspaceId: string;
  readonly name: string;
  readonly status: WorkspaceStatus;
  readonly registryId?: string | undefined;
  readonly repository?: string | undefined;
  readonly tag?: string | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly runtime?: {
    readonly adapter: string;
    readonly resourceId: string;
    readonly status: string;
    readonly endpoint?: string | undefined;
  };
  readonly publishedImage?: {
    readonly reference: string;
    readonly digestReference: string;
  };
  readonly spec?: NewWorkspace;
}

interface WorkspaceAttemptSummary {
  readonly attemptId: string;
  readonly relation: string;
  readonly triggerType: string;
  readonly status: WorkspaceStatus;
  readonly createdAt: string;
}

interface WorkspaceEvent {
  readonly eventId: string;
  readonly type: string;
  readonly occurredAt: string;
  readonly message?: string | undefined;
}

interface WorkspaceSummaryLoaderData {
  readonly attempts: readonly WorkspaceAttemptSummary[];
  readonly events: readonly WorkspaceEvent[];
}

function toWorkspaceSummary(input: {
  readonly workspaceId: string;
  readonly name: string;
  readonly status: WorkspaceStatus;
  readonly registryId?: string | undefined;
  readonly repository?: string | undefined;
  readonly tag?: string | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly runtime?: WorkspaceSummary["runtime"] | undefined;
  readonly publishedImage?: WorkspaceSummary["publishedImage"] | undefined;
  readonly spec?: NewWorkspace | undefined;
}): WorkspaceSummary {
  return {
    workspaceId: input.workspaceId,
    name: input.name,
    status: input.status,
    ...(input.registryId === undefined ? {} : { registryId: input.registryId }),
    ...(input.repository === undefined ? {} : { repository: input.repository }),
    ...(input.tag === undefined ? {} : { tag: input.tag }),
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    ...(input.runtime === undefined ? {} : { runtime: input.runtime }),
    ...(input.publishedImage === undefined ? {} : { publishedImage: input.publishedImage }),
    ...(input.spec === undefined ? {} : { spec: input.spec }),
  };
}

export const Route = createFileRoute("/_authenticated/workspaces/$workspaceId/")({
  loader: async ({
    context,
    params,
  }: {
    context: { queryClient: QueryClient; trpc: AppTrpc };
    params: { workspaceId: string };
  }) => {
    await context.queryClient.ensureQueryData(
      context.trpc.workspace.byId.queryOptions({ workspaceId: params.workspaceId }),
    );
    await context.queryClient.ensureQueryData(
      context.trpc.run.list.queryOptions({ workspaceId: params.workspaceId, limit: 10 }),
    );
    const attemptsResponse = await context.queryClient.ensureQueryData(
      context.trpc.workspace.attempts.queryOptions({ workspaceId: params.workspaceId, limit: 5 }),
    );
    const eventsResponse = await context.queryClient.ensureQueryData(
      context.trpc.workspace.events.queryOptions({ workspaceId: params.workspaceId, limit: 8 }),
    );

    return {
      attempts: attemptsResponse.items,
      events: eventsResponse.items,
    };
  },
  component: WorkspaceSummaryPage,
});

function WorkspaceSummaryPage() {
  const { workspaceId } = Route.useParams();
  const { attempts, events } = Route.useLoaderData() as WorkspaceSummaryLoaderData;
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const workspaceQueryOptions = trpc.workspace.byId.queryOptions({ workspaceId });
  const { data: workspaceResponse } = useSuspenseQuery(workspaceQueryOptions);
  const { data: runsResponse } = useSuspenseQuery(
    trpc.run.list.queryOptions({ workspaceId, limit: 10 }),
  );
  const runs = runsResponse.items;
  const workspace = toWorkspaceSummary(workspaceResponse);
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const [sshCopyState, setSshCopyState] = useState<"idle" | "copied" | "error">("idle");
  const [nameMutationError, setNameMutationError] = useState<string | null>(null);
  const [rerunMutationError, setRerunMutationError] = useState<string | null>(null);
  const sshCommand = buildSshCommand(workspace.runtime?.endpoint);
  const workspaceSpecDetails = resolveWorkspaceSpecDetails(workspace);
  const vscodeOpenUri = buildVsCodeOpenUri({
    endpoint: workspace.runtime?.endpoint,
    workspaceId: workspace.workspaceId,
    workingDirectory: workspaceSpecDetails?.workingDirectory,
  });
  const cursorOpenUri = buildCursorOpenUri({
    endpoint: workspace.runtime?.endpoint,
    workspaceId: workspace.workspaceId,
    workingDirectory: workspaceSpecDetails?.workingDirectory,
  });
  const nameSuggestions = suggestWorkspaceNames(workspace);
  const canRerunWorkspace =
    workspace.registryId !== undefined &&
    workspace.repository !== undefined &&
    workspace.tag !== undefined &&
    workspace.spec !== undefined;

  const renameWorkspaceMutation = useMutation(
    trpc.workspace.rename.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: workspaceQueryOptions.queryKey });
      },
    }),
  );
  const rerunWorkspaceMutation = useMutation(trpc.workspace.create.mutationOptions());
  const stopWorkspaceMutation = useMutation(
    trpc.workspace.stop.mutationOptions({
      onSuccess: async () => {
        // The stop also changes the list and sidebar rows — invalidate the whole workspace family.
        await queryClient.invalidateQueries({ queryKey: trpc.workspace.pathKey() });
      },
    }),
  );
  // Stop targets a live runtime, which only "ready" guarantees (a "running" workspace is still
  // building — there is no container to stop yet, and the API answers 409).
  const canStopWorkspace = workspace.status === "ready";
  const stopMutationError =
    stopWorkspaceMutation.error === null
      ? null
      : resolveMutationErrorMessage(stopWorkspaceMutation.error);
  // DESIGN.md: no more than one prominent warning in a viewport — the action column shows the
  // most recent failure only.
  const actionError = stopMutationError ?? rerunMutationError;

  const copySshCommand = async () => {
    if (sshCommand === null) {
      return;
    }

    if (typeof navigator === "undefined" || navigator.clipboard === undefined) {
      setSshCopyState("error");
      return;
    }

    try {
      await navigator.clipboard.writeText(sshCommand);
      setSshCopyState("copied");
    } catch {
      setSshCopyState("error");
    }
  };

  const saveWorkspaceName = async () => {
    const name = nameInputRef.current?.value.trim() ?? "";

    if (name.length === 0) {
      setNameMutationError("Workspace name cannot be empty.");
      return;
    }

    setNameMutationError(null);

    try {
      await renameWorkspaceMutation.mutateAsync({
        workspaceId: workspace.workspaceId,
        name,
      });
    } catch (error) {
      setNameMutationError(resolveMutationErrorMessage(error));
    }
  };

  const openWorkspaceInVsCode = () => {
    if (vscodeOpenUri === null || typeof window === "undefined") {
      return;
    }

    window.location.assign(vscodeOpenUri);
  };

  const openWorkspaceInCursor = () => {
    if (cursorOpenUri === null || typeof window === "undefined") {
      return;
    }

    window.location.assign(cursorOpenUri);
  };

  const rerunWorkspace = async () => {
    if (!canRerunWorkspace) {
      setRerunMutationError(
        "Workspace rerun is unavailable until source image metadata and spec are ready.",
      );
      return;
    }

    setRerunMutationError(null);

    try {
      const nextWorkspace = await rerunWorkspaceMutation.mutateAsync({
        registryId: workspace.registryId,
        repository: workspace.repository,
        tag: workspace.tag,
        name: workspace.name,
        spec: workspace.spec,
      });

      window.location.assign(`/workspaces/${encodeURIComponent(nextWorkspace.workspaceId)}`);
    } catch (error) {
      setRerunMutationError(resolveMutationErrorMessage(error));
    }
  };

  return (
    <div className="space-y-8">
      {/* Page header — the run-record header lives on a lifted white panel */}
      <section className="overflow-hidden rounded-3xl border border-border bg-popover shadow-[var(--shadow-cobalt)]">
        <div className="grid gap-0 lg:grid-cols-[1fr_auto]">
          <div className="p-8 lg:p-10">
            <div className="flex items-center gap-2.5">
              <RecordingPulse />
              <span className="font-mono text-xs text-ink-2">
                workspace · {workspace.workspaceId}
              </span>
            </div>
            <h1 className="mt-5 max-w-3xl font-display text-2xl font-semibold tracking-tight text-foreground text-balance sm:text-4xl">
              {workspace.name}
            </h1>
            <p className="mt-3 font-mono text-xs text-faint">
              {(workspace.repository ?? "unknown-repository") +
                " / " +
                (workspace.tag ?? "unknown-tag")}
            </p>

            <div className="mt-6 rounded-2xl border border-border bg-card p-5 shadow-[var(--shadow-xs)]">
              <p className="ev-eyebrow">Name</p>
              <div className="mt-3 flex flex-col gap-3">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                  <input
                    key={`${workspace.workspaceId}:${workspace.name}`}
                    ref={nameInputRef}
                    defaultValue={workspace.name}
                    className="h-11 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground focus:border-primary focus:outline-none"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    className="h-11 shrink-0 px-4"
                    onClick={() => {
                      void saveWorkspaceName();
                    }}
                    disabled={renameWorkspaceMutation.isPending}
                  >
                    {renameWorkspaceMutation.isPending ? "Saving" : "Save name"}
                  </Button>
                </div>
                <div className="flex flex-wrap gap-2">
                  {nameSuggestions.map((suggestion) => (
                    <Button
                      key={suggestion}
                      type="button"
                      variant="outline"
                      className="h-8 px-3 text-xs"
                      onClick={() => {
                        if (nameInputRef.current !== null) {
                          nameInputRef.current.value = suggestion;
                        }
                      }}
                    >
                      {suggestion}
                    </Button>
                  ))}
                </div>
                {nameMutationError === null ? null : (
                  <p className="border-l-2 border-danger-dot pl-3 text-sm text-danger">
                    {nameMutationError}
                  </p>
                )}
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-3 border-t border-rule-faint p-8 sm:flex-row sm:border-l sm:border-t-0 sm:p-10 lg:flex-col">
            <Button
              className="h-11 px-5"
              onClick={() => {
                openWorkspaceInVsCode();
              }}
              disabled={vscodeOpenUri === null}
            >
              Open in VS Code
            </Button>
            <Button
              variant="outline"
              className="h-11 px-5"
              onClick={() => {
                openWorkspaceInCursor();
              }}
              disabled={cursorOpenUri === null}
            >
              Open in Cursor
            </Button>
            <Button
              variant="outline"
              className="h-11 px-5"
              onClick={() => {
                void rerunWorkspace();
              }}
              disabled={rerunWorkspaceMutation.isPending || !canRerunWorkspace}
            >
              {rerunWorkspaceMutation.isPending ? "Rerunning" : "Rerun workspace"}
            </Button>
            <Button variant="outline" className="h-11 px-5">
              View spec
            </Button>
            <Button
              variant="outline"
              className="h-11 px-5"
              onClick={() => {
                stopWorkspaceMutation.mutate({ workspaceId: workspace.workspaceId });
              }}
              disabled={stopWorkspaceMutation.isPending || !canStopWorkspace}
            >
              {stopWorkspaceMutation.isPending ? "Stopping" : "Stop workspace"}
            </Button>
            {actionError === null ? null : (
              <p className="border-l-2 border-danger-dot pl-3 text-sm text-danger">{actionError}</p>
            )}
          </div>
        </div>

        {/* run facts — hairline-divided evidence rows */}
        <dl className="grid grid-cols-2 divide-x divide-y divide-rule-faint border-t border-rule-faint sm:grid-cols-4 sm:divide-y-0">
          <MetricCell label="Status" value={<StatusIndicator status={workspace.status} />} />
          <MetricCell
            label="Attempts"
            value={<p className="mt-2 font-mono text-lg text-foreground">{attempts.length}</p>}
          />
          <MetricCell
            label="Created"
            value={
              <p className="mt-2 font-mono text-sm text-foreground">
                {toShortDateTime(workspace.createdAt)}
              </p>
            }
          />
          <MetricCell
            label="Updated"
            value={
              <p className="mt-2 font-mono text-sm text-foreground">
                {toShortDateTime(workspace.updatedAt)}
              </p>
            }
          />
        </dl>
      </section>

      <div className="grid gap-8 xl:grid-cols-[1.35fr_1fr]">
        <div className="space-y-8">
          <Panel>
            <p className="ev-eyebrow">01 · Run records</p>
            <h2 className="mt-3 font-display text-xl font-semibold tracking-tight text-foreground">
              Runs
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              Each run is a harness execution with its evidence attached — commands, output, file
              changes, and the diff it produced.
            </p>
            <div className="mt-6 overflow-hidden rounded-2xl border border-border bg-card shadow-[var(--shadow-xs)]">
              {runs.length === 0 ? (
                <p className="px-4 py-6 font-mono text-[0.68rem] text-muted-foreground">
                  No runs recorded for this workspace yet.
                </p>
              ) : (
                <div className="divide-y divide-rule-faint">
                  {runs.map((run) => (
                    <Link
                      key={run.runId}
                      to="/workspaces/$workspaceId/runs/$runId"
                      params={{ workspaceId, runId: run.runId }}
                      className="grid gap-2 px-4 py-3.5 transition-colors hover:bg-muted/40 sm:grid-cols-[1fr_auto_auto] sm:items-center"
                    >
                      <div className="min-w-0">
                        <p className="font-mono text-[0.66rem] text-faint">{run.runId}</p>
                        <p className="mt-1 truncate text-sm text-foreground">{runTitle(run)}</p>
                      </div>
                      <p className="font-mono text-[0.66rem] text-muted-foreground">
                        {toShortDateTime(run.createdAt)}
                      </p>
                      <StatusIndicator status={run.status} />
                    </Link>
                  ))}
                </div>
              )}
            </div>
          </Panel>

          <Panel>
            <p className="ev-eyebrow">02 · Attempt history</p>
            <h2 className="mt-3 font-display text-xl font-semibold tracking-tight text-foreground">
              Execution attempts
            </h2>
            <div className="mt-6 overflow-hidden rounded-2xl border border-border bg-card shadow-[var(--shadow-xs)]">
              {attempts.length === 0 ? (
                <p className="px-4 py-6 font-mono text-[0.68rem] text-muted-foreground">
                  No attempts recorded.
                </p>
              ) : (
                <div className="divide-y divide-rule-faint">
                  {attempts.map((attempt) => (
                    <div
                      key={attempt.attemptId}
                      className="grid gap-2 px-4 py-3.5 transition-colors hover:bg-muted/40 sm:grid-cols-[1fr_auto_auto] sm:items-center"
                    >
                      <div>
                        <p className="font-mono text-[0.66rem] text-faint">{attempt.attemptId}</p>
                        <p className="mt-1 text-sm text-foreground">
                          {attempt.relation} via {attempt.triggerType}
                        </p>
                      </div>
                      <p className="font-mono text-[0.66rem] text-muted-foreground">
                        {toShortDateTime(attempt.createdAt)}
                      </p>
                      <StatusIndicator status={attempt.status} />
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Panel>

          <Panel>
            <p className="ev-eyebrow">03 · Runtime</p>
            <div className="mt-5 overflow-hidden rounded-2xl border border-border bg-card shadow-[var(--shadow-xs)]">
              <dl className="grid divide-y divide-rule-faint sm:grid-cols-2 sm:divide-x">
                <RuntimeCell label="Adapter" value={workspace.runtime?.adapter ?? "n/a"} />
                <RuntimeCell label="Runtime status" value={workspace.runtime?.status ?? "n/a"} />
                <RuntimeCell label="Resource" value={workspace.runtime?.resourceId ?? "n/a"} />
                <RuntimeCell label="Endpoint" value={workspace.runtime?.endpoint ?? "n/a"} />
              </dl>
            </div>

            {sshCommand === null ? null : (
              <div className="mt-5 rounded-2xl border border-border bg-card p-5 shadow-[var(--shadow-xs)]">
                <p className="ev-eyebrow">SSH access</p>
                <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <code className="break-all font-mono text-[0.68rem] text-ink-2">
                    {sshCommand}
                  </code>
                  <Button
                    type="button"
                    variant="outline"
                    className="h-10 shrink-0 px-4"
                    onClick={() => {
                      void copySshCommand();
                    }}
                  >
                    {sshCopyState === "copied"
                      ? "Copied"
                      : sshCopyState === "error"
                        ? "Copy failed"
                        : "Copy SSH command"}
                  </Button>
                </div>
              </div>
            )}
          </Panel>

          <Panel>
            <p className="ev-eyebrow">04 · Workspace spec</p>
            {workspaceSpecDetails === null ? (
              <p className="mt-5 rounded-2xl border border-border bg-card px-4 py-4 font-mono text-[0.68rem] text-muted-foreground shadow-[var(--shadow-xs)]">
                Spec details are not available for this workspace.
              </p>
            ) : (
              <>
                <div className="mt-5 overflow-hidden rounded-2xl border border-border bg-card shadow-[var(--shadow-xs)]">
                  <dl className="grid divide-y divide-rule-faint sm:grid-cols-2 sm:divide-x">
                    <RuntimeCell
                      label="Repository"
                      value={
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="break-all">{workspaceSpecDetails.repositoryUrl}</span>
                          {workspaceSpecDetails.isGitHubSource ? (
                            <span className="ev-eyebrow">GitHub</span>
                          ) : null}
                        </span>
                      }
                    />
                    <RuntimeCell label="Branch" value={workspaceSpecDetails.branch} />
                    <RuntimeCell label="Provider" value={workspaceSpecDetails.provider} />
                    <RuntimeCell label="Config repo" value={workspaceSpecDetails.configRepo} />
                    <RuntimeCell label="Harness" value={workspaceSpecDetails.harness} />
                    <RuntimeCell
                      label="Runtime target"
                      value={workspaceSpecDetails.runtimeTarget}
                    />
                    <RuntimeCell label="OCI runtime" value={workspaceSpecDetails.ociRuntime} />
                    <RuntimeCell label="OS target" value={workspaceSpecDetails.osTarget} />
                    <RuntimeCell
                      label="Working directory"
                      value={workspaceSpecDetails.workingDirectory}
                    />
                    <RuntimeCell label="SSH" value={workspaceSpecDetails.ssh} />
                  </dl>
                </div>

                <div className="mt-5 rounded-2xl border border-border bg-card p-5 shadow-[var(--shadow-xs)]">
                  <p className="ev-eyebrow">Selected packages</p>
                  {workspaceSpecDetails.selectedPackages.length === 0 ? (
                    <p className="mt-2 text-sm text-muted-foreground">
                      No packages selected during workspace creation.
                    </p>
                  ) : (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {workspaceSpecDetails.selectedPackages.map((pkg) => (
                        <span
                          key={pkg}
                          className="inline-flex h-8 items-center rounded-lg border border-input bg-background px-2.5 font-mono text-[0.66rem] text-ink-2"
                        >
                          {pkg}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}
          </Panel>
        </div>

        <div className="space-y-8">
          <Panel>
            <p className="ev-eyebrow">Recent events</p>
            <div className="mt-5 overflow-hidden rounded-2xl border border-border bg-card shadow-[var(--shadow-xs)]">
              {events.length === 0 ? (
                <p className="px-4 py-6 font-mono text-[0.68rem] text-muted-foreground">
                  No events recorded.
                </p>
              ) : (
                <div className="divide-y divide-rule-faint">
                  {events.map((event) => (
                    <div
                      key={event.eventId}
                      className="px-4 py-3.5 transition-colors hover:bg-muted/40"
                    >
                      <p className="font-mono text-[0.66rem] text-faint">
                        {toShortDateTime(event.occurredAt)}
                      </p>
                      <p className="mt-1 text-sm font-medium text-foreground">{event.type}</p>
                      <p className="mt-1 text-sm text-ink-2">
                        {event.message ?? "No event message."}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Panel>

          <Panel>
            <p className="ev-eyebrow">Image output</p>
            <div className="mt-5 rounded-2xl border border-border bg-card p-5 shadow-[var(--shadow-xs)]">
              <p className="ev-eyebrow">Reference</p>
              <p className="mt-2 break-all text-sm text-foreground">
                {workspace.publishedImage?.reference ?? "No image published"}
              </p>
              <p className="mt-4 ev-eyebrow">Digest</p>
              <p className="mt-2 break-all font-mono text-[0.68rem] text-ink-2">
                {workspace.publishedImage?.digestReference ?? "n/a"}
              </p>
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}

function RecordingPulse() {
  return (
    <span className="relative inline-flex size-2.5 items-center justify-center" aria-hidden="true">
      <span className="absolute inset-0 rounded-full bg-primary motion-safe:animate-ping" />
      <span className="relative size-2 rounded-full bg-primary" />
    </span>
  );
}

function Panel({ children }: { children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-border bg-popover p-6 shadow-[var(--shadow-sm)] sm:p-8">
      {children}
    </section>
  );
}

function MetricCell({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="px-5 py-5 lg:px-8">
      <p className="ev-eyebrow">{label}</p>
      {value}
    </div>
  );
}

function RuntimeCell({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="px-4 py-4">
      <p className="ev-eyebrow">{label}</p>
      <p className="mt-2 text-sm text-foreground">{value}</p>
    </div>
  );
}

// Status reads as a colored dot + a word (DESIGN.md §4): green for an observed
// result, red for a failure, cobalt for in-flight, hollow ring for not-yet-run.
function statusIndicatorClassName(status: string): { readonly dot: string; readonly text: string } {
  if (status === "running") {
    return { dot: "bg-primary", text: "text-primary" };
  }

  if (status === "ready") {
    return { dot: "bg-success-dot", text: "text-success" };
  }

  if (status === "failed") {
    return { dot: "bg-danger-dot", text: "text-danger" };
  }

  if (status === "cancelled") {
    return { dot: "bg-warning-dot", text: "text-warning" };
  }

  return { dot: "border border-input", text: "text-muted-foreground" };
}

function StatusIndicator({ status }: { status: string }) {
  const { dot, text } = statusIndicatorClassName(status);

  return (
    <span className={`mt-2 inline-flex items-center gap-1.5 text-sm ${text}`}>
      <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      {status}
    </span>
  );
}

function toShortDateTime(value: string): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "n/a";
  }

  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

interface ParsedSshEndpoint {
  readonly user: string;
  readonly host: string;
  readonly port?: string;
}

const DEFAULT_WORKSPACE_SSH_USERNAME_PREFIX = "ws";

function resolveWorkspaceSshUsernamePrefixToken(): string {
  const configuredPrefix =
    typeof import.meta.env.VITE_WORKSPACE_SSH_USERNAME_PREFIX === "string"
      ? import.meta.env.VITE_WORKSPACE_SSH_USERNAME_PREFIX.trim()
      : "";
  const rawPrefix =
    configuredPrefix.length > 0 ? configuredPrefix : DEFAULT_WORKSPACE_SSH_USERNAME_PREFIX;

  return rawPrefix.endsWith("-") ? rawPrefix : `${rawPrefix}-`;
}

function isGatewaySshEndpoint(parsed: ParsedSshEndpoint): boolean {
  // Gateway-style usernames look like ws-<workspaceId>; the user's own registered key
  // authenticates them, so commands need no identity flags.
  if (parsed.user.startsWith(resolveWorkspaceSshUsernamePrefixToken())) {
    return true;
  }

  return parsed.user !== "root";
}

function buildEditorSshAuthority(parsed: ParsedSshEndpoint): string {
  if (isGatewaySshEndpoint(parsed)) {
    // VS Code remote authority should use host alias only for gateway flow.
    // The actual host/port are provided by the user's SSH config block.
    return parsed.user;
  }

  return `${parsed.user}@${parsed.host}${parsed.port === undefined ? "" : `:${parsed.port}`}`;
}

function isPrivateOrLocalSshHost(host: string): boolean {
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
    return true;
  }

  const parts = host.split(".");

  if (parts.length !== 4 || parts.some((part) => /^\d+$/.test(part) === false)) {
    return false;
  }

  const octets = parts.map((part) => Number(part));

  if (octets.some((part) => Number.isNaN(part) || part < 0 || part > 255)) {
    return false;
  }

  const first = octets[0] ?? -1;
  const second = octets[1] ?? -1;

  if (first === 10 || first === 127) {
    return true;
  }

  if (first === 192 && second === 168) {
    return true;
  }

  return first === 172 && second >= 16 && second <= 31;
}

function buildWorkspaceSshAlias(workspaceId: string): string {
  const prefixWithDash = resolveWorkspaceSshUsernamePrefixToken();

  return `${prefixWithDash}${workspaceId}`;
}

function shouldUseWorkspaceAliasForEditor(input: {
  parsed: ParsedSshEndpoint;
  workspaceId: string | undefined;
}): boolean {
  if (input.workspaceId === undefined) {
    return false;
  }

  if (isGatewaySshEndpoint(input.parsed)) {
    return true;
  }

  // Safety fallback: if API still returns an internal container address, prefer the
  // stable ws-* alias so VS Code resolves via local SSH config instead of direct runtime IP.
  return input.parsed.user === "root" && isPrivateOrLocalSshHost(input.parsed.host);
}

function buildEditorSshAuthorityFromEndpoint(input: {
  endpoint: string | undefined;
  workspaceId: string | undefined;
}): string | null {
  const parsed = parseSshEndpoint(input.endpoint);
  if (parsed === null) {
    return null;
  }

  if (shouldUseWorkspaceAliasForEditor({ parsed, workspaceId: input.workspaceId })) {
    const workspaceId = input.workspaceId;

    if (workspaceId === undefined) {
      return buildEditorSshAuthority(parsed);
    }

    return buildWorkspaceSshAlias(workspaceId);
  }

  return buildEditorSshAuthority(parsed);
}

// Keep localhost forms consistent so copy/open actions look predictable.
function normalizeSshHost(host: string): string {
  const normalized = host.trim();

  if (normalized === "127.0.0.1" || normalized === "::1") {
    return "localhost";
  }

  return normalized;
}

// Parse several endpoint shapes we may encounter in older/newer payloads:
// - ssh://user@host:port
// - user@host:port
// - host:port
// If endpoint is already a full command (`ssh ...`) we intentionally return null so
// command builders can preserve it as-is.
function parseSshEndpoint(endpoint: string | undefined): ParsedSshEndpoint | null {
  if (endpoint === undefined || endpoint.trim().length === 0) {
    return null;
  }

  if (endpoint.startsWith("ssh://")) {
    try {
      const parsed = new URL(endpoint);
      const host = parsed.hostname;

      if (host.length === 0) {
        return null;
      }

      return {
        user: parsed.username.length > 0 ? parsed.username : "root",
        host: normalizeSshHost(host),
        ...(parsed.port.length === 0 ? {} : { port: parsed.port }),
      };
    } catch {
      return null;
    }
  }

  if (endpoint.startsWith("ssh ")) {
    return null;
  }

  const raw = endpoint.trim();
  const atIndex = raw.lastIndexOf("@");
  const user = atIndex >= 0 ? raw.slice(0, atIndex) : "root";
  const hostPort = atIndex >= 0 ? raw.slice(atIndex + 1) : raw;

  if (hostPort.length === 0) {
    return null;
  }

  const bracketedMatch = /^\[(?<host>[^\]]+)\](?::(?<port>\d+))?$/.exec(hostPort);
  if (bracketedMatch?.groups?.host !== undefined) {
    return {
      user,
      host: normalizeSshHost(bracketedMatch.groups.host),
      ...(bracketedMatch.groups.port === undefined ? {} : { port: bracketedMatch.groups.port }),
    };
  }

  const hostPortMatch = /^(?<host>[^:]+)(?::(?<port>\d+))?$/.exec(hostPort);
  if (hostPortMatch?.groups?.host === undefined) {
    return null;
  }

  return {
    user,
    host: normalizeSshHost(hostPortMatch.groups.host),
    ...(hostPortMatch.groups.port === undefined ? {} : { port: hostPortMatch.groups.port }),
  };
}

function normalizeVsCodePath(value: string | undefined): string {
  const fallback = "/workspace/repo";
  const raw = (value ?? fallback).trim();
  const normalized = raw.length === 0 ? fallback : raw;
  const withLeadingSlash = normalized.startsWith("/") ? normalized : `/${normalized}`;
  const segments = withLeadingSlash.split("/").filter((segment) => segment.length > 0);

  if (segments.length === 0) {
    return "/";
  }

  return `/${segments.map((segment) => encodeURIComponent(segment)).join("/")}`;
}

function buildVsCodeOpenUri(input: {
  endpoint: string | undefined;
  workspaceId: string | undefined;
  workingDirectory: string | undefined;
}): string | null {
  const authority = buildEditorSshAuthorityFromEndpoint({
    endpoint: input.endpoint,
    workspaceId: input.workspaceId,
  });

  if (authority === null) {
    return null;
  }

  const encodedAuthority = encodeURIComponent(authority);
  const path = normalizeVsCodePath(input.workingDirectory);

  return `vscode://vscode-remote/ssh-remote+${encodedAuthority}${path}`;
}

function buildCursorOpenUri(input: {
  endpoint: string | undefined;
  workspaceId: string | undefined;
  workingDirectory: string | undefined;
}): string | null {
  const authority = buildEditorSshAuthorityFromEndpoint({
    endpoint: input.endpoint,
    workspaceId: input.workspaceId,
  });

  if (authority === null) {
    return null;
  }

  const encodedAuthority = encodeURIComponent(authority);
  const path = normalizeVsCodePath(input.workingDirectory);

  return `cursor://vscode-remote/ssh-remote+${encodedAuthority}${path}`;
}

function buildSshCommand(endpoint: string | undefined): string | null {
  const parsed = parseSshEndpoint(endpoint);
  if (parsed !== null) {
    // The gateway authenticates the key the user's SSH client offers (registered via the web
    // app), so no identity flags are needed — a plain ssh command works out of the box.
    if (parsed.port !== undefined) {
      return `ssh ${parsed.user}@${parsed.host} -p ${parsed.port}`;
    }

    return `ssh ${parsed.user}@${parsed.host}`;
  }

  if (endpoint === undefined || endpoint.length === 0) {
    return null;
  }

  if (endpoint.startsWith("ssh ")) {
    return endpoint;
  }

  return `ssh ${endpoint}`;
}

interface WorkspaceSpecDetails {
  readonly repositoryUrl: string;
  readonly branch: string;
  readonly isGitHubSource: boolean;
  readonly provider: string;
  readonly configRepo: string;
  readonly harness: string;
  readonly runtimeTarget: string;
  readonly ociRuntime: string;
  readonly osTarget: string;
  readonly workingDirectory: string;
  readonly ssh: string;
  readonly selectedPackages: readonly string[];
}

function resolveWorkspaceSpecDetails(workspace: WorkspaceSummary): WorkspaceSpecDetails | null {
  const workspaceSource = resolveWorkspaceSourceReference(workspace.spec);
  const isGitHubSource = resolveIsGitHubSource(workspaceSource);
  const selectedPackages =
    workspace.spec === undefined ? [] : resolveSelectedPackages(workspace.spec);
  const configRepo = resolveConfigRepoReference({
    spec: workspace.spec,
  });

  const spec = workspace.spec;

  if (spec === undefined) {
    return null;
  }

  const source = workspaceSource;
  const harness = spec.harness.id;
  const osTarget = resolveOsTarget(spec);
  const runtimeTarget = resolveRuntimeTarget(spec);
  const ociRuntime = resolveOciRuntime(spec);
  const workingDirectory = spec.runtime.workingDirectory;
  const ssh = resolveSshState({ spec });

  if (source === undefined) {
    return {
      repositoryUrl: "unknown",
      branch: "not specified",
      isGitHubSource,
      provider: "unknown",
      configRepo,
      harness,
      runtimeTarget,
      ociRuntime,
      osTarget,
      workingDirectory,
      ssh,
      selectedPackages,
    };
  }

  return {
    repositoryUrl: source.url,
    branch: source.ref,
    isGitHubSource,
    provider: source.provider,
    configRepo,
    harness,
    runtimeTarget,
    ociRuntime,
    osTarget,
    workingDirectory,
    ssh,
    selectedPackages,
  };
}

function resolveConfigRepoReference(input: { spec: NewWorkspace | undefined }): string {
  const sourceInputs = input.spec?.sources.inputs ?? ([] as NewWorkspace["sources"]["inputs"]);
  const dotfilesSource = sourceInputs.find((source) => source.purpose === "dotfiles");

  if (dotfilesSource === undefined) {
    return "none";
  }

  return `${dotfilesSource.url} @ ${dotfilesSource.ref ?? "main"}`;
}

function resolveWorkspaceSourceReference(
  spec: NewWorkspace | undefined,
): NewWorkspace["sources"]["workspace"] | undefined {
  return spec?.sources.workspace;
}

function resolveIsGitHubSource(source: NewWorkspace["sources"]["workspace"] | undefined): boolean {
  return (
    source !== undefined &&
    typeof source.authRef === "string" &&
    source.authRef.startsWith("github-installation-repository:")
  );
}

function resolveSelectedPackages(spec: NewWorkspace): readonly string[] {
  const packages = spec.tooling.packages;
  const selectedPackages = new Set<string>();

  for (const pkg of packages) {
    const packageId = pkg.id.trim();

    if (packageId.length === 0) {
      continue;
    }

    if (pkg.version === undefined) {
      selectedPackages.add(packageId);
      continue;
    }

    const packageVersion = pkg.version.trim();
    selectedPackages.add(
      packageVersion.length === 0 ? packageId : `${packageId}@${packageVersion}`,
    );
  }

  return [...selectedPackages];
}

function resolveOsTarget(spec: NewWorkspace): string {
  return spec.target.os.family;
}

function resolveRuntimeTarget(spec: NewWorkspace): string {
  return spec.target.runtime.family;
}

function resolveOciRuntime(spec: NewWorkspace): string {
  return spec.runtime.ociRuntime;
}

function resolveSshState(input: { spec?: NewWorkspace | undefined }): string {
  const ssh = input.spec?.access.ssh;

  if (ssh === undefined) {
    return "disabled";
  }

  const enabled = ssh.enabled;

  if (!enabled) {
    return "disabled";
  }

  return `enabled (port ${ssh.listenPort})`;
}

function suggestWorkspaceNames(workspace: {
  readonly workspaceId: string;
  readonly repository?: string | undefined;
  readonly tag?: string | undefined;
  readonly spec?: NewWorkspace;
}): readonly string[] {
  const repository = workspace.repository?.trim() ?? "";
  const repositoryTail =
    repository
      .split("/")
      .filter((segment) => segment.length > 0)
      .pop() ?? "";
  const repositoryLabel = toTitleWords(repositoryTail);
  const tagLabel = toTitleWords(workspace.tag?.trim() ?? "");
  const sourceRef = resolveSourceRef(workspace.spec);
  const refLabel = sourceRef === undefined ? "" : toTitleWords(sourceRef);

  const suggestions = [
    [repositoryLabel, tagLabel, refLabel].filter((value) => value.length > 0).join(" "),
    [repositoryLabel, tagLabel].filter((value) => value.length > 0).join(" "),
    [repositoryLabel, `Workspace ${workspace.workspaceId.slice(0, 8)}`]
      .filter((value) => value.length > 0)
      .join(" "),
  ]
    .map((value) => value.trim().replace(/\s+/g, " "))
    .filter((value) => value.length > 0);

  return [...new Set(suggestions)].slice(0, 3);
}

function resolveSourceRef(spec: NewWorkspace | undefined): string | undefined {
  if (spec === undefined) {
    return undefined;
  }

  const ref = spec.sources.workspace.ref.trim();

  if (ref.length === 0) {
    return undefined;
  }

  return ref;
}

function toTitleWords(value: string): string {
  return value
    .split(/[\s._-]+/)
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function resolveMutationErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return "Unable to update workspace name.";
}
