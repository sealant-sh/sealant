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
import { CAPTURE_HARNESS_HOME_ENV, captureSourceEnv } from "../capture-source.js";
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
  AGENT_HEALTH_ROUTE,
  AGENT_LAUNCH_ROUTE,
  agentHealthResponseSchema,
  agentLaunchResponseSchema,
  CONTROL_SOCKET_PATH,
  DOCKER_AGENT_CONTRACT_VERSION,
  DOCKER_SOCKET_PATH,
  DOTFILES_ARCHIVE_DIR,
  launchSecretForRun,
  SECRET_ENV_FILE_PATH,
  type AgentHealthResponse,
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
const RUN_HOOK_PAYLOAD_MAX_BYTES = 4_096;

const createAdapterError = (code: string, message: string): Error & { code: string } =>
  Object.assign(new Error(message), { code });

/** Docker client selection belongs to the guest service; launch material cannot redirect it. */
const MICROVM_DOCKER_RESERVED_ENV_NAMES = [
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_TLS_CERTDIR",
  "DOCKER_TLS_VERIFY",
  "DOCKER_CERT_PATH",
] as const;

type MicrovmDockerFailureReason =
  | "spawn-failed"
  | "directory-preparation-failed"
  | "readiness-timeout"
  | "exited"
  | "probe-failed";

interface MicrovmGuestFailureDetails {
  readonly failureReason?: MicrovmDockerFailureReason | undefined;
  readonly guestExitCode?: number | null | undefined;
  readonly guestSignal?: string | null | undefined;
}

const SAFE_GUEST_SIGNALS: ReadonlySet<string> = new Set([
  "SIGABRT",
  "SIGALRM",
  "SIGBUS",
  "SIGCHLD",
  "SIGCONT",
  "SIGFPE",
  "SIGHUP",
  "SIGILL",
  "SIGINT",
  "SIGIO",
  "SIGKILL",
  "SIGPIPE",
  "SIGPROF",
  "SIGPWR",
  "SIGQUIT",
  "SIGSEGV",
  "SIGSTOP",
  "SIGSYS",
  "SIGTERM",
  "SIGTRAP",
  "SIGTSTP",
  "SIGTTIN",
  "SIGTTOU",
  "SIGURG",
  "SIGUSR1",
  "SIGUSR2",
  "SIGVTALRM",
  "SIGWINCH",
  "SIGXCPU",
  "SIGXFSZ",
]);

const safeGuestSignal = (signal: string | null): string | null | undefined =>
  signal === null ? null : SAFE_GUEST_SIGNALS.has(signal) ? signal : undefined;

class MicrovmGuestFailure extends Error {
  override readonly name = "MicrovmGuestFailure";
  readonly code = "microvm-guest-failed" as const;
  readonly failureReason: MicrovmDockerFailureReason | undefined;
  readonly guestExitCode: number | null | undefined;
  readonly guestSignal: string | null | undefined;

  constructor(
    readonly phase: "protocol" | "sealantd" | "docker",
    message: string,
    details: MicrovmGuestFailureDetails = {},
  ) {
    super(message);
    this.failureReason = details.failureReason;
    this.guestExitCode = details.guestExitCode;
    this.guestSignal = details.guestSignal;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const wantsDockerService = (input: RuntimeAdapterSupportInput): boolean =>
  input.blueprint.tooling.services?.docker?.enabled === true;

/** The support decision, pure. */
export const supportForMicrovm = (
  config: Pick<MicrovmRuntimeConfig, "dockerImage">,
  input: RuntimeAdapterSupportInput,
): RuntimeAdapterSupport => {
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
  if (wantsDockerService(input) && config.dockerImage === undefined) {
    return {
      supported: false,
      reason: "unsupported-runtime-requirement",
      message:
        "Workspace-scoped Docker needs a separate Docker-capable Lambda MicroVM image (SEALANT_MICROVM_DOCKER_IMAGE_ARN and SEALANT_MICROVM_DOCKER_IMAGE_VERSION).",
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
  options: { readonly dockerService: "disabled" | "required" },
): MicrovmRunInput => {
  const dockerImage = options.dockerService === "required" ? config.dockerImage : undefined;
  if (options.dockerService === "required" && dockerImage === undefined) {
    throw createAdapterError(
      "unsupported-runtime-requirement",
      "A Docker-enabled MicroVM launch needs SEALANT_MICROVM_DOCKER_IMAGE_ARN and SEALANT_MICROVM_DOCKER_IMAGE_VERSION.",
    );
  }
  const payload: RunHookPayload =
    options.dockerService === "required"
      ? {
          version: DOCKER_AGENT_CONTRACT_VERSION,
          runId,
          launchSecret,
          services: { docker: "required" },
        }
      : { version: AGENT_CONTRACT_VERSION, runId, launchSecret };
  const runHookPayload = JSON.stringify(payload);
  if (Buffer.byteLength(runHookPayload, "utf8") > RUN_HOOK_PAYLOAD_MAX_BYTES) {
    throw createAdapterError(
      "unsupported-runtime-requirement",
      `The Lambda MicroVM run-hook payload exceeds the ${String(RUN_HOOK_PAYLOAD_MAX_BYTES)}-byte platform limit.`,
    );
  }
  return {
    imageIdentifier: dockerImage?.arn ?? config.imageArn,
    ...((dockerImage?.version ?? config.imageVersion) === undefined
      ? {}
      : { imageVersion: dockerImage?.version ?? config.imageVersion }),
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
    runHookPayload,
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
    // `git` is Core's blueprint term; pinned sealantd v0.16.0 names this wire mode `clone`.
    entries.push(["SEALANT_WORKSPACE_SOURCE", "clone"]);
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
    if (
      source.kind === "capture" &&
      source.harnessHome !== undefined &&
      key === CAPTURE_HARNESS_HOME_ENV
    ) {
      continue;
    }
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
  // Service-owned and last-wins over every plaintext lane. The v2 agent pins the same five values
  // before boot, and both Core and the agent reject them in secretEnvJson.
  if (blueprint.tooling.services?.docker?.enabled === true) {
    entries.push(["DOCKER_HOST", `unix://${DOCKER_SOCKET_PATH}`]);
    entries.push(["DOCKER_CONTEXT", ""]);
    entries.push(["DOCKER_TLS_CERTDIR", ""]);
    entries.push(["DOCKER_TLS_VERIFY", ""]);
    entries.push(["DOCKER_CERT_PATH", ""]);
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
    return supportForMicrovm(this.#config, parseRuntimeAdapterSupportInput(input));
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
    const dockerService = parsed.blueprint.tooling.services?.docker?.enabled === true;
    if (dockerService && secretEnv !== undefined) {
      const reservedDockerName = MICROVM_DOCKER_RESERVED_ENV_NAMES.find((name) =>
        Object.hasOwn(secretEnv, name),
      );
      if (reservedDockerName !== undefined) {
        throw createAdapterError(
          "unsupported-runtime-requirement",
          `The Docker-enabled MicroVM launch secret environment cannot set reserved variable ${reservedDockerName}.`,
        );
      }
    }
    const requestFields = {
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
    const request: AgentLaunchRequest = dockerService
      ? {
          version: DOCKER_AGENT_CONTRACT_VERSION,
          ...requestFields,
          services: { docker: "required" },
        }
      : { version: AGENT_CONTRACT_VERSION, ...requestFields };

    const vm = await this.#api.runMicrovm(
      buildRunInput(config, runId, launchSecret, {
        dockerService: dockerService ? "required" : "disabled",
      }),
    );
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
      await this.#awaitHealthy(target, host, microvmId, runId, dockerService, deadline);
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
    if (vm.state === "RUNNING" && vm.endpoint !== undefined && vm.endpoint.trim().length > 0) {
      const health = await this.#readAgentHealth(endpointHost(vm.endpoint), input.resourceId);
      const failure = this.#guestFailure(health, false);
      if (failure !== undefined) {
        return {
          state: "exited",
          ...(failure.exitCode === undefined ? {} : { exitCode: failure.exitCode }),
          detail: failure.message,
        };
      }
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
      } catch {
        lastError = "the endpoint request failed";
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
          throw createAdapterError(
            "adapter-unavailable",
            `Delivering launch material to MicroVM ${microvmId} for run ${runId} failed with HTTP ${String(response.status)}.`,
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

  async #readAgentHealth(host: string, microvmId: string): Promise<AgentHealthResponse> {
    let response: Response;
    try {
      response = await this.#fetch(`https://${host}${AGENT_HEALTH_ROUTE}`, {
        method: "GET",
        headers: {
          ...(await this.#tokens.headers(microvmId)),
          authorization: `Bearer ${this.#config.controlBearerToken}`,
        },
      });
    } catch {
      throw new Error(`MicroVM ${microvmId} agent health request failed.`);
    }
    if ([200, 503].includes(response.status)) {
      const payload: unknown = await response.json().catch(() => undefined);
      const parsed = agentHealthResponseSchema.safeParse(payload);
      if (parsed.success) {
        return parsed.data;
      }
      // A proxy 503 may carry HTML or its own JSON. Without a valid agent body there is no
      // authenticated guest state to fail on. Keep the error sanitized and let readiness retry;
      // inspect propagates it as an observation error rather than inventing an exit.
      throw new Error(
        response.status === 503
          ? `MicroVM ${microvmId} agent health is not reachable through the endpoint yet (HTTP 503 without a valid health body).`
          : `MicroVM ${microvmId} agent health returned an invalid contract body.`,
      );
    }
    if (response.status === 502 || response.status === 504) {
      throw new Error(
        `MicroVM ${microvmId} agent health is not reachable through the endpoint yet (HTTP ${String(response.status)}).`,
      );
    }
    throw new Error(
      `MicroVM ${microvmId} agent health failed with HTTP ${String(response.status)} and no valid health body.`,
    );
  }

  #guestFailure(
    health: AgentHealthResponse,
    dockerRequired: boolean,
  ):
    | {
        readonly phase: "protocol" | "sealantd" | "docker";
        readonly message: string;
        readonly exitCode?: number;
        readonly failureReason?: MicrovmDockerFailureReason;
        readonly guestExitCode?: number | null;
        readonly guestSignal?: string | null;
      }
    | undefined {
    if (health.daemonExit !== undefined) {
      const signal = safeGuestSignal(health.daemonExit.signal);
      const signalText = signal === undefined ? "unrecognized" : String(signal);
      return {
        phase: "sealantd",
        message: `sealantd in the MicroVM exited before the workspace stopped (code ${String(health.daemonExit.code)}, signal ${signalText}).`,
        ...(health.daemonExit.code === null ? {} : { exitCode: health.daemonExit.code }),
        guestExitCode: health.daemonExit.code,
        ...(signal === undefined ? {} : { guestSignal: signal }),
      };
    }
    if ("version" in health && health.services.docker.status === "failed") {
      const docker = health.services.docker;
      const signal = safeGuestSignal(docker.signal);
      const signalText = signal === undefined ? "unrecognized" : String(signal);
      return {
        phase: "docker",
        message: `Guest-local Docker failed in the MicroVM (${docker.reason}; code ${String(docker.code)}, signal ${signalText}).`,
        ...(docker.code === null ? {} : { exitCode: docker.code }),
        failureReason: docker.reason,
        guestExitCode: docker.code,
        ...(signal === undefined ? {} : { guestSignal: signal }),
      };
    }
    if (dockerRequired && !("version" in health)) {
      return {
        phase: "protocol",
        message:
          "The Docker-enabled MicroVM answered with the legacy agent health contract; the configured image is not Docker-capable.",
      };
    }
    return undefined;
  }

  async #awaitHealthy(
    target: SealantTarget,
    host: string,
    microvmId: string,
    runId: string,
    dockerRequired: boolean,
    deadline: number,
  ): Promise<void> {
    while (this.#now() <= deadline) {
      try {
        const health = await this.#readAgentHealth(host, microvmId);
        const failure = this.#guestFailure(health, dockerRequired);
        if (failure !== undefined) {
          throw new MicrovmGuestFailure(
            failure.phase,
            `MicroVM ${microvmId} for run ${runId} failed guest readiness: ${failure.message}`,
            {
              failureReason: failure.failureReason,
              guestExitCode: failure.guestExitCode,
              guestSignal: failure.guestSignal,
            },
          );
        }
        const dockerReady =
          !dockerRequired || ("version" in health && health.services.docker.status === "ready");
        if (health.booted && health.controlSocket && dockerReady) {
          await this.#control.health(target);
          return;
        }
      } catch (error) {
        if (error instanceof MicrovmGuestFailure) {
          throw error;
        }
      }
      const vm = await this.#api.getMicrovm(microvmId);
      if (vm === undefined || isEnded(vm.state)) {
        throw createAdapterError(
          "adapter-unavailable",
          `MicroVM ${microvmId} for run ${runId} ended before its control channel answered: ${vm === undefined ? "gone" : describeEnded(vm)}.`,
        );
      }
      await sleep(this.#pollIntervalMs);
    }
    throw createAdapterError(
      "adapter-unavailable",
      `sealantd in MicroVM ${microvmId} did not become ready within ${String(this.#config.readinessTimeoutMs)} ms.`,
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
  const raw = await readFile(path.join(secretEnvDir, "env.json"), "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${secretEnvDir}/env.json is not valid JSON.`);
  }
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
