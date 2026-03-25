import {
  workspaceBuildJobRequestPayloadSchema,
  type WorkspaceBuildJobRequestPayload,
} from "@sealant/db/payloads";
import { Badge, Button } from "@sealant/ui";
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
  type QueryClient,
} from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useRef, useState, type ReactNode } from "react";

import type { AppTrpc } from "@/lib/trpc/client";
import { useTRPC } from "@/lib/trpc/react";

type SandboxStatus = "queued" | "running" | "ready" | "failed" | "cancelled";

interface SandboxSummary {
  readonly sandboxId: string;
  readonly name: string;
  readonly status: SandboxStatus;
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
  readonly spec?: WorkspaceBuildJobRequestPayload;
  readonly blueprint?: {
    readonly sources: {
      readonly workspace: {
        readonly provider: string;
        readonly url: string;
        readonly ref: string;
      };
    };
    readonly harness: {
      readonly id: string;
    };
    readonly access: {
      readonly ssh: {
        readonly enabled: boolean;
        readonly listenPort: number;
      };
    };
    readonly runtime: {
      readonly workingDirectory: string;
      readonly ociRuntime: string;
    };
    readonly target: {
      readonly os: {
        readonly family: string;
      };
      readonly runtime: {
        readonly family: string;
      };
    };
  };
}

interface SandboxAttemptSummary {
  readonly attemptId: string;
  readonly relation: string;
  readonly triggerType: string;
  readonly status: SandboxStatus;
  readonly createdAt: string;
}

interface SandboxEvent {
  readonly eventId: string;
  readonly type: string;
  readonly occurredAt: string;
  readonly message?: string | undefined;
}

interface SandboxSummaryLoaderData {
  readonly attempts: readonly SandboxAttemptSummary[];
  readonly events: readonly SandboxEvent[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toSandboxSummary(input: {
  readonly sandboxId: string;
  readonly name: string;
  readonly status: SandboxStatus;
  readonly registryId?: string | undefined;
  readonly repository?: string | undefined;
  readonly tag?: string | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly runtime?: unknown;
  readonly publishedImage?: unknown;
  readonly spec?: unknown;
  readonly blueprint?: unknown;
}): SandboxSummary {
  const parsedSpec = workspaceBuildJobRequestPayloadSchema.safeParse(input.spec);

  return {
    sandboxId: input.sandboxId,
    name: input.name,
    status: input.status,
    ...(input.registryId === undefined ? {} : { registryId: input.registryId }),
    ...(input.repository === undefined ? {} : { repository: input.repository }),
    ...(input.tag === undefined ? {} : { tag: input.tag }),
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    ...(isRecord(input.runtime) &&
    typeof input.runtime.adapter === "string" &&
    typeof input.runtime.resourceId === "string" &&
    typeof input.runtime.status === "string"
      ? {
          runtime: {
            adapter: input.runtime.adapter,
            resourceId: input.runtime.resourceId,
            status: input.runtime.status,
            ...(typeof input.runtime.endpoint === "string"
              ? { endpoint: input.runtime.endpoint }
              : {}),
          },
        }
      : {}),
    ...(isRecord(input.publishedImage) &&
    typeof input.publishedImage.reference === "string" &&
    typeof input.publishedImage.digestReference === "string"
      ? {
          publishedImage: {
            reference: input.publishedImage.reference,
            digestReference: input.publishedImage.digestReference,
          },
        }
      : {}),
    ...(parsedSpec.success ? { spec: parsedSpec.data } : {}),
    ...(isRecord(input.blueprint) &&
    isRecord(input.blueprint.sources) &&
    isRecord(input.blueprint.sources.workspace) &&
    typeof input.blueprint.sources.workspace.provider === "string" &&
    typeof input.blueprint.sources.workspace.url === "string" &&
    typeof input.blueprint.sources.workspace.ref === "string" &&
    isRecord(input.blueprint.harness) &&
    typeof input.blueprint.harness.id === "string" &&
    isRecord(input.blueprint.access) &&
    isRecord(input.blueprint.access.ssh) &&
    typeof input.blueprint.access.ssh.enabled === "boolean" &&
    typeof input.blueprint.access.ssh.listenPort === "number" &&
    isRecord(input.blueprint.runtime) &&
    typeof input.blueprint.runtime.workingDirectory === "string" &&
    typeof input.blueprint.runtime.ociRuntime === "string" &&
    isRecord(input.blueprint.target) &&
    isRecord(input.blueprint.target.os) &&
    typeof input.blueprint.target.os.family === "string" &&
    isRecord(input.blueprint.target.runtime) &&
    typeof input.blueprint.target.runtime.family === "string"
      ? {
          blueprint: {
            sources: {
              workspace: {
                provider: input.blueprint.sources.workspace.provider,
                url: input.blueprint.sources.workspace.url,
                ref: input.blueprint.sources.workspace.ref,
              },
            },
            harness: {
              id: input.blueprint.harness.id,
            },
            access: {
              ssh: {
                enabled: input.blueprint.access.ssh.enabled,
                listenPort: input.blueprint.access.ssh.listenPort,
              },
            },
            runtime: {
              workingDirectory: input.blueprint.runtime.workingDirectory,
              ociRuntime: input.blueprint.runtime.ociRuntime,
            },
            target: {
              os: {
                family: input.blueprint.target.os.family,
              },
              runtime: {
                family: input.blueprint.target.runtime.family,
              },
            },
          },
        }
      : {}),
  };
}

export const Route = createFileRoute("/_authenticated/sandboxes/$sandboxId/" as never)({
  loader: async ({
    context,
    params,
  }: {
    context: { queryClient: QueryClient; trpc: AppTrpc };
    params: { sandboxId: string };
  }) => {
    await context.queryClient.ensureQueryData(
      context.trpc.sandbox.byId.queryOptions({ sandboxId: params.sandboxId }),
    );
    const attemptsResponse = await context.queryClient.ensureQueryData(
      context.trpc.sandbox.attempts.queryOptions({ sandboxId: params.sandboxId, limit: 5 }),
    );
    const eventsResponse = await context.queryClient.ensureQueryData(
      context.trpc.sandbox.events.queryOptions({ sandboxId: params.sandboxId, limit: 8 }),
    );

    return {
      attempts: attemptsResponse.items,
      events: eventsResponse.items,
    };
  },
  component: SandboxSummaryPage,
});

function SandboxSummaryPage() {
  const { sandboxId } = Route.useParams();
  const { attempts, events } = Route.useLoaderData() as SandboxSummaryLoaderData;
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const sandboxQueryOptions = trpc.sandbox.byId.queryOptions({ sandboxId });
  const { data: sandboxResponse } = useSuspenseQuery(sandboxQueryOptions);
  const sandbox = toSandboxSummary(sandboxResponse);
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const [sshCopyState, setSshCopyState] = useState<"idle" | "copied" | "error">("idle");
  const [nameMutationError, setNameMutationError] = useState<string | null>(null);
  const [rerunMutationError, setRerunMutationError] = useState<string | null>(null);
  const sshCommand = buildSshCommand(sandbox.runtime?.endpoint);
  const workspaceSpecDetails = resolveWorkspaceSpecDetails(sandbox);
  const nameSuggestions = suggestSandboxNames(sandbox);
  const canRerunSandbox =
    sandbox.registryId !== undefined &&
    sandbox.repository !== undefined &&
    sandbox.tag !== undefined &&
    sandbox.spec !== undefined;

  const renameSandboxMutation = useMutation(
    trpc.sandbox.rename.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: sandboxQueryOptions.queryKey });
      },
    }),
  );
  const rerunSandboxMutation = useMutation(trpc.sandbox.create.mutationOptions());

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

  const saveSandboxName = async () => {
    const name = nameInputRef.current?.value.trim() ?? "";

    if (name.length === 0) {
      setNameMutationError("Sandbox name cannot be empty.");
      return;
    }

    setNameMutationError(null);

    try {
      await renameSandboxMutation.mutateAsync({
        sandboxId: sandbox.sandboxId,
        name,
      });
    } catch (error) {
      setNameMutationError(resolveMutationErrorMessage(error));
    }
  };

  const rerunSandbox = async () => {
    if (!canRerunSandbox) {
      setRerunMutationError(
        "Sandbox rerun is unavailable until source image metadata and spec are ready.",
      );
      return;
    }

    setRerunMutationError(null);

    try {
      const nextSandbox = await rerunSandboxMutation.mutateAsync({
        registryId: sandbox.registryId,
        repository: sandbox.repository,
        tag: sandbox.tag,
        name: sandbox.name,
        spec: sandbox.spec,
      });

      window.location.assign(`/sandboxes/${encodeURIComponent(nextSandbox.sandboxId)}`);
    } catch (error) {
      setRerunMutationError(resolveMutationErrorMessage(error));
    }
  };

  return (
    <section className="overflow-hidden border border-border bg-card">
      <div className="h-1 w-full bg-primary" />

      <div className="grid gap-0 border-b border-border lg:grid-cols-[1fr_auto]">
        <div className="px-6 py-6 sm:px-8">
          <p className="font-mono text-[0.62rem] tracking-[0.16em] text-primary">
            Operational Log // Sandbox Detail
          </p>
          <h1 className="mt-4 max-w-4xl font-display text-6xl leading-[0.86] tracking-[0.02em] text-foreground sm:text-7xl">
            {sandbox.name}
          </h1>
          <p className="mt-4 font-mono text-[0.72rem] text-muted-foreground">
            Sandbox ID: {sandbox.sandboxId}
          </p>
          <p className="mt-2 font-mono text-[0.72rem] text-muted-foreground">
            {(sandbox.repository ?? "unknown-repository") + " / " + (sandbox.tag ?? "unknown-tag")}
          </p>

          <div className="mt-5 border border-border px-4 py-4">
            <p className="font-mono text-[0.62rem] tracking-[0.12em] text-muted-foreground">Name</p>
            <div className="mt-3 flex flex-col gap-3">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                <input
                  key={`${sandbox.sandboxId}:${sandbox.name}`}
                  ref={nameInputRef}
                  defaultValue={sandbox.name}
                  className="h-10 w-full border border-border bg-background px-3 text-sm text-foreground focus:border-foreground focus:outline-none"
                />
                <Button
                  type="button"
                  variant="outline"
                  className="h-10 shrink-0 px-4 text-[0.64rem] tracking-[0.1em]"
                  onClick={() => {
                    void saveSandboxName();
                  }}
                  disabled={renameSandboxMutation.isPending}
                >
                  {renameSandboxMutation.isPending ? "Saving" : "Save Name"}
                </Button>
              </div>
              <div className="flex flex-wrap gap-2">
                {nameSuggestions.map((suggestion) => (
                  <Button
                    key={suggestion}
                    type="button"
                    variant="outline"
                    className="h-8 px-3 text-[0.58rem] tracking-[0.1em]"
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
                <p className="font-mono text-[0.62rem] tracking-[0.11em] text-destructive">
                  {nameMutationError}
                </p>
              )}
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-3 border-t border-border p-6 sm:flex-row sm:border-l sm:border-t-0 sm:p-8 lg:flex-col">
          <Button className="h-11 px-5">Open Sandbox</Button>
          <Button
            variant="outline"
            className="h-11 px-5"
            onClick={() => {
              void rerunSandbox();
            }}
            disabled={rerunSandboxMutation.isPending || !canRerunSandbox}
          >
            {rerunSandboxMutation.isPending ? "Rerunning" : "Rerun Sandbox"}
          </Button>
          <Button variant="outline" className="h-11 px-5">
            View Spec
          </Button>
          {rerunMutationError === null ? null : (
            <p className="font-mono text-[0.62rem] tracking-[0.11em] text-destructive">
              {rerunMutationError}
            </p>
          )}
        </div>
      </div>

      <div className="grid gap-px border-b border-border bg-border sm:grid-cols-2 xl:grid-cols-4">
        <MetricCell
          label="Status"
          value={<Badge className={statusBadgeClassName(sandbox.status)}>{sandbox.status}</Badge>}
        />
        <MetricCell
          label="Attempts"
          value={<p className="mt-2 text-2xl font-semibold text-foreground">{attempts.length}</p>}
        />
        <MetricCell
          label="Created"
          value={
            <p className="mt-2 text-2xl font-semibold text-foreground">
              {toShortDateTime(sandbox.createdAt)}
            </p>
          }
        />
        <MetricCell
          label="Updated"
          value={
            <p className="mt-2 text-2xl font-semibold text-foreground">
              {toShortDateTime(sandbox.updatedAt)}
            </p>
          }
        />
      </div>

      <div className="grid gap-px border-border xl:grid-cols-[1.35fr_1fr]">
        <div className="border-r border-border">
          <section className="border-b border-border px-6 py-6 sm:px-8">
            <p className="font-mono text-[0.62rem] tracking-[0.16em] text-primary">
              01 // Attempt History
            </p>
            <h2 className="mt-4 font-display text-4xl text-foreground sm:text-5xl">
              Execution attempts
            </h2>
            <div className="mt-6 border border-border">
              {attempts.length === 0 ? (
                <p className="px-4 py-6 font-mono text-[0.68rem] tracking-[0.12em] text-muted-foreground">
                  No attempts recorded.
                </p>
              ) : (
                attempts.map((attempt) => (
                  <div
                    key={attempt.attemptId}
                    className="grid gap-2 border-b border-border px-4 py-3 last:border-b-0 sm:grid-cols-[1fr_auto_auto] sm:items-center"
                  >
                    <div>
                      <p className="font-mono text-[0.64rem] tracking-[0.12em] text-muted-foreground">
                        {attempt.attemptId}
                      </p>
                      <p className="mt-1 text-sm text-foreground">
                        {attempt.relation} via {attempt.triggerType}
                      </p>
                    </div>
                    <p className="font-mono text-[0.62rem] tracking-[0.13em] text-muted-foreground">
                      {toShortDateTime(attempt.createdAt)}
                    </p>
                    <Badge className={statusBadgeClassName(attempt.status)}>{attempt.status}</Badge>
                  </div>
                ))
              )}
            </div>
          </section>

          <section className="px-6 py-6 sm:px-8">
            <p className="font-mono text-[0.62rem] tracking-[0.16em] text-primary">02 // Runtime</p>
            <div className="mt-5 grid gap-px border border-border bg-border sm:grid-cols-2">
              <RuntimeCell label="Adapter" value={sandbox.runtime?.adapter ?? "n/a"} />
              <RuntimeCell label="Runtime status" value={sandbox.runtime?.status ?? "n/a"} />
              <RuntimeCell label="Resource" value={sandbox.runtime?.resourceId ?? "n/a"} />
              <RuntimeCell label="Endpoint" value={sandbox.runtime?.endpoint ?? "n/a"} />
            </div>

            {sshCommand === null ? null : (
              <div className="mt-5 border border-border px-4 py-4">
                <p className="font-mono text-[0.62rem] tracking-[0.12em] text-muted-foreground">
                  SSH access
                </p>
                <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <code className="break-all font-mono text-[0.68rem] text-foreground">
                    {sshCommand}
                  </code>
                  <Button
                    type="button"
                    variant="outline"
                    className="h-10 shrink-0 px-4 text-[0.64rem] tracking-[0.1em]"
                    onClick={() => {
                      void copySshCommand();
                    }}
                  >
                    {sshCopyState === "copied"
                      ? "Copied"
                      : sshCopyState === "error"
                        ? "Copy failed"
                        : "Copy SSH Command"}
                  </Button>
                </div>
              </div>
            )}
          </section>

          <section className="border-t border-border px-6 py-6 sm:px-8">
            <p className="font-mono text-[0.62rem] tracking-[0.16em] text-primary">
              03 // Workspace Spec
            </p>
            {workspaceSpecDetails === null ? (
              <p className="mt-5 border border-border px-4 py-4 font-mono text-[0.68rem] tracking-[0.12em] text-muted-foreground">
                Spec details are not available for this sandbox.
              </p>
            ) : (
              <>
                <div className="mt-5 grid gap-px border border-border bg-border sm:grid-cols-2">
                  <RuntimeCell
                    label="Repository"
                    value={
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="break-all">{workspaceSpecDetails.repositoryUrl}</span>
                        {workspaceSpecDetails.isGitHubSource ? (
                          <Badge className="rounded-none border border-border bg-card font-mono text-[0.56rem] tracking-[0.11em] text-foreground">
                            GITHUB
                          </Badge>
                        ) : null}
                      </span>
                    }
                  />
                  <RuntimeCell label="Branch" value={workspaceSpecDetails.branch} />
                  <RuntimeCell label="Provider" value={workspaceSpecDetails.provider} />
                  <RuntimeCell label="Harness" value={workspaceSpecDetails.harness} />
                  <RuntimeCell label="Runtime target" value={workspaceSpecDetails.runtimeTarget} />
                  <RuntimeCell label="OCI runtime" value={workspaceSpecDetails.ociRuntime} />
                  <RuntimeCell label="OS target" value={workspaceSpecDetails.osTarget} />
                  <RuntimeCell
                    label="Working directory"
                    value={workspaceSpecDetails.workingDirectory}
                  />
                  <RuntimeCell label="SSH" value={workspaceSpecDetails.ssh} />
                </div>

                <div className="mt-5 border border-border px-4 py-4">
                  <p className="font-mono text-[0.62rem] tracking-[0.12em] text-muted-foreground">
                    Selected packages
                  </p>
                  {workspaceSpecDetails.selectedPackages.length === 0 ? (
                    <p className="mt-2 text-sm text-muted-foreground">
                      No packages selected during sandbox creation.
                    </p>
                  ) : (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {workspaceSpecDetails.selectedPackages.map((pkg) => (
                        <span
                          key={pkg}
                          className="inline-flex h-8 items-center border border-border bg-card px-2.5 font-mono text-[0.62rem] tracking-[0.1em] text-foreground"
                        >
                          {pkg}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}
          </section>
        </div>

        <div>
          <section className="border-b border-border px-6 py-6 sm:px-8">
            <p className="font-mono text-[0.62rem] tracking-[0.16em] text-primary">Recent events</p>
            <div className="mt-5 border border-border">
              {events.length === 0 ? (
                <p className="px-4 py-6 font-mono text-[0.68rem] tracking-[0.12em] text-muted-foreground">
                  No events recorded.
                </p>
              ) : (
                events.map((event) => (
                  <div
                    key={event.eventId}
                    className="border-b border-border px-4 py-3 last:border-b-0"
                  >
                    <p className="font-mono text-[0.62rem] tracking-[0.13em] text-muted-foreground">
                      {toShortDateTime(event.occurredAt)}
                    </p>
                    <p className="mt-1 text-sm font-semibold text-foreground">{event.type}</p>
                    <p className="mt-1 text-sm text-foreground/80">
                      {event.message ?? "No event message."}
                    </p>
                  </div>
                ))
              )}
            </div>
          </section>

          <section className="px-6 py-6 sm:px-8">
            <p className="font-mono text-[0.62rem] tracking-[0.16em] text-muted-foreground">
              Image output
            </p>
            <div className="mt-5 border border-border px-4 py-4">
              <p className="font-mono text-[0.62rem] tracking-[0.12em] text-muted-foreground">
                Reference
              </p>
              <p className="mt-2 break-all text-sm text-foreground">
                {sandbox.publishedImage?.reference ?? "No image published"}
              </p>
              <p className="mt-4 font-mono text-[0.62rem] tracking-[0.12em] text-muted-foreground">
                Digest
              </p>
              <p className="mt-2 break-all font-mono text-[0.68rem] text-foreground/90">
                {sandbox.publishedImage?.digestReference ?? "n/a"}
              </p>
            </div>
          </section>
        </div>
      </div>
    </section>
  );
}

function MetricCell({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="bg-card px-4 py-4">
      <p className="font-mono text-[0.62rem] tracking-[0.13em] text-muted-foreground">{label}</p>
      {value}
    </div>
  );
}

function RuntimeCell({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="bg-card px-4 py-4">
      <p className="font-mono text-[0.62rem] tracking-[0.13em] text-muted-foreground">{label}</p>
      <p className="mt-2 text-sm text-foreground">{value}</p>
    </div>
  );
}

function statusBadgeClassName(status: string): string {
  if (status === "running") {
    return "mt-2 rounded-none bg-primary text-primary-foreground font-mono text-[0.58rem] tracking-[0.11em]";
  }

  if (status === "failed") {
    return "mt-2 rounded-none border border-border bg-muted text-foreground font-mono text-[0.58rem] tracking-[0.11em]";
  }

  return "mt-2 rounded-none border border-border bg-card text-muted-foreground font-mono text-[0.58rem] tracking-[0.11em]";
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

function buildSshCommand(endpoint: string | undefined): string | null {
  if (endpoint === undefined || endpoint.length === 0) {
    return null;
  }

  if (endpoint.startsWith("ssh://")) {
    try {
      const parsed = new URL(endpoint);
      const user = parsed.username.length > 0 ? parsed.username : "root";
      const host = parsed.hostname;

      if (host.length === 0) {
        return null;
      }

      if (parsed.port.length > 0) {
        return `ssh ${user}@${host} -p ${parsed.port}`;
      }

      return `ssh ${user}@${host}`;
    } catch {
      return null;
    }
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
  readonly harness: string;
  readonly runtimeTarget: string;
  readonly ociRuntime: string;
  readonly osTarget: string;
  readonly workingDirectory: string;
  readonly ssh: string;
  readonly selectedPackages: readonly string[];
}

function resolveWorkspaceSpecDetails(sandbox: SandboxSummary): WorkspaceSpecDetails | null {
  const workspaceSource = resolveWorkspaceSourceReference(sandbox.spec);
  const isGitHubSource = resolveIsGitHubSource(workspaceSource);
  const selectedPackages = sandbox.spec === undefined ? [] : resolveSelectedPackages(sandbox.spec);

  if (sandbox.blueprint !== undefined) {
    const ssh = resolveSshState({
      spec: sandbox.spec,
      blueprintSsh: sandbox.blueprint.access.ssh,
    });

    return {
      repositoryUrl: sandbox.blueprint.sources.workspace.url,
      branch: sandbox.blueprint.sources.workspace.ref,
      isGitHubSource,
      provider: sandbox.blueprint.sources.workspace.provider,
      harness: sandbox.blueprint.harness.id,
      runtimeTarget: sandbox.blueprint.target.runtime.family,
      ociRuntime: sandbox.blueprint.runtime.ociRuntime,
      osTarget: sandbox.blueprint.target.os.family,
      workingDirectory: sandbox.blueprint.runtime.workingDirectory,
      ssh,
      selectedPackages,
    };
  }

  const spec = sandbox.spec;

  if (spec === undefined) {
    return null;
  }

  const source = workspaceSource;
  const harness = typeof spec.harness === "string" ? spec.harness : spec.harness.id;
  const osTarget = resolveOsTarget(spec);
  const runtimeTarget = resolveRuntimeTarget(spec);
  const ociRuntime = resolveOciRuntime(spec);
  const workingDirectory = spec.runtime?.workingDirectory ?? "n/a";
  const ssh = resolveSshState({ spec });

  if (source === undefined) {
    return {
      repositoryUrl: "unknown",
      branch: "not specified",
      isGitHubSource,
      provider: "unknown",
      harness,
      runtimeTarget,
      ociRuntime,
      osTarget,
      workingDirectory,
      ssh,
      selectedPackages,
    };
  }

  if (typeof source === "string") {
    return {
      repositoryUrl: source,
      branch: "not specified",
      isGitHubSource,
      provider: inferSourceProvider(source),
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
    branch: source.ref ?? "not specified",
    isGitHubSource,
    provider: source.provider ?? inferSourceProvider(source.url),
    harness,
    runtimeTarget,
    ociRuntime,
    osTarget,
    workingDirectory,
    ssh,
    selectedPackages,
  };
}

function resolveWorkspaceSourceReference(
  spec: WorkspaceBuildJobRequestPayload | undefined,
): WorkspaceBuildJobRequestPayload["source"] | WorkspaceBuildJobRequestPayload["repo"] | undefined {
  return spec?.sources?.workspace ?? spec?.source ?? spec?.repo;
}

function resolveIsGitHubSource(
  source:
    | WorkspaceBuildJobRequestPayload["source"]
    | WorkspaceBuildJobRequestPayload["repo"]
    | undefined,
): boolean {
  return (
    source !== undefined &&
    typeof source !== "string" &&
    typeof source.authRef === "string" &&
    source.authRef.startsWith("github-installation-repository:")
  );
}

function resolveSelectedPackages(spec: WorkspaceBuildJobRequestPayload): readonly string[] {
  const packages = spec.tooling?.packages ?? spec.packages ?? [];
  const selectedPackages = new Set<string>();

  for (const pkg of packages) {
    if (typeof pkg === "string") {
      const packageId = pkg.trim();

      if (packageId.length > 0) {
        selectedPackages.add(packageId);
      }

      continue;
    }

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

function resolveOsTarget(spec: WorkspaceBuildJobRequestPayload): string {
  const osTarget = spec.target?.os ?? spec.os;

  if (osTarget === undefined) {
    return "n/a";
  }

  if (typeof osTarget === "string") {
    return osTarget;
  }

  return osTarget.family ?? "n/a";
}

function resolveRuntimeTarget(spec: WorkspaceBuildJobRequestPayload): string {
  const runtimeTarget = spec.target?.runtime;

  if (runtimeTarget === undefined) {
    return "n/a";
  }

  if (typeof runtimeTarget === "string") {
    return runtimeTarget;
  }

  return runtimeTarget.family ?? "n/a";
}

function resolveOciRuntime(spec: WorkspaceBuildJobRequestPayload): string {
  return spec.runtime?.ociRuntime ?? "runc";
}

function resolveSshState(input: {
  spec?: WorkspaceBuildJobRequestPayload | undefined;
  blueprintSsh?: { enabled: boolean; listenPort: number };
}): string {
  const ssh = input.spec?.access?.ssh ?? input.spec?.ssh;

  if (ssh === undefined) {
    if (input.blueprintSsh?.enabled === true) {
      return `enabled (port ${input.blueprintSsh.listenPort})`;
    }

    return "enabled (port 2222)";
  }

  if (typeof ssh === "boolean") {
    return ssh ? "enabled" : "disabled";
  }

  const enabled = ssh.enabled ?? true;

  if (!enabled) {
    return "disabled";
  }

  return `enabled (port ${ssh.listenPort ?? 2222})`;
}

function inferSourceProvider(url: string): string {
  try {
    const hostname = new URL(url).hostname.toLowerCase();

    if (hostname === "github.com" || hostname.endsWith(".github.com")) {
      return "github";
    }

    if (hostname === "gitlab.com" || hostname.endsWith(".gitlab.com")) {
      return "gitlab";
    }

    return "generic";
  } catch {
    return "unknown";
  }
}

function suggestSandboxNames(sandbox: {
  readonly sandboxId: string;
  readonly repository?: string | undefined;
  readonly tag?: string | undefined;
  readonly spec?: WorkspaceBuildJobRequestPayload;
}): readonly string[] {
  const repository = sandbox.repository?.trim() ?? "";
  const repositoryTail =
    repository
      .split("/")
      .filter((segment) => segment.length > 0)
      .pop() ?? "";
  const repositoryLabel = toTitleWords(repositoryTail);
  const tagLabel = toTitleWords(sandbox.tag?.trim() ?? "");
  const sourceRef = resolveSourceRef(sandbox.spec);
  const refLabel = sourceRef === undefined ? "" : toTitleWords(sourceRef);

  const suggestions = [
    [repositoryLabel, tagLabel, refLabel].filter((value) => value.length > 0).join(" "),
    [repositoryLabel, tagLabel].filter((value) => value.length > 0).join(" "),
    [repositoryLabel, `Sandbox ${sandbox.sandboxId.slice(0, 8)}`]
      .filter((value) => value.length > 0)
      .join(" "),
  ]
    .map((value) => value.trim().replace(/\s+/g, " "))
    .filter((value) => value.length > 0);

  return [...new Set(suggestions)].slice(0, 3);
}

function resolveSourceRef(spec: WorkspaceBuildJobRequestPayload | undefined): string | undefined {
  const source = spec?.sources?.workspace ?? spec?.source ?? spec?.repo;

  if (source === undefined || typeof source === "string") {
    return undefined;
  }

  const ref = source.ref?.trim();

  if (ref === undefined || ref.length === 0) {
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

  return "Unable to update sandbox name.";
}
