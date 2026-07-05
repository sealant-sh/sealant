import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { readFile, stat } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { join as joinPath } from "node:path";
import { promisify } from "node:util";

import {
  parseRuntimeAdapterLaunchInput,
  parseRuntimeAdapterLaunchResult,
  parseRuntimeAdapterSupportInput,
  parseRuntimeAdapterSupport,
  type SandboxCloneAuth,
  type RuntimeAdapterSupportInput,
  type RuntimeAdapter,
  type RuntimeAdapterLaunchInput,
  type RuntimeAdapterLaunchResult,
  type RuntimeAdapterSupport,
} from "./runtime-adapter.js";

const execFileAsync = promisify(execFile);

/**
 * In-container path of the daemon control socket the sandbox entrypoint (`sealantd boot`) listens on.
 * Mirrors `DEFAULT_CONTROL_SOCKET_PATH` in `sealantd/target.ts`; the gateway reaches this over the
 * docker-exec/socat relay (gateway-spec §2.1).
 */
const CONTROL_SOCKET_CONTAINER_PATH = "/run/sealant/control.sock";

/** Readiness-probe cadence and default budget (overridable via DockerRuntimeAdapterOptions). */
const READINESS_POLL_INTERVAL_MS = 250;
const DEFAULT_READINESS_TIMEOUT_MS = 120_000;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface DockerCommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

export type DockerCommandRunner = (
  command: string,
  args: Array<string>,
) => Promise<DockerCommandResult>;

export interface DockerRuntimeCatalog {
  readonly defaultRuntime?: string;
  readonly runtimes: ReadonlySet<string>;
}

export type DockerSshEndpointExposureStrategy = "host-published" | "container-network";

export type DockerRuntimeCatalogLoader = () => Promise<DockerRuntimeCatalog>;

export interface DockerRuntimeAdapterOptions {
  readonly commandRunner?: DockerCommandRunner;
  readonly runtimeCatalogLoader?: DockerRuntimeCatalogLoader;
  readonly containerNamePrefix?: string;
  readonly autoRemove?: boolean;
  readonly verifyRunning?: boolean;
  /**
   * Max time to wait for the in-sandbox daemon's control socket to start accepting after the container
   * is up (the readiness probe in `launch`). Must exceed the worst-case `git clone` + boot; defaults to
   * 120s. Probing is gated on `verifyRunning`.
   */
  readonly readinessTimeoutMs?: number;
  /**
   * @deprecated The inner sshd was removed (gateway-spec §4.3): the gateway reaches the daemon control
   * socket, not an inner sshd, so no SSH port is published and this host has no effect. Retained on the
   * options shape only so existing callers (worker env wiring) keep type-checking; remove once the
   * worker drops the env var.
   */
  readonly sshBindHost?: string;
  /**
   * @deprecated Inner sshd removed (gateway-spec §4.3); there is no longer an `ssh://` endpoint to
   * publish or discover, so the exposure strategy has no effect. Retained for caller compatibility.
   */
  readonly sshEndpointExposureStrategy?: DockerSshEndpointExposureStrategy;
  readonly dockerSocketPath?: string;
  /**
   * Opt-in control-socket bind-mount fast path (gateway-spec §2.2). When set, the adapter bind-mounts
   * `<controlSocketHostDir>/<containerName>` (created 0700) at `/run/sealant` inside the container, so
   * the gateway can `net.connect` the daemon's `control.sock` directly on the host instead of bridging
   * with `docker exec` + socat. This requires the daemon to allow the gateway's host uid
   * (`SEALANT_ALLOWED_PEER_UIDS`); leave unset to keep the universal docker-exec reach (§2.1).
   */
  readonly controlSocketHostDir?: string;
}

const createDefaultCommandRunner = (dockerSocketPath: string): DockerCommandRunner => {
  return async (command, args) => {
    const result = await execFileAsync(command, args, {
      maxBuffer: 1024 * 1024 * 10,
      env: {
        ...process.env,
        DOCKER_HOST: `unix://${dockerSocketPath}`,
      },
    });

    return {
      stdout: result.stdout,
      stderr: result.stderr,
    };
  };
};

const loadRuntimeCatalogFromDockerSocket = async (
  dockerSocketPath: string,
): Promise<DockerRuntimeCatalog> => {
  const body = await new Promise<string>((resolve, reject) => {
    const request = httpRequest(
      {
        socketPath: dockerSocketPath,
        path: "/info",
        method: "GET",
      },
      (response) => {
        if (response.statusCode === undefined) {
          reject(createAdapterError("adapter-unavailable", "Docker info returned no status code."));
          return;
        }

        let responseBody = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          responseBody += chunk;
        });
        response.on("end", () => {
          if (response.statusCode !== 200) {
            reject(
              createAdapterError(
                "adapter-unavailable",
                `Docker info request failed with status ${response.statusCode}.`,
              ),
            );
            return;
          }

          resolve(responseBody);
        });
      },
    );

    request.on("error", (error) => {
      reject(
        createAdapterError(
          "adapter-unavailable",
          `Docker info request failed on socket '${dockerSocketPath}': ${error.message}`,
        ),
      );
    });
    request.end();
  });

  let parsedInfo: unknown;
  try {
    parsedInfo = JSON.parse(body);
  } catch {
    throw createAdapterError("adapter-unavailable", "Docker info returned invalid JSON.");
  }

  const info =
    typeof parsedInfo === "object" && parsedInfo !== null
      ? (parsedInfo as { DefaultRuntime?: unknown; Runtimes?: unknown })
      : undefined;
  const runtimes =
    info !== undefined && typeof info.Runtimes === "object" && info.Runtimes !== null
      ? new Set(Object.keys(info.Runtimes as Record<string, unknown>))
      : new Set<string>();
  const defaultRuntime = typeof info?.DefaultRuntime === "string" ? info.DefaultRuntime : undefined;

  return {
    ...(defaultRuntime === undefined ? {} : { defaultRuntime }),
    runtimes,
  };
};

const createAdapterError = (code: string, message: string): Error & { code: string } => {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
};

const normalizeContainerToken = (value: string): string => {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, 48);
};

const buildContainerName = (input: RuntimeAdapterLaunchInput, prefix: string): string => {
  // Deterministic per-run name: a redelivered / reaper-republished / concurrent launch of the SAME
  // run resolves to the SAME container (find-or-create/adopt), never a duplicate (#4 double-launch).
  // We deliberately key on runId ONLY (no image/epoch suffix) so there is exactly one container per run.
  if (input.runId !== undefined) {
    const runToken = normalizeContainerToken(input.runId) || "run";
    return `${prefix}-${runToken}`;
  }
  // Fallback (no runId, e.g. ad-hoc/test launches): keep the legacy unique-per-launch name.
  const repositoryToken = normalizeContainerToken(input.publishedImage.repository) || "sandbox";
  const tagToken = normalizeContainerToken(input.publishedImage.tag) || "latest";
  const suffix = Date.now().toString(36);
  return `${prefix}-${repositoryToken}-${tagToken}-${suffix}`;
};

const envArgsFromBlueprint = (input: RuntimeAdapterLaunchInput): Array<string> => {
  const runtimeEnvArgs = Object.entries(input.blueprint.runtime.env).flatMap(([key, value]) => [
    "-e",
    `${key}=${value}`,
  ]);

  return [
    "-e",
    `SEALANT_SANDBOX_REPO_URL=${input.blueprint.sources.sandbox.url}`,
    "-e",
    `SEALANT_SANDBOX_REPO_REF=${input.blueprint.sources.sandbox.ref}`,
    "-e",
    `SEALANT_OCI_RUNTIME=${input.blueprint.runtime.ociRuntime}`,
    ...runtimeEnvArgs,
  ];
};

const supportForInput = (input: RuntimeAdapterSupportInput): RuntimeAdapterSupport => {
  const targetRuntime = input.blueprint.target.runtime.family;

  if (targetRuntime !== "auto" && targetRuntime !== "docker") {
    return parseRuntimeAdapterSupport({
      supported: false,
      reason: "unsupported-runtime",
      message: "The Docker runtime adapter only supports target.runtime.family of auto or docker.",
    });
  }

  if (input.blueprint.runtime.persistence !== "ephemeral") {
    return parseRuntimeAdapterSupport({
      supported: false,
      reason: "unsupported-runtime-requirement",
      message: "The Docker runtime adapter currently supports only ephemeral sandboxes.",
    });
  }

  if (!input.blueprint.runtime.network.outbound) {
    return parseRuntimeAdapterSupport({
      supported: false,
      reason: "unsupported-runtime-requirement",
      message: "The Docker runtime adapter currently requires outbound network access.",
    });
  }

  return parseRuntimeAdapterSupport({ supported: true });
};

export class DockerRuntimeAdapter implements RuntimeAdapter {
  public readonly id = "docker" as const;

  private readonly commandRunner: DockerCommandRunner;

  private readonly runtimeCatalogLoader: DockerRuntimeCatalogLoader;

  private readonly containerNamePrefix: string;

  private readonly autoRemove: boolean;

  private readonly verifyRunning: boolean;

  private readonly readinessTimeoutMs: number;

  private readonly controlSocketHostDir: string | undefined;

  public constructor(options: DockerRuntimeAdapterOptions = {}) {
    const dockerSocketPath = options.dockerSocketPath ?? "/var/run/docker.sock";

    this.commandRunner = options.commandRunner ?? createDefaultCommandRunner(dockerSocketPath);
    this.runtimeCatalogLoader =
      options.runtimeCatalogLoader ?? (() => loadRuntimeCatalogFromDockerSocket(dockerSocketPath));
    this.containerNamePrefix = options.containerNamePrefix ?? "sealant";
    this.autoRemove = options.autoRemove ?? false;
    this.verifyRunning = options.verifyRunning ?? true;
    this.readinessTimeoutMs = options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
    this.controlSocketHostDir = options.controlSocketHostDir;
  }

  /**
   * Build the `-v` args for the §2.2 control-socket bind-mount, creating the per-container host dir
   * 0700 first. Returns no args (and creates nothing) when the fast path is not enabled.
   */
  private async buildControlSocketMountArgs(containerName: string): Promise<string[]> {
    if (this.controlSocketHostDir === undefined) {
      return [];
    }
    const hostDir = joinPath(this.controlSocketHostDir, containerName);
    await mkdir(hostDir, { recursive: true, mode: 0o700 });
    return ["-v", `${hostDir}:/run/sealant`];
  }

  private async assertRuntimeConfigured(runtime: "runc" | "runsc"): Promise<void> {
    const catalog = await this.runtimeCatalogLoader();
    const availableRuntimes = [...catalog.runtimes].toSorted();

    if (catalog.runtimes.has(runtime)) {
      return;
    }

    if (runtime === "runc" && catalog.defaultRuntime === "runc") {
      return;
    }

    throw createAdapterError(
      "adapter-unavailable",
      `Docker runtime '${runtime}' is not configured on this host. Available runtimes: ${
        availableRuntimes.length === 0 ? "none reported" : availableRuntimes.join(", ")
      }`,
    );
  }

  private async resolveSandboxAuthKeyBase64(
    cloneAuth: Extract<SandboxCloneAuth, { type: "file-ref" }>,
  ): Promise<string | undefined> {
    const configuredPath = cloneAuth.path;

    if (configuredPath === undefined || configuredPath.length === 0) {
      return undefined;
    }

    let keyData: string;
    try {
      keyData = await readFile(configuredPath, "utf8");
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : `Could not read sandbox clone key file: ${configuredPath}`;
      throw createAdapterError(
        "unsupported-access-mode",
        `Sandbox clone key could not be read at '${configuredPath}': ${message}`,
      );
    }

    const trimmed = keyData.trim();
    if (trimmed.length === 0) {
      throw createAdapterError(
        "unsupported-access-mode",
        `Sandbox clone key file is empty: ${configuredPath}`,
      );
    }

    return Buffer.from(`${trimmed}\n`, "utf8").toString("base64");
  }

  private resolveSandboxCloneAuth(input: RuntimeAdapterLaunchInput): SandboxCloneAuth | undefined {
    if (input.sandboxCloneAuth !== undefined && input.sandboxCloneAuth.type !== "none") {
      return input.sandboxCloneAuth;
    }

    const configuredPath = input.blueprint.sources.sandbox.authRef;
    if (configuredPath === undefined || configuredPath.length === 0) {
      return undefined;
    }

    return {
      type: "file-ref",
      path: configuredPath,
    };
  }

  /**
   * Resolve the sandbox's *control* endpoint (gateway-spec §4.3). The inner sshd is gone — the gateway
   * no longer dials an `ssh://root@host:2222` URI; it reaches the daemon control socket. The default
   * reach is `docker exec` into the container (keyed by container id, which the adapter already returns
   * as `resourceId`). When the §2.2 bind-mount fast path is enabled, the daemon socket is reachable on
   * the host at `<controlSocketHostDir>/<containerName>/control.sock`, so we surface that path instead.
   *
   * The string is purely informational for downstream wiring: the gateway derives its `ControlTarget`
   * from the runtime `resourceId` + the fixed in-container socket path (`toControlTarget`), so the
   * control-socket reach does not depend on this value. We return a non-`ssh://` descriptor so nothing
   * mistakes the sandbox for an sshd-exposing host.
   */
  private resolveControlEndpoint(containerId: string, containerName: string): string {
    if (this.controlSocketHostDir !== undefined) {
      return `unix://${joinPath(this.controlSocketHostDir, containerName, "control.sock")}`;
    }
    return `docker-exec://${containerId}${CONTROL_SOCKET_CONTAINER_PATH}`;
  }

  private async inspectContainerState(containerId: string): Promise<{
    status: string;
    running: boolean;
    exitCode: number;
    error: string;
  }> {
    const result = await this.commandRunner("docker", [
      "inspect",
      "--format",
      "{{json .State}}",
      containerId,
    ]);

    const rawState = result.stdout.trim();
    if (rawState.length === 0) {
      throw createAdapterError(
        "adapter-unavailable",
        `Docker inspect did not return container state for '${containerId}'.`,
      );
    }

    let parsedState: unknown;
    try {
      parsedState = JSON.parse(rawState);
    } catch {
      throw createAdapterError(
        "adapter-unavailable",
        `Docker inspect returned unparseable state for '${containerId}'.`,
      );
    }

    if (
      typeof parsedState !== "object" ||
      parsedState === null ||
      typeof (parsedState as { Status?: unknown }).Status !== "string" ||
      typeof (parsedState as { Running?: unknown }).Running !== "boolean" ||
      typeof (parsedState as { ExitCode?: unknown }).ExitCode !== "number"
    ) {
      throw createAdapterError(
        "adapter-unavailable",
        `Docker inspect returned an unexpected state shape for '${containerId}'.`,
      );
    }

    return {
      status: (parsedState as { Status: string }).Status,
      running: (parsedState as { Running: boolean }).Running,
      exitCode: (parsedState as { ExitCode: number }).ExitCode,
      error:
        typeof (parsedState as { Error?: unknown }).Error === "string"
          ? (parsedState as { Error: string }).Error
          : "",
    };
  }

  private async readContainerLogs(containerId: string): Promise<string | undefined> {
    try {
      const result = await this.commandRunner("docker", ["logs", "--tail", "200", containerId]);
      const logs = [result.stdout, result.stderr]
        .filter((chunk) => chunk.trim().length > 0)
        .join("\n")
        .trim();
      return logs.length === 0 ? undefined : logs;
    } catch {
      return undefined;
    }
  }

  private async assertContainerRunning(containerId: string, containerName: string): Promise<void> {
    const state = await this.inspectContainerState(containerId);
    if (!state.running) {
      const logs = await this.readContainerLogs(containerId);
      throw createAdapterError(
        "adapter-unavailable",
        `Docker container '${containerName}' exited immediately (status: ${state.status}, exitCode: ${state.exitCode}${
          state.error.length > 0 ? `, error: ${state.error}` : ""
        }).${logs === undefined ? "" : ` Logs:\n${logs}`}`,
      );
    }
  }

  private async forceRemoveContainer(containerId: string): Promise<void> {
    await this.commandRunner("docker", ["rm", "-f", containerId]).catch(() => undefined);
  }

  private async inspectContainerByName(
    containerName: string,
  ): Promise<{ id: string; running: boolean } | undefined> {
    try {
      const result = await this.commandRunner("docker", [
        "inspect",
        "--format",
        "{{.Id}}\t{{.State.Running}}",
        containerName,
      ]);
      const [id, running] = result.stdout.trim().split("\t");
      if (id === undefined || id.length === 0) {
        return undefined;
      }
      return { id, running: running === "true" };
    } catch {
      return undefined;
    }
  }

  /**
   * `docker run` the container, or ADOPT an existing one bearing the same (deterministic, per-run)
   * name. A redelivered / reaper-republished / concurrent launch of the same run hits a `--name`
   * conflict; rather than spawn a duplicate — or fail and trip cleanup that clobbers the good runtime
   * row — we adopt the live container, or clear a dead one and retry the run exactly once. This makes
   * launch idempotent per run (#4) and is the safety net that lets Stage 2's reaper republish freely.
   */
  private async runOrAdoptContainer(args: Array<string>, containerName: string): Promise<string> {
    const runOnce = async (): Promise<string> => {
      const result = await this.commandRunner("docker", args);
      const id = result.stdout.trim();
      if (id.length === 0) {
        throw createAdapterError(
          "adapter-unavailable",
          "Docker run did not return a container id.",
        );
      }
      return id;
    };
    try {
      return await runOnce();
    } catch (error) {
      // The most likely cause is a `--name` conflict from a prior launch of this run. If a container
      // with that name exists, adopt it (live) or clear it and retry once (dead). Otherwise re-raise.
      const existing = await this.inspectContainerByName(containerName);
      if (existing === undefined) {
        throw error;
      }
      if (existing.running) {
        return existing.id;
      }
      await this.forceRemoveContainer(existing.id);
      return runOnce();
    }
  }

  /**
   * True once the daemon control socket is ACCEPTING. The default reach probes inside the container
   * (`docker exec test -S`); the §2.2 bind-mount fast path stats the socket on the host instead.
   */
  private async isControlSocketAccepting(
    containerId: string,
    containerName: string,
  ): Promise<boolean> {
    if (this.controlSocketHostDir !== undefined) {
      try {
        const stats = await stat(
          joinPath(this.controlSocketHostDir, containerName, "control.sock"),
        );
        return stats.isSocket();
      } catch {
        return false;
      }
    }
    try {
      await this.commandRunner("docker", [
        "exec",
        containerId,
        "test",
        "-S",
        CONTROL_SOCKET_CONTAINER_PATH,
      ]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Block until the sandbox's control socket is accepting — the HONEST readiness signal. `sealantd`
   * binds the socket only after `rm -rf` + `git clone` + runtime-health, so "container running"
   * precedes "socket accepting" by (mostly) the clone duration. Polls within a bounded budget; fails
   * fast if the container exits during boot (e.g. clone failure -> daemon exit 1). On any failure the
   * orphan container is force-removed so a recorded "failed" runtime instance has no dangling container.
   */
  private async awaitControlSocketReady(containerId: string, containerName: string): Promise<void> {
    const deadline = Date.now() + this.readinessTimeoutMs;
    for (;;) {
      if (await this.isControlSocketAccepting(containerId, containerName)) {
        return;
      }

      const state = await this.inspectContainerState(containerId).catch(() => undefined);
      if (state !== undefined && !state.running) {
        const logs = await this.readContainerLogs(containerId);
        await this.forceRemoveContainer(containerId);
        throw createAdapterError(
          "adapter-unavailable",
          `Sandbox container '${containerName}' exited during boot before its control socket was ready (status: ${state.status}, exitCode: ${state.exitCode}).${
            logs === undefined ? "" : ` Logs:\n${logs}`
          }`,
        );
      }

      if (Date.now() > deadline) {
        const logs = await this.readContainerLogs(containerId);
        await this.forceRemoveContainer(containerId);
        throw createAdapterError(
          "adapter-unavailable",
          `Sandbox container '${containerName}' control socket did not become ready within ${this.readinessTimeoutMs}ms.${
            logs === undefined ? "" : ` Logs:\n${logs}`
          }`,
        );
      }

      await delay(READINESS_POLL_INTERVAL_MS);
    }
  }

  public supports(input: RuntimeAdapterSupportInput): RuntimeAdapterSupport {
    // SSH access needs no key material here: the gateway reaches the sandbox over the daemon
    // control socket (gateway-spec §2), and client keys are authorized against the control plane.
    const parsed = parseRuntimeAdapterSupportInput(input);
    return supportForInput(parsed);
  }

  public async launch(input: RuntimeAdapterLaunchInput): Promise<RuntimeAdapterLaunchResult> {
    const parsed = parseRuntimeAdapterLaunchInput(input);
    const support = this.supports({
      blueprint: parsed.blueprint,
    });

    if (!support.supported) {
      throw createAdapterError(support.reason, support.message);
    }

    await this.assertRuntimeConfigured(parsed.blueprint.runtime.ociRuntime);

    const containerName = buildContainerName(parsed, this.containerNamePrefix);
    const imageReference = parsed.publishedImage.digestReference;
    // SSH "access" now means the gateway should be able to reach a shell over the daemon control
    // socket — it no longer publishes/injects an inner sshd (gateway-spec §4.3). The control reach is
    // always available via `docker exec` (or the §2.2 bind-mount), so no SSH port or `SEALANT_SSH_*`
    // env is plumbed here.
    const sshEnabled = parsed.blueprint.access.ssh.enabled;
    const sandboxCloneAuth = this.resolveSandboxCloneAuth(parsed);
    const sandboxAuthKeyBase64 =
      sandboxCloneAuth?.type === "file-ref"
        ? await this.resolveSandboxAuthKeyBase64(sandboxCloneAuth)
        : undefined;
    const sandboxAuthEnvArgs =
      sandboxAuthKeyBase64 === undefined
        ? []
        : ["-e", `SEALANT_SANDBOX_AUTH_KEY_BASE64=${sandboxAuthKeyBase64}`];
    const sandboxHttpAuthEnvArgs =
      sandboxCloneAuth?.type !== "http-token"
        ? []
        : [
            "-e",
            `SEALANT_SANDBOX_HTTP_USERNAME=${sandboxCloneAuth.username}`,
            "-e",
            `SEALANT_SANDBOX_HTTP_TOKEN=${sandboxCloneAuth.token}`,
          ];
    // §2.2 opt-in fast path: bind-mount the daemon's socket *parent dir* to a per-container host dir
    // so the gateway can connect directly. We mount the parent (the daemon creates control.sock
    // inside it) and create the host dir 0700 to the gateway/worker uid before `docker run`.
    const controlSocketMountArgs = await this.buildControlSocketMountArgs(containerName);
    const args = [
      "run",
      "-d",
      "--runtime",
      parsed.blueprint.runtime.ociRuntime,
      "--name",
      containerName,
      "-w",
      parsed.blueprint.runtime.workingDirectory,
      ...sandboxAuthEnvArgs,
      ...sandboxHttpAuthEnvArgs,
      ...controlSocketMountArgs,
      ...envArgsFromBlueprint(parsed),
      imageReference,
    ];
    if (this.autoRemove) {
      args.splice(2, 0, "--rm");
    }
    const containerId = await this.runOrAdoptContainer(args, containerName);

    if (this.verifyRunning) {
      await this.assertContainerRunning(containerId, containerName);
      // Don't report a launch as done until the daemon's control socket is actually accepting —
      // otherwise the control plane reports "ready" before the socket binds (the readiness TOCTOU
      // that surfaced as intermittent "connection closed" in harness.run()).
      await this.awaitControlSocketReady(containerId, containerName);
    }

    // §4.3: the endpoint is now the daemon *control* target (not an `ssh://` URI). The gateway still
    // reaches the daemon via the runtime `resourceId` (container id) + the fixed in-container socket
    // path, so this descriptor is informational; it just must never advertise an sshd host.
    const endpoint =
      sshEnabled === true ? this.resolveControlEndpoint(containerId, containerName) : undefined;

    return parseRuntimeAdapterLaunchResult({
      adapter: this.id,
      resourceId: containerId,
      reference: containerName,
      // "ready" (not "running"): the readiness probe above proved the control socket accepts.
      status: "ready",
      ...(endpoint === undefined ? {} : { endpoint }),
    });
  }
}
