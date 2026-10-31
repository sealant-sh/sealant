/**
 * A scope's long-running instances (a project's Postgres, Redis or any image), the workspaces that
 * reach them, and the scope's archive. Instances run on Docker only: on any other runtime every
 * call rejects with 409 `ResourceRuntimeUnsupportedError` (`resources run on Docker; this Sealant
 * runs <runtime>`).
 */
import {
  RESOURCE_INSTANCE_EXEC,
  type ResourceInstanceArchivedVolumeWire,
  type ResourceInstanceState,
  type ResourceInstanceWire,
} from "@sealant/api-contracts";

import {
  archiveResourceDomainOp,
  archiveResourceInstanceOp,
  getResourceInstanceOp,
  linkResourceWorkspaceOp,
  listResourceInstancesOp,
  stopResourceInstanceOp,
  upResourceInstanceOp,
} from "./effect/operations.js";
import type { SdkRuntime } from "./effect/runtime.js";
import { SealantApiError, SealantError } from "./errors.js";
import type { SealantInternalConfig } from "./internal/config.js";

/**
 * What an instance runs. It has no field for privileged mode, capabilities, host networking, host
 * paths, devices, the Docker socket or shared namespaces; a spec sent with one is refused (400
 * `ResourceInstanceSpecRefusedError`, naming each).
 */
export interface ScopeInstanceSpec {
  /** The DNS name a linked workspace reaches it by (`db`). */
  readonly alias: string;
  /** Null: every linked workspace reaches it. Set: only workspaces linked with this worktree key. */
  readonly worktreeKey: string | null;
  /** Pinned by digest: `<repository>[:tag]@sha256:<64 hex>`. */
  readonly image: string;
  /** Replaces the image's CMD; its ENTRYPOINT always runs. */
  readonly command: ReadonlyArray<string> | null;
  /** Plain env. Not for secrets: put a secret in an exec's stdin. */
  readonly env: Readonly<Record<string, string>>;
  /** Named volumes; every image `VOLUME` gets one too. None is ever deleted by Sealant. */
  readonly volumes: ReadonlyArray<{ readonly name: string; readonly mountPath: string }>;
  readonly limits: { readonly cpuMillicores: number; readonly memoryBytes: number };
  readonly ready:
    | { readonly kind: "tcp"; readonly port: number }
    | {
        readonly kind: "exec";
        readonly argv: ReadonlyArray<string>;
        readonly user: string | null;
      };
  /** Seconds with no live linked workspace reaching it before Sealant stops it. */
  readonly idleStopAfterSeconds: number;
}

export type ScopeInstanceStopReason =
  | { readonly kind: "idle" }
  | { readonly kind: "person"; readonly by: string };

/** What Sealant last observed of an instance. */
export type ScopeInstanceState =
  | { readonly kind: "not-started" }
  | { readonly kind: "starting"; readonly since: Date }
  /** Its ready check answered. */
  | { readonly kind: "running"; readonly since: Date }
  | { readonly kind: "stopped"; readonly at: Date; readonly reason: ScopeInstanceStopReason }
  /** It ended on its own; Sealant starts it again. */
  | { readonly kind: "exited"; readonly at: Date; readonly exitCode: number | null }
  /** A start that could not finish (an image pull, the ready check), and why. */
  | { readonly kind: "failed"; readonly at: Date; readonly message: string }
  | { readonly kind: "archived"; readonly at: Date };

export interface ScopeInstance {
  /** `rin:<uuid>`. */
  readonly id: string;
  readonly key: string;
  readonly alias: string;
  readonly worktreeKey: string | null;
  readonly specDigest: string;
  /** What was asked of it. */
  readonly desired: "running" | "stopped" | "archived";
  /** Set while it is stopped: a person's stop holds until a person starts it. */
  readonly stopReason: ScopeInstanceStopReason | null;
  readonly state: ScopeInstanceState;
  readonly observedAt: Date;
  readonly startedAt: Date | null;
  readonly lastReachedAt: Date | null;
  readonly volumes: ReadonlyArray<{ readonly name: string; readonly dockerName: string }>;
}

export interface ScopeArchivedVolume {
  readonly instanceKey: string;
  readonly name: string;
  readonly dockerName: string;
  /** Measured at archive; null when it could not be. */
  readonly bytes: number | null;
}

export interface ScopeExecResult {
  /** Null when the command was killed at its timeout. */
  readonly exitCode: number | null;
  /** The tail of stdout, at most 1 MiB. */
  readonly stdout: string;
  readonly stderr: string;
  /** Either output was longer than 1 MiB, and only its tail is here. */
  readonly truncated: boolean;
  readonly timedOut: boolean;
}

export interface ScopeInstances {
  /**
   * Create or update the instance by key, start it and answer once its ready check passed or its
   * start failed (`state.kind`). `cause: "use"` (a launch, a wake) leaves an instance a person
   * stopped stopped, and answers it so; `cause: "person"` (a person's Start) starts it. The same
   * spec twice is one instance; a changed spec replaces its container and keeps its volumes.
   */
  up(
    key: string,
    spec: ScopeInstanceSpec,
    options: { readonly cause: "use" | "person" },
  ): Promise<ScopeInstance>;
  /** Rejects with 404 `ResourceInstanceNotFoundError` when the scope has none by this key. */
  get(key: string): Promise<ScopeInstance>;
  /** The scope's instances; `archived: true` lists the archived ones, whose volumes are kept. */
  list(options?: { readonly archived?: boolean }): Promise<ReadonlyArray<ScopeInstance>>;
  /** Graceful. Its container, volumes and reach stay; it stays stopped until a person's `up`. */
  stop(
    key: string,
    reason: { readonly kind: "person"; readonly by: string },
  ): Promise<ScopeInstance>;
  /**
   * Run `argv` in the running instance. `stdin` streams in (a dump of any size); stdout and stderr
   * come back as tails of at most 1 MiB each. Nothing of argv or stdin is logged or recorded: put
   * a secret in stdin. `timeoutMs` defaults to 10 minutes, at most 6 hours.
   */
  exec(
    key: string,
    options: {
      readonly argv: ReadonlyArray<string>;
      readonly user?: string;
      readonly stdin?: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>;
      readonly timeoutMs?: number;
    },
  ): Promise<ScopeExecResult>;
  /** Stop it and remove its container. Every volume stays, listed here with its size. */
  archive(key: string): Promise<{
    readonly instance: ScopeInstance;
    readonly volumes: ReadonlyArray<ScopeArchivedVolume>;
  }>;
}

export interface ScopeWorkspaces {
  /**
   * Let this workspace reach the scope's project instances, and those of `worktreeKey`, by alias:
   * now, and across executor replacements, until the workspace ends. Linking again moves it to
   * another worktree key; a workspace linked to another scope rejects (409
   * `ResourceWorkspaceLinkedElsewhereError`). Answers once its running executors are attached.
   */
  link(
    workspaceId: string,
    options: { readonly worktreeKey: string },
  ): Promise<{ readonly worktreeKey: string; readonly attachedExecutors: number }>;
}

const date = (value: string) => new Date(value);
const maybeDate = (value: string | null) => (value === null ? null : new Date(value));

const toState = (state: ResourceInstanceState): ScopeInstanceState => {
  switch (state.kind) {
    case "not-started":
      return { kind: "not-started" };
    case "starting":
      return { kind: "starting", since: date(state.since) };
    case "running":
      return { kind: "running", since: date(state.since) };
    case "stopped":
      return { kind: "stopped", at: date(state.at), reason: state.reason };
    case "exited":
      return { kind: "exited", at: date(state.at), exitCode: state.exitCode };
    case "failed":
      return { kind: "failed", at: date(state.at), message: state.message };
    case "archived":
      return { kind: "archived", at: date(state.at) };
  }
};

const toInstance = (wire: ResourceInstanceWire): ScopeInstance => ({
  id: wire.resourceInstanceId,
  key: wire.key,
  alias: wire.alias,
  worktreeKey: wire.worktreeKey,
  specDigest: wire.specDigest,
  desired: wire.desired,
  stopReason: wire.stopReason,
  state: toState(wire.state),
  observedAt: date(wire.observedAt),
  startedAt: maybeDate(wire.startedAt),
  lastReachedAt: maybeDate(wire.lastReachedAt),
  volumes: wire.volumes,
});

const toVolume = (wire: ResourceInstanceArchivedVolumeWire): ScopeArchivedVolume => ({
  instanceKey: wire.instanceKey,
  name: wire.name,
  dockerName: wire.dockerName,
  bytes: wire.bytes,
});

/** The exec body: the frame's line, then stdin as it arrives. */
const execBody = (
  frame: string,
  stdin: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array> | undefined,
): ReadableStream<Uint8Array> => {
  const chunks = async function* (): AsyncGenerator<Uint8Array> {
    yield new TextEncoder().encode(`${frame}\n`);
    if (stdin === undefined) return;
    if (stdin instanceof ReadableStream) {
      const reader = stdin.getReader();
      for (;;) {
        const next = await reader.read();
        if (next.done) return;
        yield next.value;
      }
    }
    yield* stdin;
  };
  const iterator = chunks();
  return new ReadableStream<Uint8Array>({
    pull: async (controller) => {
      const next = await iterator.next();
      if (next.done === true) controller.close();
      else controller.enqueue(next.value);
    },
    cancel: async () => {
      await iterator.return(undefined);
    },
  });
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const execResultOf = (body: unknown): ScopeExecResult | undefined => {
  if (!isRecord(body)) return undefined;
  const { exitCode, stdout, stderr, truncated, timedOut } = body;
  if (
    (exitCode !== null && typeof exitCode !== "number") ||
    typeof stdout !== "string" ||
    typeof stderr !== "string" ||
    typeof truncated !== "boolean" ||
    typeof timedOut !== "boolean"
  ) {
    return undefined;
  }
  return { exitCode, stdout, stderr, truncated, timedOut };
};

const exec = async (
  config: SealantInternalConfig,
  scopeId: string,
  key: string,
  options: Parameters<ScopeInstances["exec"]>[1],
): Promise<ScopeExecResult> => {
  const path = RESOURCE_INSTANCE_EXEC.path
    .replace(":resourceDomainId", encodeURIComponent(scopeId))
    .replace(":key", encodeURIComponent(key));
  const frame = JSON.stringify({
    argv: options.argv,
    user: options.user ?? null,
    timeoutMs: options.timeoutMs ?? RESOURCE_INSTANCE_EXEC.defaultTimeoutMs,
  });
  // A streamed request body needs half duplex in every fetch that streams one (Node's included).
  const init: RequestInit & { readonly duplex: "half" } = {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      ...(config.apiKey === undefined ? {} : { authorization: `Bearer ${config.apiKey}` }),
    },
    body: execBody(frame, options.stdin),
    duplex: "half",
  };
  const response = await (config.fetch ?? fetch)(new URL(path, config.baseUrl), init);
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const tag = isRecord(body) && typeof body["_tag"] === "string" ? body["_tag"] : undefined;
    const message =
      isRecord(body) && typeof body["message"] === "string"
        ? body["message"]
        : `The exec was refused (${String(response.status)}).`;
    throw new SealantApiError(message, {
      status: response.status,
      ...(tag === undefined ? {} : { code: tag }),
    });
  }
  const result = execResultOf(body);
  if (result === undefined)
    throw new SealantError("The exec answered something that is not a result.");
  return result;
};

export const makeScopeInstances = (
  runtime: SdkRuntime,
  config: SealantInternalConfig,
  scopeId: string,
): {
  readonly instances: ScopeInstances;
  readonly workspaces: ScopeWorkspaces;
  readonly archive: () => Promise<{ readonly volumes: ReadonlyArray<ScopeArchivedVolume> }>;
} => ({
  instances: {
    up: async (key, spec, { cause }) =>
      toInstance(
        await runtime.run(upResourceInstanceOp(scopeId, key, { spec: { ...spec }, cause })),
      ),
    get: async (key) => toInstance(await runtime.run(getResourceInstanceOp(scopeId, key))),
    list: async (options) =>
      (await runtime.run(listResourceInstancesOp(scopeId, options?.archived === true))).items.map(
        toInstance,
      ),
    stop: async (key, reason) =>
      toInstance(await runtime.run(stopResourceInstanceOp(scopeId, key, reason.by))),
    exec: (key, options) => exec(config, scopeId, key, options),
    archive: async (key) => {
      const answer = await runtime.run(archiveResourceInstanceOp(scopeId, key));
      return { instance: toInstance(answer.instance), volumes: answer.volumes.map(toVolume) };
    },
  },
  workspaces: {
    link: async (workspaceId, { worktreeKey }) => {
      const answer = await runtime.run(linkResourceWorkspaceOp(scopeId, workspaceId, worktreeKey));
      return { worktreeKey: answer.worktreeKey, attachedExecutors: answer.attachedExecutors };
    },
  },
  archive: async () => {
    const answer = await runtime.run(archiveResourceDomainOp(scopeId));
    return { volumes: answer.volumes.map(toVolume) };
  },
});
