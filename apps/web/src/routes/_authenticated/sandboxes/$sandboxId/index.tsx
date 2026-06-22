import { Button } from "@sealant/ui";
import { type NewSandbox } from "@sealant/validators";
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
  readonly spec?: NewSandbox;
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

function toSandboxSummary(input: {
  readonly sandboxId: string;
  readonly name: string;
  readonly status: SandboxStatus;
  readonly registryId?: string | undefined;
  readonly repository?: string | undefined;
  readonly tag?: string | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly runtime?: SandboxSummary["runtime"] | undefined;
  readonly publishedImage?: SandboxSummary["publishedImage"] | undefined;
  readonly spec?: NewSandbox | undefined;
}): SandboxSummary {
  return {
    sandboxId: input.sandboxId,
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

export const Route = createFileRoute("/_authenticated/sandboxes/$sandboxId/")({
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
  const sandboxSpecDetails = resolveSandboxSpecDetails(sandbox);
  const vscodeOpenUri = buildVsCodeOpenUri({
    endpoint: sandbox.runtime?.endpoint,
    sandboxId: sandbox.sandboxId,
    workingDirectory: sandboxSpecDetails?.workingDirectory,
  });
  const cursorOpenUri = buildCursorOpenUri({
    endpoint: sandbox.runtime?.endpoint,
    sandboxId: sandbox.sandboxId,
    workingDirectory: sandboxSpecDetails?.workingDirectory,
  });
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

  const openSandboxInVsCode = () => {
    if (vscodeOpenUri === null || typeof window === "undefined") {
      return;
    }

    window.location.assign(vscodeOpenUri);
  };

  const openSandboxInCursor = () => {
    if (cursorOpenUri === null || typeof window === "undefined") {
      return;
    }

    window.location.assign(cursorOpenUri);
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
          <p className="ev-eyebrow">Sandbox detail</p>
          <h1 className="mt-4 max-w-4xl text-2xl text-foreground sm:text-3xl">{sandbox.name}</h1>
          <p className="mt-4 font-mono text-[0.72rem] text-muted-foreground">
            Sandbox ID: {sandbox.sandboxId}
          </p>
          <p className="mt-2 font-mono text-[0.72rem] text-muted-foreground">
            {(sandbox.repository ?? "unknown-repository") + " / " + (sandbox.tag ?? "unknown-tag")}
          </p>

          <div className="mt-5 rounded-md border border-border px-4 py-4">
            <p className="ev-eyebrow">Name</p>
            <div className="mt-3 flex flex-col gap-3">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                <input
                  key={`${sandbox.sandboxId}:${sandbox.name}`}
                  ref={nameInputRef}
                  defaultValue={sandbox.name}
                  className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground focus:border-primary focus:outline-none"
                />
                <Button
                  type="button"
                  variant="outline"
                  className="h-10 shrink-0 px-4"
                  onClick={() => {
                    void saveSandboxName();
                  }}
                  disabled={renameSandboxMutation.isPending}
                >
                  {renameSandboxMutation.isPending ? "Saving" : "Save name"}
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
                <p className="text-sm text-danger">{nameMutationError}</p>
              )}
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-3 border-t border-border p-6 sm:flex-row sm:border-l sm:border-t-0 sm:p-8 lg:flex-col">
          <Button
            className="h-11 px-5"
            onClick={() => {
              openSandboxInVsCode();
            }}
            disabled={vscodeOpenUri === null}
          >
            Open in VS Code
          </Button>
          <Button
            variant="outline"
            className="h-11 px-5"
            onClick={() => {
              openSandboxInCursor();
            }}
            disabled={cursorOpenUri === null}
          >
            Open in Cursor
          </Button>
          <Button
            variant="outline"
            className="h-11 px-5"
            onClick={() => {
              void rerunSandbox();
            }}
            disabled={rerunSandboxMutation.isPending || !canRerunSandbox}
          >
            {rerunSandboxMutation.isPending ? "Rerunning" : "Rerun sandbox"}
          </Button>
          <Button variant="outline" className="h-11 px-5">
            View spec
          </Button>
          {rerunMutationError === null ? null : (
            <p className="text-sm text-danger">{rerunMutationError}</p>
          )}
        </div>
      </div>

      <div className="grid gap-px border-b border-border bg-border sm:grid-cols-2 xl:grid-cols-4">
        <MetricCell label="Status" value={<StatusIndicator status={sandbox.status} />} />
        <MetricCell
          label="Attempts"
          value={<p className="mt-2 font-mono text-lg text-foreground">{attempts.length}</p>}
        />
        <MetricCell
          label="Created"
          value={
            <p className="mt-2 font-mono text-sm text-foreground">
              {toShortDateTime(sandbox.createdAt)}
            </p>
          }
        />
        <MetricCell
          label="Updated"
          value={
            <p className="mt-2 font-mono text-sm text-foreground">
              {toShortDateTime(sandbox.updatedAt)}
            </p>
          }
        />
      </div>

      <div className="grid gap-px border-border xl:grid-cols-[1.35fr_1fr]">
        <div className="border-r border-border">
          <section className="border-b border-border px-6 py-6 sm:px-8">
            <p className="ev-eyebrow">01 · Attempt history</p>
            <h2 className="mt-4 text-xl text-foreground">Execution attempts</h2>
            <div className="mt-6 rounded-md border border-border">
              {attempts.length === 0 ? (
                <p className="px-4 py-6 font-mono text-[0.68rem] text-muted-foreground">
                  No attempts recorded.
                </p>
              ) : (
                attempts.map((attempt) => (
                  <div
                    key={attempt.attemptId}
                    className="grid gap-2 border-b border-border px-4 py-3 last:border-b-0 sm:grid-cols-[1fr_auto_auto] sm:items-center"
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
                ))
              )}
            </div>
          </section>

          <section className="px-6 py-6 sm:px-8">
            <p className="ev-eyebrow">02 · Runtime</p>
            <div className="mt-5 grid gap-px border border-border bg-border sm:grid-cols-2">
              <RuntimeCell label="Adapter" value={sandbox.runtime?.adapter ?? "n/a"} />
              <RuntimeCell label="Runtime status" value={sandbox.runtime?.status ?? "n/a"} />
              <RuntimeCell label="Resource" value={sandbox.runtime?.resourceId ?? "n/a"} />
              <RuntimeCell label="Endpoint" value={sandbox.runtime?.endpoint ?? "n/a"} />
            </div>

            {sshCommand === null ? null : (
              <div className="mt-5 rounded-md border border-border px-4 py-4">
                <p className="ev-eyebrow">SSH access</p>
                <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <code className="break-all font-mono text-[0.68rem] text-foreground">
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
          </section>

          <section className="border-t border-border px-6 py-6 sm:px-8">
            <p className="ev-eyebrow">03 · Sandbox spec</p>
            {sandboxSpecDetails === null ? (
              <p className="mt-5 rounded-md border border-border px-4 py-4 font-mono text-[0.68rem] text-muted-foreground">
                Spec details are not available for this sandbox.
              </p>
            ) : (
              <>
                <div className="mt-5 grid gap-px border border-border bg-border sm:grid-cols-2">
                  <RuntimeCell
                    label="Repository"
                    value={
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="break-all">{sandboxSpecDetails.repositoryUrl}</span>
                        {sandboxSpecDetails.isGitHubSource ? (
                          <span className="ev-eyebrow">GitHub</span>
                        ) : null}
                      </span>
                    }
                  />
                  <RuntimeCell label="Branch" value={sandboxSpecDetails.branch} />
                  <RuntimeCell label="Provider" value={sandboxSpecDetails.provider} />
                  <RuntimeCell label="Config repo" value={sandboxSpecDetails.configRepo} />
                  <RuntimeCell label="Harness" value={sandboxSpecDetails.harness} />
                  <RuntimeCell label="Runtime target" value={sandboxSpecDetails.runtimeTarget} />
                  <RuntimeCell label="OCI runtime" value={sandboxSpecDetails.ociRuntime} />
                  <RuntimeCell label="OS target" value={sandboxSpecDetails.osTarget} />
                  <RuntimeCell
                    label="Working directory"
                    value={sandboxSpecDetails.workingDirectory}
                  />
                  <RuntimeCell label="SSH" value={sandboxSpecDetails.ssh} />
                </div>

                <div className="mt-5 rounded-md border border-border px-4 py-4">
                  <p className="ev-eyebrow">Selected packages</p>
                  {sandboxSpecDetails.selectedPackages.length === 0 ? (
                    <p className="mt-2 text-sm text-muted-foreground">
                      No packages selected during sandbox creation.
                    </p>
                  ) : (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {sandboxSpecDetails.selectedPackages.map((pkg) => (
                        <span
                          key={pkg}
                          className="inline-flex h-8 items-center rounded-md border border-input bg-card px-2.5 font-mono text-[0.66rem] text-foreground"
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
            <p className="ev-eyebrow">Recent events</p>
            <div className="mt-5 rounded-md border border-border">
              {events.length === 0 ? (
                <p className="px-4 py-6 font-mono text-[0.68rem] text-muted-foreground">
                  No events recorded.
                </p>
              ) : (
                events.map((event) => (
                  <div
                    key={event.eventId}
                    className="border-b border-border px-4 py-3 last:border-b-0"
                  >
                    <p className="font-mono text-[0.66rem] text-muted-foreground">
                      {toShortDateTime(event.occurredAt)}
                    </p>
                    <p className="mt-1 text-sm font-medium text-foreground">{event.type}</p>
                    <p className="mt-1 text-sm text-ink-2">
                      {event.message ?? "No event message."}
                    </p>
                  </div>
                ))
              )}
            </div>
          </section>

          <section className="px-6 py-6 sm:px-8">
            <p className="ev-eyebrow">Image output</p>
            <div className="mt-5 rounded-md border border-border px-4 py-4">
              <p className="ev-eyebrow">Reference</p>
              <p className="mt-2 break-all text-sm text-foreground">
                {sandbox.publishedImage?.reference ?? "No image published"}
              </p>
              <p className="mt-4 ev-eyebrow">Digest</p>
              <p className="mt-2 break-all font-mono text-[0.68rem] text-ink-2">
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
      <p className="ev-eyebrow">{label}</p>
      {value}
    </div>
  );
}

function RuntimeCell({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="bg-card px-4 py-4">
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

// Defaults are intentionally dev-friendly and match tooling/scripts/setup-ssh-gateway-dev.mjs.
const DEFAULT_SANDBOX_SSH_USERNAME_PREFIX = "sbx";
const DEFAULT_SANDBOX_SSH_IDENTITY_FILE = ".secrets/dev_client_key";

function quoteShellToken(value: string): string {
  if (/^[A-Za-z0-9_./-]+$/.test(value)) {
    return value;
  }

  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function resolveSandboxSshUsernamePrefixToken(): string {
  const configuredPrefix =
    typeof import.meta.env.VITE_SANDBOX_SSH_USERNAME_PREFIX === "string"
      ? import.meta.env.VITE_SANDBOX_SSH_USERNAME_PREFIX.trim()
      : "";
  const rawPrefix =
    configuredPrefix.length > 0 ? configuredPrefix : DEFAULT_SANDBOX_SSH_USERNAME_PREFIX;

  return rawPrefix.endsWith("-") ? rawPrefix : `${rawPrefix}-`;
}

function resolveSandboxSshIdentityFile(): string {
  const configuredIdentity =
    typeof import.meta.env.VITE_SANDBOX_SSH_IDENTITY_FILE === "string"
      ? import.meta.env.VITE_SANDBOX_SSH_IDENTITY_FILE.trim()
      : "";

  return configuredIdentity.length > 0 ? configuredIdentity : DEFAULT_SANDBOX_SSH_IDENTITY_FILE;
}

function shouldIncludeSandboxSshIdentityFlag(parsed: ParsedSshEndpoint): boolean {
  // Gateway-style usernames look like sbx-<sandboxId>. For those, we want command
  // snippets to include an explicit identity file so users can connect immediately.
  if (parsed.user.startsWith(resolveSandboxSshUsernamePrefixToken())) {
    return true;
  }

  return parsed.user !== "root";
}

function buildEditorSshAuthority(parsed: ParsedSshEndpoint): string {
  if (shouldIncludeSandboxSshIdentityFlag(parsed)) {
    // VS Code remote authority should use host alias only for gateway flow.
    // The actual host/port/identity are provided by SSH config.
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

function buildSandboxSshAlias(sandboxId: string): string {
  const prefixWithDash = resolveSandboxSshUsernamePrefixToken();

  return `${prefixWithDash}${sandboxId}`;
}

function shouldUseSandboxAliasForEditor(input: {
  parsed: ParsedSshEndpoint;
  sandboxId: string | undefined;
}): boolean {
  if (input.sandboxId === undefined) {
    return false;
  }

  if (shouldIncludeSandboxSshIdentityFlag(input.parsed)) {
    return true;
  }

  // Safety fallback: if API still returns an internal container address, prefer the
  // stable sbx-* alias so VS Code resolves via local SSH config instead of direct runtime IP.
  return input.parsed.user === "root" && isPrivateOrLocalSshHost(input.parsed.host);
}

function buildEditorSshAuthorityFromEndpoint(input: {
  endpoint: string | undefined;
  sandboxId: string | undefined;
}): string | null {
  const parsed = parseSshEndpoint(input.endpoint);
  if (parsed === null) {
    return null;
  }

  if (shouldUseSandboxAliasForEditor({ parsed, sandboxId: input.sandboxId })) {
    const sandboxId = input.sandboxId;

    if (sandboxId === undefined) {
      return buildEditorSshAuthority(parsed);
    }

    return buildSandboxSshAlias(sandboxId);
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
  const fallback = "/sandbox/repo";
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
  sandboxId: string | undefined;
  workingDirectory: string | undefined;
}): string | null {
  const authority = buildEditorSshAuthorityFromEndpoint({
    endpoint: input.endpoint,
    sandboxId: input.sandboxId,
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
  sandboxId: string | undefined;
  workingDirectory: string | undefined;
}): string | null {
  const authority = buildEditorSshAuthorityFromEndpoint({
    endpoint: input.endpoint,
    sandboxId: input.sandboxId,
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
    // Copy command behavior differs between direct runtime SSH and gateway SSH.
    // Gateway commands include an identity key to reduce setup friction.
    const identityFlags = shouldIncludeSandboxSshIdentityFlag(parsed)
      ? ` -i ${quoteShellToken(resolveSandboxSshIdentityFile())} -o IdentitiesOnly=yes`
      : "";

    if (parsed.port !== undefined) {
      return `ssh${identityFlags} ${parsed.user}@${parsed.host} -p ${parsed.port}`;
    }

    return `ssh${identityFlags} ${parsed.user}@${parsed.host}`;
  }

  if (endpoint === undefined || endpoint.length === 0) {
    return null;
  }

  if (endpoint.startsWith("ssh ")) {
    return endpoint;
  }

  return `ssh ${endpoint}`;
}

interface SandboxSpecDetails {
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

function resolveSandboxSpecDetails(sandbox: SandboxSummary): SandboxSpecDetails | null {
  const sandboxSource = resolveSandboxSourceReference(sandbox.spec);
  const isGitHubSource = resolveIsGitHubSource(sandboxSource);
  const selectedPackages = sandbox.spec === undefined ? [] : resolveSelectedPackages(sandbox.spec);
  const configRepo = resolveConfigRepoReference({
    spec: sandbox.spec,
  });

  const spec = sandbox.spec;

  if (spec === undefined) {
    return null;
  }

  const source = sandboxSource;
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

function resolveConfigRepoReference(input: { spec: NewSandbox | undefined }): string {
  const sourceInputs = input.spec?.sources.inputs ?? ([] as NewSandbox["sources"]["inputs"]);
  const dotfilesSource = sourceInputs.find((source) => source.purpose === "dotfiles");

  if (dotfilesSource === undefined) {
    return "none";
  }

  return `${dotfilesSource.url} @ ${dotfilesSource.ref ?? "main"}`;
}

function resolveSandboxSourceReference(
  spec: NewSandbox | undefined,
): NewSandbox["sources"]["sandbox"] | undefined {
  return spec?.sources.sandbox;
}

function resolveIsGitHubSource(source: NewSandbox["sources"]["sandbox"] | undefined): boolean {
  return (
    source !== undefined &&
    typeof source.authRef === "string" &&
    source.authRef.startsWith("github-installation-repository:")
  );
}

function resolveSelectedPackages(spec: NewSandbox): readonly string[] {
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

function resolveOsTarget(spec: NewSandbox): string {
  return spec.target.os.family;
}

function resolveRuntimeTarget(spec: NewSandbox): string {
  return spec.target.runtime.family;
}

function resolveOciRuntime(spec: NewSandbox): string {
  return spec.runtime.ociRuntime;
}

function resolveSshState(input: { spec?: NewSandbox | undefined }): string {
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

function suggestSandboxNames(sandbox: {
  readonly sandboxId: string;
  readonly repository?: string | undefined;
  readonly tag?: string | undefined;
  readonly spec?: NewSandbox;
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

function resolveSourceRef(spec: NewSandbox | undefined): string | undefined {
  if (spec === undefined) {
    return undefined;
  }

  const ref = spec.sources.sandbox.ref.trim();

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

  return "Unable to update sandbox name.";
}
