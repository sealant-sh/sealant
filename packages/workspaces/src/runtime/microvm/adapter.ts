/**
 * The AWS Lambda MicroVM runtime adapter: one Firecracker MicroVM per workspace attempt.
 *
 * Launch, for one run id:
 *   1. `supports`: family, ephemeral persistence, outbound network; no DinD, no gVisor
 *      selection, no host mounts, no cluster env references (none of those exist on this
 *      platform).
 *   2. `RunMicrovm` from the deployment's image with `clientToken` = a digest of the run id, so a
 *      redelivered launch gets the SAME MicroVM back instead of a second one. The run-hook
 *      payload carries only the launch secret (`agent-contract.ts`).
 *   3. Poll `GetMicrovm` until RUNNING (the /run hook has answered; the endpoint routes).
 *   4. Push the launch material to the in-VM agent over the VM's authenticated endpoint —
 *      boot env, the sealed secret env file, inline dotfiles — which writes the files (0600)
 *      and starts `sealantd boot`. A 409 means an earlier delivery already booted it: adopt.
 *   5. Open the REAL control channel (WebSocket through the endpoint, relayed by the agent to
 *      the daemon's socket) and require `runtime.health` to answer — that is `ready`.
 *   6. Write credential files over that authenticated channel (stdin, never argv).
 *
 * Stop is `TerminateMicrovm`; the platform runs the image's /terminate hook first, where the
 * agent flushes captures (`sealantctl capture flush`). Fencing (ADR-0015) additionally waits
 * for TERMINATED so a replacement executor can claim the worktree knowing the old VM cannot
 * write again. `inspect` / `watchExits` poll `GetMicrovm`: there is no event stream.
 *
 * Sources (read 2026-09-13):
 *   https://docs.aws.amazon.com/lambda/latest/microvm-api/API_RunMicrovm.html
 *   https://docs.aws.amazon.com/lambda/latest/dg/microvms-how-it-works.html#microvms-transitions
 *   https://docs.aws.amazon.com/lambda/latest/dg/microvms-networking.html
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { getHarnessIntegration } from "../../harness/integrations.js";
import type { SealantTarget } from "../../sealantd/runtime.js";
import { captureSourceEnv } from "../capture-source.js";
import { inlineDotfilesFromDir } from "../inline-dotfiles.js";
import { liveControlChannel, type ControlChannel } from "../kubernetes/adapter.js";
import {
  parseRuntimeAdapterLaunchInput,
  parseRuntimeAdapterStopInput,
  parseRuntimeAdapterSupportInput,
  type RuntimeAdapter,
  type RuntimeAdapterExitWatch,
  type RuntimeAdapterExitWatchInput,
  type RuntimeAdapterInspectInput,
  type RuntimeAdapterInspectResult,
  type RuntimeAdapterLaunchInput,
  type RuntimeAdapterLaunchResult,
  type RuntimeAdapterStopInput,
  type RuntimeAdapterStopResult,
  type RuntimeAdapterSupport,
  type RuntimeAdapterSupportInput,
} from "../runtime-adapter.js";
import {
  AGENT_CONTRACT_VERSION,
  AGENT_CONTROL_ROUTE,
  AGENT_LAUNCH_ROUTE,
  agentErrorResponseSchema,
  agentLaunchResponseSchema,
  CONTROL_SOCKET_PATH,
  DOTFILES_ARCHIVE_DIR,
  launchSecretForRun,
  SECRET_ENV_FILE_PATH,
  type AgentLaunchRequest,
  type RunHookPayload,
} from "./agent-contract.js";
import type { MicrovmApi, MicrovmDescription, MicrovmRunInput } from "./api.js";
import type { MicrovmRuntimeConfig } from "./config.js";
import { MicrovmEndpointTokens } from "./endpoint-tokens.js";

export interface MicrovmRuntimeAdapterOptions {
  readonly config: MicrovmRuntimeConfig;
  readonly api: MicrovmApi;
  /** Shared with the process's target derivation so control connections reuse cached tokens. */
  readonly tokens?: MicrovmEndpointTokens;
  /** Test seam; defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Test seam: override the control-channel probe (health + credential files). */
  readonly controlChannel?: ControlChannel;
  /** Test seam: readiness polling cadence. */
  readonly pollIntervalMs?: number;
  readonly now?: () => number;
}

const POLL_INTERVAL_MS = 1000;

const createAdapterError = (code: string, message: string): Error & { code: string } =>
  Object.assign(new Error(message), { code });

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The support decision, pure. */
export const supportForMicrovm = (input: RuntimeAdapterSupportInput): RuntimeAdapterSupport => {
  const family = input.blueprint.target.runtime.family;
  if (family !== "auto" && family !== "microvm") {
    return {
      supported: false,
      reason: "unsupported-runtime",
      message: `The microvm adapter cannot serve runtime family '${family}'.`,
    };
  }
  if (input.blueprint.runtime.persistence !== "ephemeral") {
    return {
      supported: false,
      reason: "unsupported-runtime-requirement",
      message: "The microvm adapter only supports ephemeral persistence.",
    };
  }
  if (!input.blueprint.runtime.network.outbound) {
    return {
      supported: false,
      reason: "unsupported-runtime-requirement",
      message:
        "The microvm adapter cannot disable outbound network access; egress is a property of the VM's network connector.",
    };
  }
  if (input.blueprint.tooling.services?.docker?.enabled === true) {
    return {
      supported: false,
      reason: "unsupported-runtime-requirement",
      message:
        "Workspace-scoped Docker (tooling.services.docker) is not available in Lambda MicroVMs.",
    };
  }
  if (input.blueprint.runtime.ociRuntime === "runsc") {
    return {
      supported: false,
      reason: "unsupported-runtime-requirement",
      message:
        "ociRuntime 'runsc' is not selectable on Lambda MicroVMs; the Firecracker VM is the isolation boundary.",
    };
  }
  const source = input.blueprint.sources.workspace;
  if (source.kind === "mount" || source.kind === "standby") {
    return {
      supported: false,
      reason: "unsupported-runtime-requirement",
      message:
        "A mount or standby workspace source names a host path no MicroVM can see; use a capture source (sealantd ADR-0015) or a git source.",
    };
  }
  if (
    input.blueprint.runtime.envFrom.length > 0 ||
    input.blueprint.runtime.kubernetes.serviceAccountName !== undefined
  ) {
    return {
      supported: false,
      reason: "unsupported-runtime-requirement",
      message:
        "Cluster env references (runtime.envFrom, kubernetes.serviceAccountName) resolve only on Kubernetes runtimes.",
    };
  }
  if (input.blueprint.sources.mounts.length > 0) {
    return {
      supported: false,
      reason: "unsupported-runtime-requirement",
      message: "Extra host mounts (sources.mounts) are not available in Lambda MicroVMs.",
    };
  }
  return { supported: true };
};

/**
 * `RunMicrovm.clientToken` for a run: 1–128 characters, deterministic per run so a redelivered
 * launch returns the MicroVM already running for it. Digested rather than passed through so any
 * run id shape (uuid, ulid, prefixed) satisfies the API's constraint.
 */
export const clientTokenForRun = (runId: string): string =>
  createHash("sha256").update(`sealant-microvm-run:${runId}`).digest("hex");

/** The RunMicrovm request for a run; pure, pinned by the golden test. */
export const buildRunInput = (
  config: MicrovmRuntimeConfig,
  runId: string,
  launchSecret: string,
): MicrovmRunInput => {
  const payload: RunHookPayload = { version: AGENT_CONTRACT_VERSION, runId, launchSecret };
  return {
    imageIdentifier: config.imageArn,
    ...(config.imageVersion === undefined ? {} : { imageVersion: config.imageVersion }),
    executionRoleArn: config.executionRoleArn,
    ingressNetworkConnectors: [config.ingressNetworkConnector],
    ...(config.egressNetworkConnector === undefined
      ? {}
      : { egressNetworkConnectors: [config.egressNetworkConnector] }),
    // Idle detection counts inbound proxy traffic only, so a busy agent nobody is watching
    // looks idle; a capture executor must never be suspended by the platform's timer (its
    // liveness is a lease heartbeat the platform cannot see). Both windows equal the lifetime
    // cap: the idle policy can never fire before the VM ends anyway. Whether OMITTING the
    // policy disables idle suspension is unconfirmed, hence the explicit values.
    idlePolicy: {
      autoResumeEnabled: false,
      maxIdleDurationSeconds: config.maxDurationSeconds,
      suspendedDurationSeconds: config.maxDurationSeconds,
    },
    maximumDurationInSeconds: config.maxDurationSeconds,
    ...(config.logGroup === undefined
      ? {}
      : { logging: { cloudWatch: { logGroup: config.logGroup } } }),
    runHookPayload: JSON.stringify(payload),
    clientToken: clientTokenForRun(runId),
  };
};

interface BootLifecycleStepJson {
  readonly run: string;
  readonly shell: "sh" | "bash";
  readonly workingDirectory?: string;
}

const toBootLifecycleStepJson = (step: {
  readonly run: string;
  readonly shell: "sh" | "bash";
  readonly workingDirectory?: string | undefined;
}): BootLifecycleStepJson => ({
  run: step.run,
  shell: step.shell,
  ...(step.workingDirectory === undefined ? {} : { workingDirectory: step.workingDirectory }),
});

/**
 * The `sealantd boot` process environment for a launch, in emission order (later wins, matching
 * the Docker adapter's `-e` ordering): caller env, source facts, adapter-owned boot facts, the
 * blueprint's launch env, launch-material paths, then the secret-bearing lanes (clone auth,
 * worker-resolved platform env, credential env). The MicroVM image is generic — one image
 * serves every blueprint — so lifecycle and harness facts that the Docker builder bakes into an
 * image travel here instead. Pure; pinned by the golden test.
 */
export const microvmBootEnv = (
  input: RuntimeAdapterLaunchInput,
  options: { readonly secretEnvFile: boolean; readonly dotfiles: boolean },
): Record<string, string> => {
  const { blueprint } = input;
  const entries: Array<readonly [string, string]> = [];
  for (const [key, value] of Object.entries(blueprint.runtime.userEnv ?? {})) {
    entries.push([key, value]);
  }
  const source = blueprint.sources.workspace;
  if (source.kind === "capture") {
    entries.push(...captureSourceEnv(source));
  } else if (source.kind === "git") {
    entries.push(["SEALANT_WORKSPACE_SOURCE", "git"]);
    entries.push(["SEALANT_WORKSPACE_REPO_URL", source.url]);
    if (source.ref !== undefined) {
      entries.push(["SEALANT_WORKSPACE_REPO_REF", source.ref]);
    }
  }
  entries.push(["SEALANT_WORKSPACE_ROOT", blueprint.runtime.workspaceRoot]);
  entries.push(["SEALANT_WORKING_DIRECTORY", blueprint.runtime.workingDirectory]);
  entries.push(["SEALANT_CONTROL_SOCKET", CONTROL_SOCKET_PATH]);
  entries.push(["SEALANT_OCI_RUNTIME", blueprint.runtime.ociRuntime]);
  const harness = getHarnessIntegration(blueprint.harness.id);
  if (harness !== undefined) {
    entries.push(["SEALANT_HARNESS_BANNER", `Starting ${blueprint.harness.id} workspace`]);
    entries.push(["SEALANT_HARNESS_LAUNCH_COMMAND", harness.launchCommand]);
  }
  entries.push([
    "SEALANT_LIFECYCLE_SETUP_JSON",
    JSON.stringify(blueprint.lifecycle.setup.map(toBootLifecycleStepJson)),
  ]);
  entries.push([
    "SEALANT_LIFECYCLE_STARTUP_JSON",
    JSON.stringify(blueprint.lifecycle.startup.steps.map(toBootLifecycleStepJson)),
  ]);
  const foreground = blueprint.lifecycle.startup.foreground;
  if (foreground.kind === "command") {
    entries.push([
      "SEALANT_FOREGROUND_RUN_JSON",
      JSON.stringify(toBootLifecycleStepJson(foreground)),
    ]);
  }
  for (const [key, value] of Object.entries(blueprint.runtime.env)) {
    entries.push([key, value]);
  }
  if (options.secretEnvFile) {
    entries.push(["SEALANT_SECRET_ENV_FILE", SECRET_ENV_FILE_PATH]);
  }
  if (options.dotfiles) {
    entries.push(["SEALANT_DOTFILES_ARCHIVE_DIR", DOTFILES_ARCHIVE_DIR]);
  }
  // Clone auth is read by the daemon's own boot config, so it cannot travel in the secret env
  // file (which rejects SEALANT_* names); it is process env, delivered inside the same TLS push.
  const auth = input.workspaceCloneAuth;
  if (auth?.type === "http-token") {
    entries.push(["SEALANT_WORKSPACE_HTTP_USERNAME", auth.username]);
    entries.push(["SEALANT_WORKSPACE_HTTP_TOKEN", auth.token]);
  }
  for (const [key, value] of Object.entries(input.platformEnv ?? {})) {
    entries.push([key, value]);
  }
  for (const [key, value] of Object.entries(input.credentialEnv ?? {})) {
    entries.push([key, value]);
  }
  const env: Record<string, string> = {};
  for (const [key, value] of entries) {
    env[key] = value;
  }
  return env;
};

/** The endpoint as a bare host: the API returns a hostname, the SDK sample prepends https://. */
export const endpointHost = (endpoint: string): string =>
  endpoint
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");

const isEnded = (state: MicrovmDescription["state"]): boolean =>
  state === "TERMINATING" || state === "TERMINATED";

const describeEnded = (vm: MicrovmDescription): string =>
  vm.stateReason !== undefined && vm.stateReason.trim().length > 0
    ? `${vm.state}: ${vm.stateReason.trim()}`
    : vm.state;

export class MicrovmRuntimeAdapter implements RuntimeAdapter {
  readonly id = "microvm" as const;

  readonly #config: MicrovmRuntimeConfig;
  readonly #api: MicrovmApi;
  readonly #tokens: MicrovmEndpointTokens;
  readonly #fetch: typeof fetch;
  readonly #control: ControlChannel;
  readonly #pollIntervalMs: number;
  readonly #now: () => number;

  constructor(options: MicrovmRuntimeAdapterOptions) {
    this.#config = options.config;
    this.#api = options.api;
    this.#tokens =
      options.tokens ??
      new MicrovmEndpointTokens({
        api: options.api,
        port: options.config.agentPort,
        ttlMinutes: options.config.endpointTokenTtlMinutes,
        refreshMarginMs: options.config.endpointTokenRefreshMarginMs,
        webSocketAuth: options.config.endpointWebSocketAuth,
        ...(options.now === undefined ? {} : { now: options.now }),
      });
    this.#fetch = options.fetchImpl ?? fetch;
    this.#control = options.controlChannel ?? liveControlChannel;
    this.#pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
    this.#now = options.now ?? Date.now;
  }

  get config(): MicrovmRuntimeConfig {
    return this.#config;
  }

  /** The token source; the worker shares it with its target derivation. */
  get tokens(): MicrovmEndpointTokens {
    return this.#tokens;
  }

  supports(input: RuntimeAdapterSupportInput): RuntimeAdapterSupport {
    return supportForMicrovm(parseRuntimeAdapterSupportInput(input));
  }

  async launch(input: RuntimeAdapterLaunchInput): Promise<RuntimeAdapterLaunchResult> {
    const parsed = parseRuntimeAdapterLaunchInput(input);
    const support = this.supports({ blueprint: parsed.blueprint });
    if (!support.supported) {
      throw createAdapterError(support.reason, support.message);
    }
    const runId = parsed.runId;
    if (runId === undefined) {
      throw createAdapterError(
        "unsupported-runtime-requirement",
        "The microvm adapter needs launch.runId: the MicroVM is keyed on the run so a redelivered launch adopts instead of duplicating.",
      );
    }
    if (parsed.workspaceCloneAuth?.type === "file-ref") {
      throw createAdapterError(
        "unsupported-access-mode",
        "file-ref clone auth names a key file on the worker host; the microvm adapter only takes http-token auth.",
      );
    }
    const config = this.#config;

    // Launch material: the sealed secret env (pass-through, or the host-staged boot file), and
    // any staged dotfiles, all inlined for one authenticated push. Read BEFORE RunMicrovm so a
    // staging problem never costs a VM.
    const secretEnv = parsed.secretEnv ?? (await readStagedSecretEnv(parsed.secretEnvDir));
    const dotfiles = await inlineDotfilesFromDir(parsed.dotfilesArchiveDir, "the microvm agent");
    const launchSecret = launchSecretForRun(config.controlBearerToken, runId);
    const request: AgentLaunchRequest = {
      version: AGENT_CONTRACT_VERSION,
      runId,
      controlToken: config.controlBearerToken,
      flushTimeoutMs: config.flushTimeoutMs,
      bootEnv: microvmBootEnv(parsed, {
        secretEnvFile: secretEnv !== undefined,
        dotfiles: dotfiles !== undefined,
      }),
      ...(secretEnv === undefined ? {} : { secretEnvJson: JSON.stringify(secretEnv) }),
      ...(dotfiles === undefined
        ? {}
        : { dotfiles: { manifestJson: dotfiles.manifestJson, archives: [...dotfiles.archives] } }),
    };

    const vm = await this.#api.runMicrovm(buildRunInput(config, runId, launchSecret));
    const microvmId = vm.microvmId;
    const release = this.#tokens.hold(microvmId);
    try {
      const deadline = this.#now() + config.readinessTimeoutMs;
      const running = await this.#awaitRunning(microvmId, runId, deadline);
      const endpoint = running.endpoint ?? vm.endpoint;
      if (endpoint === undefined || endpoint.trim().length === 0) {
        throw createAdapterError(
          "adapter-unavailable",
          `MicroVM ${microvmId} for run ${runId} is RUNNING but has no inbound endpoint; the image must run with an ingress connector (${config.ingressNetworkConnector}).`,
        );
      }
      const host = endpointHost(endpoint);
      await this.#pushLaunchMaterial(host, microvmId, runId, launchSecret, request, deadline);
      const target = this.#controlTarget(host, microvmId);
      await this.#awaitHealthy(target, microvmId, runId, deadline);
      if (parsed.credentialFiles !== undefined && parsed.credentialFiles.length > 0) {
        await this.#control.writeCredentialFiles(target, parsed.credentialFiles);
      }
      return {
        adapter: this.id,
        resourceId: microvmId,
        reference: microvmId,
        status: "ready",
        endpoint: `wss://${host}${AGENT_CONTROL_ROUTE}`,
      };
    } catch (error) {
      await this.#api.terminateMicrovm(microvmId).catch(() => undefined);
      this.#tokens.forget(microvmId);
      throw error;
    } finally {
      release();
    }
  }

  async stop(input: RuntimeAdapterStopInput): Promise<RuntimeAdapterStopResult> {
    const parsed = parseRuntimeAdapterStopInput(input);
    const microvmId = parsed.resourceId;
    const existing = await this.#api.getMicrovm(microvmId);
    // The stop that INITIATES teardown reports "stopped"; any later one "not-found" (a
    // TERMINATING VM is one the platform is already tearing down). TerminateMicrovm is
    // idempotent on the platform, so the call below is safe either way.
    const alreadyEnded = existing === undefined || isEnded(existing.state);
    const terminated = await this.#api.terminateMicrovm(microvmId);
    const outcome = alreadyEnded || terminated === "not-found" ? "not-found" : "stopped";
    if (parsed.fence === true) {
      await this.#awaitTerminated(microvmId);
    }
    this.#tokens.forget(microvmId);
    return { adapter: this.id, resourceId: microvmId, outcome };
  }

  async inspect(input: RuntimeAdapterInspectInput): Promise<RuntimeAdapterInspectResult> {
    const vm = await this.#api.getMicrovm(input.resourceId);
    if (vm === undefined) {
      return { state: "missing" };
    }
    if (isEnded(vm.state)) {
      // The platform reports no exit code for a VM; the state reason is what it knows.
      return { state: "exited", detail: describeEnded(vm) };
    }
    const startedAt = vm.startedAt;
    const maxDurationSeconds = vm.maximumDurationInSeconds;
    return {
      state: "running",
      platformState: vm.state,
      ...(startedAt === undefined ? {} : { startedAt: startedAt.toISOString() }),
      ...(maxDurationSeconds === undefined ? {} : { maxDurationSeconds }),
      ...(startedAt === undefined || maxDurationSeconds === undefined
        ? {}
        : { deadline: new Date(startedAt.getTime() + maxDurationSeconds * 1000).toISOString() }),
    };
  }

  /**
   * Poll-based: GetMicrovm per watched VM every `exitPollIntervalMs`, no overlapping ticks. There
   * is no event stream and no cheap enumeration, so the watch needs `resourceIds`; without them
   * it has nothing to poll and closes at once (the caller's `inspect` sweep covers the runtime).
   */
  watchExits(input: RuntimeAdapterExitWatchInput): RuntimeAdapterExitWatch {
    const remaining = new Set(input.resourceIds ?? []);
    if (remaining.size === 0) {
      return { close: () => undefined };
    }
    let inFlight = false;
    let closed = false;
    const tick = async (): Promise<void> => {
      if (inFlight || closed) {
        return;
      }
      inFlight = true;
      try {
        for (const resourceId of Array.from(remaining)) {
          if (closed) {
            return;
          }
          let result: RuntimeAdapterInspectResult;
          try {
            result = await this.inspect({ resourceId });
          } catch (error) {
            input.onError?.(error, resourceId);
            continue;
          }
          if (result.state !== "running") {
            remaining.delete(resourceId);
            input.onExit({ resourceId, result });
          }
        }
      } finally {
        inFlight = false;
      }
      if (remaining.size === 0) {
        close();
      }
    };
    const timer = setInterval(() => {
      void tick();
    }, this.#config.exitPollIntervalMs);
    timer.unref();
    const close = (): void => {
      closed = true;
      clearInterval(timer);
    };
    return { close };
  }

  #controlTarget(host: string, microvmId: string): SealantTarget {
    return {
      kind: "websocket",
      url: `wss://${host}${AGENT_CONTROL_ROUTE}`,
      auth: { bearerToken: this.#config.controlBearerToken },
      prepare: this.#tokens.connectMaterial(microvmId),
    };
  }

  async #awaitRunning(
    microvmId: string,
    runId: string,
    deadline: number,
  ): Promise<MicrovmDescription> {
    for (;;) {
      const vm = await this.#api.getMicrovm(microvmId);
      if (vm === undefined) {
        throw createAdapterError(
          "adapter-unavailable",
          `MicroVM ${microvmId} for run ${runId} disappeared while starting.`,
        );
      }
      if (vm.state === "RUNNING") {
        return vm;
      }
      if (isEnded(vm.state)) {
        throw createAdapterError(
          "adapter-unavailable",
          `MicroVM ${microvmId} for run ${runId} ended before it became ready: ${describeEnded(vm)}.`,
        );
      }
      if (this.#now() > deadline) {
        throw createAdapterError(
          "adapter-unavailable",
          `MicroVM ${microvmId} for run ${runId} was not RUNNING within ${String(this.#config.readinessTimeoutMs)} ms (last state ${vm.state}).`,
        );
      }
      await sleep(this.#pollIntervalMs);
    }
  }

  /**
   * Deliver the launch material to the agent. The endpoint routes only after the /run hook has
   * answered, and the proxy answers 502 while the agent is not yet reachable, so both a failed
   * fetch and a 502/503/504 are retried until the deadline; the VM's state is checked between
   * tries so a VM that died surfaces as such, not as a timeout.
   */
  async #pushLaunchMaterial(
    host: string,
    microvmId: string,
    runId: string,
    launchSecret: string,
    request: AgentLaunchRequest,
    deadline: number,
  ): Promise<void> {
    const body = JSON.stringify(request);
    let lastError: string | undefined;
    for (;;) {
      let response: Response | undefined;
      try {
        response = await this.#fetch(`https://${host}${AGENT_LAUNCH_ROUTE}`, {
          method: "POST",
          headers: {
            ...(await this.#tokens.headers(microvmId)),
            authorization: `Bearer ${launchSecret}`,
            "content-type": "application/json",
          },
          body,
        });
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      if (response !== undefined) {
        if (response.ok) {
          const outcome = agentLaunchResponseSchema.parse(await response.json()).outcome;
          void outcome; // "booting" and "already-booted" both continue to readiness.
          return;
        }
        if (response.status === 409) {
          return; // an earlier delivery of this launch already booted the daemon: adopt.
        }
        if (![502, 503, 504].includes(response.status)) {
          const message = await response
            .json()
            .then((payload) => agentErrorResponseSchema.parse(payload).message)
            .catch(() => `the endpoint answered ${response.status} with no readable message`);
          throw createAdapterError(
            "adapter-unavailable",
            `Delivering launch material to MicroVM ${microvmId} for run ${runId} failed: ${message}.`,
          );
        }
        lastError = `the endpoint answered ${response.status}`;
      }
      const vm = await this.#api.getMicrovm(microvmId);
      if (vm === undefined || isEnded(vm.state)) {
        throw createAdapterError(
          "adapter-unavailable",
          `MicroVM ${microvmId} for run ${runId} ended before it accepted its launch material: ${vm === undefined ? "gone" : describeEnded(vm)}.`,
        );
      }
      if (this.#now() > deadline) {
        throw createAdapterError(
          "adapter-unavailable",
          `MicroVM ${microvmId} for run ${runId} did not accept its launch material within ${String(this.#config.readinessTimeoutMs)} ms: ${lastError ?? "no response"}.`,
        );
      }
      await sleep(this.#pollIntervalMs);
    }
  }

  async #awaitHealthy(
    target: SealantTarget,
    microvmId: string,
    runId: string,
    deadline: number,
  ): Promise<void> {
    let lastError: unknown;
    while (this.#now() <= deadline) {
      try {
        await this.#control.health(target);
        return;
      } catch (error) {
        lastError = error;
        const vm = await this.#api.getMicrovm(microvmId);
        if (vm === undefined || isEnded(vm.state)) {
          throw createAdapterError(
            "adapter-unavailable",
            `MicroVM ${microvmId} for run ${runId} ended before its control channel answered: ${vm === undefined ? "gone" : describeEnded(vm)}.`,
          );
        }
        await sleep(this.#pollIntervalMs);
      }
    }
    throw createAdapterError(
      "adapter-unavailable",
      `sealantd in MicroVM ${microvmId} did not answer over ${target.kind === "websocket" ? target.url : "the control channel"} within ${String(this.#config.readinessTimeoutMs)} ms: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  }

  /** Fence: the VM must be TERMINATED (or gone) before a replacement may claim its worktree. */
  async #awaitTerminated(microvmId: string): Promise<void> {
    const deadline = this.#now() + this.#config.terminateTimeoutMs;
    for (;;) {
      const vm = await this.#api.getMicrovm(microvmId);
      if (vm === undefined || vm.state === "TERMINATED") {
        return;
      }
      if (this.#now() > deadline) {
        throw createAdapterError(
          "adapter-unavailable",
          `MicroVM ${microvmId} was still ${vm.state} ${String(this.#config.terminateTimeoutMs)} ms after TerminateMicrovm; the fence is not confirmed.`,
        );
      }
      await sleep(this.#pollIntervalMs);
    }
  }
}

/** The host-staged boot file (`launch-material.ts`), when the stager did not pass it through. */
const readStagedSecretEnv = async (
  secretEnvDir: string | undefined,
): Promise<Record<string, string> | undefined> => {
  if (secretEnvDir === undefined) {
    return undefined;
  }
  const parsed: unknown = JSON.parse(await readFile(path.join(secretEnvDir, "env.json"), "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${secretEnvDir}/env.json is not a JSON object.`);
  }
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "string") {
      throw new Error(`${secretEnvDir}/env.json entry ${key} is not a string.`);
    }
    env[key] = value;
  }
  return env;
};
