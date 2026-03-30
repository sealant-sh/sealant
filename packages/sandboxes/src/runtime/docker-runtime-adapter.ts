import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
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
  readonly defaultSshAuthorizedKeysFile?: string;
  readonly sshBindHost?: string;
  readonly sshEndpointExposureStrategy?: DockerSshEndpointExposureStrategy;
  readonly dockerSocketPath?: string;
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

  private readonly defaultSshAuthorizedKeysFile: string | undefined;

  private readonly sshBindHost: string;

  private readonly sshEndpointExposureStrategy: DockerSshEndpointExposureStrategy;

  public constructor(options: DockerRuntimeAdapterOptions = {}) {
    const dockerSocketPath = options.dockerSocketPath ?? "/var/run/docker.sock";

    this.commandRunner = options.commandRunner ?? createDefaultCommandRunner(dockerSocketPath);
    this.runtimeCatalogLoader =
      options.runtimeCatalogLoader ?? (() => loadRuntimeCatalogFromDockerSocket(dockerSocketPath));
    this.containerNamePrefix = options.containerNamePrefix ?? "sealant";
    this.autoRemove = options.autoRemove ?? false;
    this.verifyRunning = options.verifyRunning ?? true;
    this.defaultSshAuthorizedKeysFile = options.defaultSshAuthorizedKeysFile;
    this.sshBindHost = options.sshBindHost ?? "127.0.0.1";
    this.sshEndpointExposureStrategy = options.sshEndpointExposureStrategy ?? "host-published";
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

  private async resolveAuthorizedKeysBase64(input: RuntimeAdapterLaunchInput): Promise<string> {
    const configuredPath =
      input.blueprint.access.ssh.authorizedKeysRef ?? this.defaultSshAuthorizedKeysFile;

    if (configuredPath === undefined || configuredPath.length === 0) {
      throw createAdapterError(
        "unsupported-access-mode",
        "SSH is enabled but no authorized keys file is configured.",
      );
    }

    let keyData: string;
    try {
      keyData = await readFile(configuredPath, "utf8");
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : `Could not read SSH authorized keys file: ${configuredPath}`;
      throw createAdapterError(
        "unsupported-access-mode",
        `SSH authorized keys file could not be read at '${configuredPath}': ${message}`,
      );
    }
    const trimmed = keyData.trim();
    if (trimmed.length === 0) {
      throw createAdapterError(
        "unsupported-access-mode",
        `SSH authorized keys file is empty: ${configuredPath}`,
      );
    }

    return Buffer.from(trimmed, "utf8").toString("base64");
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

  private async resolvePublishedSshEndpoint(
    containerId: string,
    containerSshPort: number,
  ): Promise<string | undefined> {
    const maxAttempts = 10;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const portResult = await this.commandRunner("docker", [
          "port",
          containerId,
          `${containerSshPort}/tcp`,
        ]);
        const output = portResult.stdout.trim();

        if (output.length > 0) {
          const lastLine = output.split("\n").pop();
          if (lastLine !== undefined) {
            const match = /^(?<host>.+):(?<port>\d+)$/.exec(lastLine.trim());
            if (match?.groups?.host !== undefined && match.groups.port !== undefined) {
              const host = match.groups.host === "0.0.0.0" ? "127.0.0.1" : match.groups.host;
              const endpointHost = host.includes(":") ? `[${host}]` : host;
              return `ssh://root@${endpointHost}:${match.groups.port}`;
            }
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (!message.includes("No public port")) {
          throw error;
        }
      }

      if (attempt < maxAttempts - 1) {
        await sleep(100);
      }
    }

    return undefined;
  }

  private async resolveContainerNetworkSshEndpoint(
    containerId: string,
    containerSshPort: number,
  ): Promise<string | undefined> {
    const inspectResult = await this.commandRunner("docker", [
      "inspect",
      "--format",
      "{{json .NetworkSettings.Networks}}",
      containerId,
    ]);
    const rawNetworks = inspectResult.stdout.trim();

    if (rawNetworks.length === 0 || rawNetworks === "null") {
      return undefined;
    }

    let parsedNetworks: unknown;

    try {
      parsedNetworks = JSON.parse(rawNetworks);
    } catch {
      throw createAdapterError(
        "adapter-unavailable",
        `Docker inspect returned an unparseable network payload for '${containerId}'.`,
      );
    }

    if (typeof parsedNetworks !== "object" || parsedNetworks === null) {
      return undefined;
    }

    const networkEntries = Object.values(parsedNetworks);

    for (const entry of networkEntries) {
      if (typeof entry !== "object" || entry === null) {
        continue;
      }

      const ipAddress =
        "IPAddress" in entry && typeof entry.IPAddress === "string" ? entry.IPAddress.trim() : "";

      if (ipAddress.length === 0) {
        continue;
      }

      const endpointHost = ipAddress.includes(":") ? `[${ipAddress}]` : ipAddress;
      return `ssh://root@${endpointHost}:${containerSshPort}`;
    }

    return undefined;
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

  public supports(input: RuntimeAdapterSupportInput): RuntimeAdapterSupport {
    const parsed = parseRuntimeAdapterSupportInput(input);
    const support = supportForInput(parsed);
    if (!support.supported) {
      return support;
    }

    if (
      parsed.blueprint.access.ssh.enabled &&
      parsed.blueprint.access.ssh.authorizedKeysRef === undefined &&
      this.defaultSshAuthorizedKeysFile === undefined
    ) {
      return parseRuntimeAdapterSupport({
        supported: false,
        reason: "unsupported-access-mode",
        message:
          "SSH is enabled but no authorized keys file was provided in access.ssh.authorizedKeysRef or adapter defaults.",
      });
    }

    return support;
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
    const sshEnabled = parsed.blueprint.access.ssh.enabled;
    const containerSshPort = parsed.blueprint.access.ssh.listenPort ?? 2222;
    const sandboxCloneAuth = this.resolveSandboxCloneAuth(parsed);
    const sandboxAuthKeyBase64 =
      sandboxCloneAuth?.type === "file-ref"
        ? await this.resolveSandboxAuthKeyBase64(sandboxCloneAuth)
        : undefined;
    const sshArgs =
      sshEnabled === true && this.sshEndpointExposureStrategy === "host-published"
        ? ["-p", `${this.sshBindHost}::${containerSshPort}`]
        : [];
    const sshEnvArgs =
      sshEnabled === true
        ? [
            "-e",
            "SEALANT_ENABLE_SSH=true",
            "-e",
            `SEALANT_SSH_PORT=${containerSshPort}`,
            "-e",
            "SEALANT_SSH_AUTHORIZED_KEYS_FILE=/sandbox/.ssh-runtime/authorized_keys.input",
            "-e",
            `SEALANT_SSH_AUTHORIZED_KEYS_BASE64=${await this.resolveAuthorizedKeysBase64(parsed)}`,
          ]
        : [];
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
    const args = [
      "run",
      "-d",
      "--runtime",
      parsed.blueprint.runtime.ociRuntime,
      "--name",
      containerName,
      "-w",
      parsed.blueprint.runtime.workingDirectory,
      ...sshArgs,
      ...sshEnvArgs,
      ...sandboxAuthEnvArgs,
      ...sandboxHttpAuthEnvArgs,
      ...envArgsFromBlueprint(parsed),
      imageReference,
    ];
    if (this.autoRemove) {
      args.splice(2, 0, "--rm");
    }
    const runResult = await this.commandRunner("docker", args);
    const containerId = runResult.stdout.trim();

    if (containerId.length === 0) {
      throw createAdapterError("adapter-unavailable", "Docker run did not return a container id.");
    }

    if (this.verifyRunning) {
      await this.assertContainerRunning(containerId, containerName);
    }

    const endpoint =
      sshEnabled === true
        ? this.sshEndpointExposureStrategy === "host-published"
          ? await this.resolvePublishedSshEndpoint(containerId, containerSshPort)
          : await this.resolveContainerNetworkSshEndpoint(containerId, containerSshPort)
        : undefined;

    if (sshEnabled && endpoint === undefined) {
      console.warn("[docker-runtime-adapter] SSH endpoint discovery failed", {
        containerId,
        containerName,
        containerSshPort,
      });
    }

    if (this.verifyRunning) {
      await this.assertContainerRunning(containerId, containerName);
    }

    return parseRuntimeAdapterLaunchResult({
      adapter: this.id,
      resourceId: containerId,
      reference: containerName,
      status: "running",
      ...(endpoint === undefined ? {} : { endpoint }),
    });
  }
}
