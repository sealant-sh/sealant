/**
 * The `Workspace` facade — a live, disposable environment as the SDK exposes it. `status()`/`ready()`/
 * `events()` poll the control-plane workspace endpoint; `harness.run()`/`harness.start()` are the
 * server-side execution paths (filled in by the run-execution module). `harness.session()` and the
 * lifecycle verbs are typed now and reject until their endpoints land (Phase 3).
 */
import type { WorkspaceDetails } from "@sealant/api-contracts";

import { execWorkspace } from "../effect/exec-workspace.js";
import {
  createSessionOp,
  expireWorkspaceOp,
  getSessionOp,
  getWorkspaceOp,
  listSessionsOp,
  restartWorkspaceOp,
  stopWorkspaceOp,
} from "../effect/operations.js";
import { SealantError, SealantNotImplementedError } from "../errors.js";
import { parseTtlSeconds } from "../internal/duration.js";
import type {
  Harness,
  HarnessRunner,
  InteractiveSession,
  SessionOptions,
  Workspace,
  WorkspaceEvent,
  WorkspaceForward,
  WorkspaceForwardOptions,
  WorkspaceSessions,
  WorkspaceStatus,
} from "../types.js";
import type { SdkContext } from "./context.js";
import { makeInteractiveSession } from "./session.js";

export interface WorkspaceInit {
  readonly id: string;
  readonly name: string;
  readonly status: WorkspaceStatus;
  /** Present when the handle came from `create()` (needed by `harness.run()`). */
  readonly harness?: Harness;
}

// Terminal statuses a workspace can never leave: ready()/events() fail fast (or end the stream)
// on these instead of polling out their deadline. "stopped" is terminal too — a TTL expiry or a
// concurrent stop while ready() polls must surface immediately, not as a 10-minute timeout.
const FAILED_STATUSES = new Set<WorkspaceStatus>(["failed", "cancelled", "stopped"]);
const READY_POLL_INTERVAL_MS = 2_000;
const READY_TIMEOUT_MS = 10 * 60 * 1_000;
const STOP_POLL_INTERVAL_MS = 1_000;
const STOP_TIMEOUT_MS = 60 * 1_000;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The `harness.run()`/`harness.start()` implementations are injected by the run-execution module to
 * avoid a static dependency cycle (workspace <-> run execution). Until they are registered, both
 * report that the feature is not wired in this build.
 */
export type RunHarnessFn = (
  ctx: SdkContext,
  init: WorkspaceInit,
  prompt: string,
  options?: import("../types.js").RunOptions,
) => Promise<import("../types.js").Run>;

export interface HarnessExecutors {
  /** BLOCKING `harness.run()`: resolves once the run is terminal. */
  readonly run: RunHarnessFn;
  /** NON-BLOCKING `harness.start()`: returns the live handle immediately. */
  readonly start: RunHarnessFn;
}

let harnessExecutors: HarnessExecutors | undefined;
export const registerHarnessExecutors = (executors: HarnessExecutors): void => {
  harnessExecutors = executors;
};

// Launch commands for the built-in harnesses — used when a RE-FETCHED handle (no client harness
// value) opens a harness session; the workspace's own spec names the harness id.
const BUILTIN_LAUNCH_COMMANDS: Record<string, string> = {
  opencode: "opencode",
  codex: "codex",
  "claude-code": "claude",
};

export const makeWorkspace = (ctx: SdkContext, init: WorkspaceInit): Workspace => {
  const openSession = async (
    argv: readonly string[],
    options?: SessionOptions,
  ): Promise<InteractiveSession> => {
    const created = await ctx.runtime.run(
      createSessionOp({
        workspaceId: init.id,
        ownerUserId: ctx.config.hostLocal.ownerUserId,
        argv: [...argv],
        ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options?.env === undefined ? {} : { env: options.env }),
        ...(options?.cols === undefined ? {} : { cols: options.cols }),
        ...(options?.rows === undefined ? {} : { rows: options.rows }),
        ...(options?.term === undefined ? {} : { term: options.term }),
        ...(options?.mode === undefined ? {} : { mode: options.mode }),
        ...(options?.metadata === undefined ? {} : { metadata: { ...options.metadata } }),
      }),
    );
    return makeInteractiveSession(ctx, created);
  };

  const sessions: WorkspaceSessions = {
    open: (argv, options) => openSession(argv, options),

    get: async (sessionId) => {
      const wire = await ctx.runtime.run(getSessionOp(sessionId, ctx.config.hostLocal.ownerUserId));
      if (wire.workspaceId !== init.id) {
        throw new SealantError(`Session ${sessionId} does not belong to workspace ${init.id}.`, {
          code: "session_not_found",
        });
      }
      return makeInteractiveSession(ctx, wire);
    },

    list: async () => {
      const response = await ctx.runtime.run(
        listSessionsOp({
          ownerUserId: ctx.config.hostLocal.ownerUserId,
          workspaceId: init.id,
        }),
      );
      return response.items.map((item) => makeInteractiveSession(ctx, item));
    },
  };

  /** The harness's interactive launch argv — client value when present, else from the spec. */
  const resolveHarnessLaunchArgv = async (): Promise<readonly string[]> => {
    if (init.harness !== undefined) {
      return [init.harness.launchCommand ?? init.harness.id];
    }
    const details = await ctx.runtime.run(
      getWorkspaceOp(init.id, ctx.config.hostLocal.ownerUserId),
    );
    const spec = details.spec as { harness?: { id?: string } } | undefined;
    const harnessId = spec?.harness?.id;
    if (harnessId === undefined) {
      throw new SealantError(
        `Workspace ${init.id} has no harness in its spec; open a session with workspace.sessions.open(argv) instead.`,
        { code: "harness_required" },
      );
    }
    return [BUILTIN_LAUNCH_COMMANDS[harnessId] ?? harnessId];
  };

  const harness: HarnessRunner = {
    run: (prompt, options) => {
      if (harnessExecutors === undefined) {
        return Promise.reject(
          new SealantNotImplementedError("harness.run (run execution not wired in this build)"),
        );
      }
      return harnessExecutors.run(ctx, init, prompt, options);
    },
    start: (prompt, options) => {
      if (harnessExecutors === undefined) {
        return Promise.reject(
          new SealantNotImplementedError("harness.start (run execution not wired in this build)"),
        );
      }
      return harnessExecutors.start(ctx, init, prompt, options);
    },
    session: async (options) => {
      const argv = await resolveHarnessLaunchArgv();
      return openSession(argv, options);
    },
  };

  const workspace: Workspace = {
    id: init.id,
    name: init.name,

    status: async () => {
      const details: WorkspaceDetails = await ctx.runtime.run(
        getWorkspaceOp(init.id, ctx.config.hostLocal.ownerUserId),
      );
      return details.status;
    },

    ready: async () => {
      const deadline = Date.now() + READY_TIMEOUT_MS;
      for (;;) {
        const details: WorkspaceDetails = await ctx.runtime.run(
          getWorkspaceOp(init.id, ctx.config.hostLocal.ownerUserId),
        );
        // Gate on the coarse "ready" status, which the control plane now emits ONLY after the
        // in-workspace daemon's control socket is accepting (readiness probe in the launch path).
        // This is honest: when ready() resolves, harness.run() can connect without racing the socket.
        if (details.status === "ready") {
          return workspace;
        }
        if (FAILED_STATUSES.has(details.status)) {
          throw new SealantError(
            `Workspace ${init.id} reached terminal status "${details.status}" before becoming ready.`,
            { code: "workspace_not_ready" },
          );
        }
        if (Date.now() > deadline) {
          throw new SealantError(`Timed out waiting for workspace ${init.id} to become ready.`, {
            code: "workspace_ready_timeout",
          });
        }
        await delay(READY_POLL_INTERVAL_MS);
      }
    },

    harness,

    sessions,

    exec: (argv, options) => execWorkspace(ctx, init, argv, options),

    // Poll-backed lifecycle stream: emit a coarse event on each status transition until the workspace
    // reaches a terminal/ready state. Swaps to SSE over Postgres LISTEN/NOTIFY in Stage 5 (same shape).
    events: () => {
      const ctxRun = ctx.runtime;
      async function* iterate(): AsyncGenerator<WorkspaceEvent> {
        let lastStatus: WorkspaceStatus | undefined;
        const deadline = Date.now() + READY_TIMEOUT_MS;
        for (;;) {
          const details = await ctxRun.run(
            getWorkspaceOp(init.id, ctx.config.hostLocal.ownerUserId),
          );
          if (details.status !== lastStatus) {
            lastStatus = details.status;
            yield {
              type: `status.${details.status}`,
              occurredAt: new Date().toISOString(),
              message: `Workspace status: ${details.status}`,
            };
          }
          if (details.status === "ready" || FAILED_STATUSES.has(details.status)) {
            return;
          }
          if (Date.now() > deadline) {
            return;
          }
          await delay(READY_POLL_INTERVAL_MS);
        }
      }
      return iterate();
    },

    // BLOCKING stop: the control plane accepts the stop (202) and the worker tears the container
    // down; resolve only once the workspace reports the terminal "stopped" status, so callers can
    // trust the container is gone when this settles.
    stop: async () => {
      const ownerUserId = ctx.config.hostLocal.ownerUserId;
      await ctx.runtime.run(stopWorkspaceOp(init.id, { ownerUserId }));

      const deadline = Date.now() + STOP_TIMEOUT_MS;
      for (;;) {
        const details: WorkspaceDetails = await ctx.runtime.run(
          getWorkspaceOp(init.id, ctx.config.hostLocal.ownerUserId),
        );
        if (details.status === "stopped") {
          return;
        }
        if (Date.now() > deadline) {
          throw new SealantError(`Timed out waiting for workspace ${init.id} to stop.`, {
            code: "workspace_stop_timeout",
          });
        }
        await delay(STOP_POLL_INTERVAL_MS);
      }
    },

    // Restart drives a fresh launch (new attempt, new container, same resolved spec) and returns a
    // handle that resolves readiness against the NEW runtime via the usual ready() gate.
    restart: async () => {
      const ownerUserId = ctx.config.hostLocal.ownerUserId;
      await ctx.runtime.run(restartWorkspaceOp(init.id, { ownerUserId }));
      return makeWorkspace(ctx, {
        id: init.id,
        name: init.name,
        status: "queued",
        ...(init.harness === undefined ? {} : { harness: init.harness }),
      });
    },

    // expire({in: "2h"}) sets the TTL, expire() expires now (the platform reaper stops it on its
    // next tick), expire({in: null}) clears the TTL. Resolves once the expiry is recorded.
    expire: async (options) => {
      const ownerUserId = ctx.config.hostLocal.ownerUserId;
      const ttl = options?.in;
      await ctx.runtime.run(
        expireWorkspaceOp(init.id, {
          ownerUserId,
          ...(ttl === undefined ? {} : { ttlSeconds: ttl === null ? null : parseTtlSeconds(ttl) }),
        }),
      );
    },

    forward: (port, options) => openForward(ctx, init.id, port, options),
  };

  return workspace;
};

/**
 * Open the held-WebSocket port forward (the byte-pipe data plane, mirroring
 * the session attachment): binary frames are payload bytes in both
 * directions; text frames are control JSON — `{"t":"eof"}` up for half-close,
 * `{"t":"end"}` down when the remote closes. Auth rides the connect
 * (`?token=` / `?ownerUserId=`), never per frame. The server refuses the
 * upgrade with a plain HTTP status when nothing listens on the port, which
 * surfaces here as the connect rejection.
 */
const openForward = (
  ctx: SdkContext,
  workspaceId: string,
  port: number,
  options?: WorkspaceForwardOptions,
): Promise<WorkspaceForward> => {
  const config = ctx.config;
  const url = new URL(`/v1/workspaces/${workspaceId}/forward`, config.baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("port", String(port));
  if (options?.host !== undefined) {
    url.searchParams.set("host", options.host);
  }
  if (options?.protocol === "udp") {
    url.searchParams.set("protocol", "udp");
  }
  // The owner assertion always rides the URL (a service principal needs it alongside its
  // key, and WebSocket cannot carry headers — same contract as the session attach).
  url.searchParams.set("ownerUserId", config.hostLocal.ownerUserId);
  if (config.apiKey !== undefined) {
    url.searchParams.set("token", config.apiKey);
  }

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";

    // Push-queue bridging WS message events to the pull-based async iterable.
    const pending: Uint8Array[] = [];
    let wake: (() => void) | undefined;
    let finished = false;
    const closedResolver = Promise.withResolvers<"end" | "closed">();
    const closed = closedResolver.promise;
    const finish = (reason: "end" | "closed") => {
      if (finished) {
        return;
      }
      finished = true;
      closedResolver.resolve(reason);
      wake?.();
    };

    ws.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        try {
          const frame = JSON.parse(event.data) as { t?: string };
          if (frame.t === "end") {
            finish("end");
          }
        } catch {
          // Unknown text frame — ignore.
        }
        return;
      }
      pending.push(new Uint8Array(event.data as ArrayBuffer));
      wake?.();
    });
    ws.addEventListener("close", () => finish("closed"));

    const output: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({
        next: async (): Promise<IteratorResult<Uint8Array>> => {
          for (;;) {
            const chunk = pending.shift();
            if (chunk !== undefined) {
              return { done: false, value: chunk };
            }
            if (finished) {
              return { done: true, value: undefined };
            }
            await new Promise<void>((r) => {
              wake = r;
            });
            wake = undefined;
          }
        },
      }),
    };

    const forward: WorkspaceForward = {
      send: (input) => {
        // Copy into a plain ArrayBuffer-backed view (WebSocket.send rejects SharedArrayBuffer views).
        ws.send(new Uint8Array(input).buffer);
      },
      eof: () => {
        ws.send(JSON.stringify({ t: "eof" }));
      },
      output,
      closed,
      close: () => {
        finish("closed");
        ws.close();
      },
    };

    ws.addEventListener("open", () => resolve(forward), { once: true });
    ws.addEventListener(
      "error",
      () =>
        reject(
          new Error(
            `workspace forward failed: could not connect to ${url.host} (is anything listening on 127.0.0.1:${port} in the workspace?)`,
          ),
        ),
      { once: true },
    );
  });
};
