/**
 * `Sealant` — the public client and the import users reach for.
 *
 *   import { Sealant, opencode } from "@sealant/sdk"
 *   const sealant = new Sealant({ baseUrl: "http://localhost:8080" })
 *
 * This is the plain-Promise facade over the Effect core: an app `Layer` built once in the
 * constructor providing the wire client derived from `@sealant/api-contracts`. Everything is a plain
 * HTTP call to `baseUrl`. Operations whose endpoints have not landed yet stay TYPED against the
 * stable surface and reject with `SealantNotImplementedError` so callers can compile and wire
 * against the final shape today.
 */
import { createSandboxOp, getRunOp, getSandboxOp, listSandboxesOp } from "./effect/operations.js";
import { runHarness, startHarness } from "./effect/run-harness.js";
import { makeSdkRuntime, type SdkRuntime } from "./effect/runtime.js";
import { SealantError } from "./errors.js";
import type { SdkContext } from "./facade/context.js";
import { makeRun } from "./facade/run.js";
import { makeSandbox, registerHarnessExecutors } from "./facade/sandbox.js";
import { buildCreateSandboxRequest } from "./internal/blueprint.js";
import { resolveInternalConfig } from "./internal/config.js";
import type { CreateOptions, ListOptions, Run, Sandbox, SealantConfig } from "./types.js";

// Wire the run-execution implementations into the Sandbox facade (the injection point exists to
// break the sandbox <-> run-harness import cycle; the client is the composition root).
registerHarnessExecutors({ run: runHarness, start: startHarness });

export class Sealant {
  readonly #config: SealantConfig;
  readonly #runtime: SdkRuntime;
  readonly #ctx: SdkContext;

  constructor(config: SealantConfig) {
    if (config.baseUrl.trim().length === 0) {
      throw new SealantError("Sealant requires a non-empty `baseUrl`.", { code: "invalid_config" });
    }
    const internalConfig = resolveInternalConfig(config);
    this.#config = config;
    this.#runtime = makeSdkRuntime(internalConfig);
    this.#ctx = { runtime: this.#runtime, config: internalConfig };
  }

  /** The configured control-plane base URL. */
  get baseUrl(): string {
    return this.#config.baseUrl;
  }

  /** Sandbox lifecycle: create, fetch, and list live environments. */
  readonly sandboxes = {
    create: async (options: CreateOptions): Promise<Sandbox> => {
      const { payload } = buildCreateSandboxRequest(options, this.#ctx.config);
      const created = await this.#runtime.run(createSandboxOp(payload));
      const sandbox = makeSandbox(this.#ctx, {
        id: created.sandboxId,
        name: created.name,
        status: created.status,
        harness: options.harness,
      });
      if (options.wait === false) {
        return sandbox;
      }
      // Pump provisioning events to onEvent (best-effort) while we wait for ready. Never let an
      // event-stream hiccup fail create().
      if (options.onEvent !== undefined) {
        const onEvent = options.onEvent;
        void (async () => {
          try {
            for await (const event of sandbox.events()) {
              onEvent(event);
            }
          } catch {
            // best-effort observation only
          }
        })();
      }
      return sandbox.ready();
    },

    get: async (id: string): Promise<Sandbox> => {
      const details = await this.#runtime.run(getSandboxOp(id));
      return makeSandbox(this.#ctx, {
        id: details.sandboxId,
        name: details.name,
        status: details.status,
      });
    },

    list: async (options?: ListOptions): Promise<readonly Sandbox[]> => {
      const response = await this.#runtime.run(
        listSandboxesOp({
          ownerUserId: this.#ctx.config.hostLocal.ownerUserId,
          ...(options?.status === undefined ? {} : { status: options.status }),
          ...(options?.limit === undefined ? {} : { limit: String(options.limit) }),
        }),
      );
      return response.items.map((item) =>
        makeSandbox(this.#ctx, {
          id: item.sandboxId,
          name: item.name,
          status: item.status,
        }),
      );
    },
  };

  /** Runs by id — so a record can be replayed long after its sandbox is gone. */
  readonly runs = {
    get: async (runId: string): Promise<Run> => {
      const wire = await this.#runtime.run(getRunOp(runId));
      return makeRun(this.#ctx, { wire });
    },
  };

  /** Release resources held by the client (the Effect runtime scope: DB pool, daemon connections). */
  async close(): Promise<void> {
    await this.#runtime.dispose();
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
}
