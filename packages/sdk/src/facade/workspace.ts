/**
 * The `Workspace` facade — a live, disposable environment as the SDK exposes it. `status()`/`ready()`/
 * `events()` poll the control-plane workspace endpoint; `harness.run()`/`harness.start()` are the
 * server-side execution paths (filled in by the run-execution module). `harness.session()` and the
 * lifecycle verbs are typed now and reject until their endpoints land (Phase 3).
 */
import type { WorkspaceDetails } from "@sealant/api-contracts";

import { execWorkspace } from "../effect/exec-workspace.js";
import { getWorkspaceOp } from "../effect/operations.js";
import { SealantError, SealantNotImplementedError } from "../errors.js";
import type {
  Harness,
  HarnessRunner,
  Workspace,
  WorkspaceEvent,
  WorkspaceStatus,
} from "../types.js";
import type { SdkContext } from "./context.js";

export interface WorkspaceInit {
  readonly id: string;
  readonly name: string;
  readonly status: WorkspaceStatus;
  /** Present when the handle came from `create()` (needed by `harness.run()`). */
  readonly harness?: Harness;
}

const FAILED_STATUSES = new Set<WorkspaceStatus>(["failed", "cancelled"]);
const READY_POLL_INTERVAL_MS = 2_000;
const READY_TIMEOUT_MS = 10 * 60 * 1_000;

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

export const makeWorkspace = (ctx: SdkContext, init: WorkspaceInit): Workspace => {
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
    session: () =>
      Promise.reject(new SealantNotImplementedError("harness.session (interactive, Phase 3)")),
  };

  const workspace: Workspace = {
    id: init.id,
    name: init.name,

    status: async () => {
      const details: WorkspaceDetails = await ctx.runtime.run(getWorkspaceOp(init.id));
      return details.status;
    },

    ready: async () => {
      const deadline = Date.now() + READY_TIMEOUT_MS;
      for (;;) {
        const details: WorkspaceDetails = await ctx.runtime.run(getWorkspaceOp(init.id));
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

    exec: (argv, options) => execWorkspace(ctx, init, argv, options),

    // Poll-backed lifecycle stream: emit a coarse event on each status transition until the workspace
    // reaches a terminal/ready state. Swaps to SSE over Postgres LISTEN/NOTIFY in Stage 5 (same shape).
    events: () => {
      const ctxRun = ctx.runtime;
      async function* iterate(): AsyncGenerator<WorkspaceEvent> {
        let lastStatus: WorkspaceStatus | undefined;
        const deadline = Date.now() + READY_TIMEOUT_MS;
        for (;;) {
          const details = await ctxRun.run(getWorkspaceOp(init.id));
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

    stop: () =>
      Promise.reject(new SealantNotImplementedError("workspace.stop (lifecycle, Phase 3)")),
    restart: () =>
      Promise.reject(new SealantNotImplementedError("workspace.restart (lifecycle, Phase 3)")),
    expire: () =>
      Promise.reject(new SealantNotImplementedError("workspace.expire (lifecycle, Phase 3)")),
  };

  return workspace;
};
