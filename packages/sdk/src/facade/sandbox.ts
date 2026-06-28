/**
 * The `Sandbox` facade — a live, disposable environment as the SDK exposes it. `status()`/`ready()`
 * poll the control-plane sandbox endpoint; `harness.run()` is the host-local exec path (filled in by
 * the run-execution module). `events()` and the lifecycle verbs are typed now and reject until their
 * endpoints land (Phase 1 / Phase 3).
 */
import type { SandboxDetails } from "@sealant/api-contracts";

import { getSandboxOp } from "../effect/operations.js";
import { SealantError, SealantNotImplementedError } from "../errors.js";
import type {
  Harness,
  HarnessRunner,
  Sandbox,
  SandboxEvent,
  SandboxStatus,
} from "../types.js";
import type { SdkContext } from "./context.js";

export interface SandboxInit {
  readonly id: string;
  readonly name: string;
  readonly status: SandboxStatus;
  /** Present when the handle came from `create()` (needed by `harness.run()`). */
  readonly harness?: Harness;
}

const FAILED_STATUSES = new Set<SandboxStatus>(["failed", "cancelled"]);
const READY_POLL_INTERVAL_MS = 2_000;
const READY_TIMEOUT_MS = 10 * 60 * 1_000;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The host-local `harness.run()` implementation is injected by the run-execution module to avoid a
 * static dependency cycle (sandbox <-> run execution). Until it is registered, `run()` reports that
 * the feature is not wired in this build.
 */
export type RunHarnessFn = (
  ctx: SdkContext,
  init: SandboxInit,
  prompt: string,
  options?: import("../types.js").RunOptions,
) => Promise<import("../types.js").Run>;

let runHarnessImpl: RunHarnessFn | undefined;
export const registerRunHarness = (fn: RunHarnessFn): void => {
  runHarnessImpl = fn;
};

export const makeSandbox = (ctx: SdkContext, init: SandboxInit): Sandbox => {
  const harness: HarnessRunner = {
    run: (prompt, options) => {
      if (runHarnessImpl === undefined) {
        return Promise.reject(
          new SealantNotImplementedError("harness.run (run execution not wired in this build)"),
        );
      }
      return runHarnessImpl(ctx, init, prompt, options);
    },
    start: () =>
      Promise.reject(new SealantNotImplementedError("harness.start (non-blocking run, Phase 2)")),
    session: () =>
      Promise.reject(new SealantNotImplementedError("harness.session (interactive, Phase 3)")),
  };

  const sandbox: Sandbox = {
    id: init.id,
    name: init.name,

    status: async () => {
      const details: SandboxDetails = await ctx.runtime.run(getSandboxOp(init.id));
      return details.status;
    },

    ready: async () => {
      const deadline = Date.now() + READY_TIMEOUT_MS;
      for (;;) {
        const details: SandboxDetails = await ctx.runtime.run(getSandboxOp(init.id));
        // Gate on the coarse "ready" status, which the control plane now emits ONLY after the
        // in-sandbox daemon's control socket is accepting (readiness probe in the launch path).
        // This is honest: when ready() resolves, harness.run() can connect without racing the socket.
        if (details.status === "ready") {
          return sandbox;
        }
        if (FAILED_STATUSES.has(details.status)) {
          throw new SealantError(
            `Sandbox ${init.id} reached terminal status "${details.status}" before becoming ready.`,
            { code: "sandbox_not_ready" },
          );
        }
        if (Date.now() > deadline) {
          throw new SealantError(`Timed out waiting for sandbox ${init.id} to become ready.`, {
            code: "sandbox_ready_timeout",
          });
        }
        await delay(READY_POLL_INTERVAL_MS);
      }
    },

    harness,

    // Poll-backed lifecycle stream: emit a coarse event on each status transition until the sandbox
    // reaches a terminal/ready state. Swaps to SSE over Postgres LISTEN/NOTIFY in Stage 5 (same shape).
    events: () => {
      const ctxRun = ctx.runtime;
      async function* iterate(): AsyncGenerator<SandboxEvent> {
        let lastStatus: SandboxStatus | undefined;
        const deadline = Date.now() + READY_TIMEOUT_MS;
        for (;;) {
          const details = await ctxRun.run(getSandboxOp(init.id));
          if (details.status !== lastStatus) {
            lastStatus = details.status;
            yield {
              type: `status.${details.status}`,
              occurredAt: new Date().toISOString(),
              message: `Sandbox status: ${details.status}`,
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

    stop: () => Promise.reject(new SealantNotImplementedError("sandbox.stop (lifecycle, Phase 3)")),
    restart: () =>
      Promise.reject(new SealantNotImplementedError("sandbox.restart (lifecycle, Phase 3)")),
    expire: () =>
      Promise.reject(new SealantNotImplementedError("sandbox.expire (lifecycle, Phase 3)")),
  };

  return sandbox;
};
