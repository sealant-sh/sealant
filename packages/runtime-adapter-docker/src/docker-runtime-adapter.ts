import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import {
  parseRuntimeAdapterLaunchInput,
  parseRuntimeAdapterLaunchResult,
  parseRuntimeAdapterSupportInput,
  parseRuntimeAdapterSupport,
  type RuntimeAdapterSupportInput,
  type RuntimeAdapter,
  type RuntimeAdapterLaunchInput,
  type RuntimeAdapterLaunchResult,
  type RuntimeAdapterSupport,
} from "@sealant/runtime-adapters-api";

const execFileAsync = promisify(execFile);

export interface DockerCommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

export type DockerCommandRunner = (
  command: string,
  args: Array<string>,
) => Promise<DockerCommandResult>;

export interface DockerRuntimeAdapterOptions {
  readonly commandRunner?: DockerCommandRunner;
  readonly containerNamePrefix?: string;
  readonly autoRemove?: boolean;
  readonly verifyRunning?: boolean;
  readonly defaultSshAuthorizedKeysFile?: string;
  readonly sshBindHost?: string;
}

const defaultCommandRunner: DockerCommandRunner = async (command, args) => {
  const result = await execFileAsync(command, args, {
    maxBuffer: 1024 * 1024 * 10,
  });

  return {
    stdout: result.stdout,
    stderr: result.stderr,
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
  const repositoryToken = normalizeContainerToken(input.publishedImage.repository) || "workspace";
  const tagToken = normalizeContainerToken(input.publishedImage.tag) || "latest";
  const suffix = Date.now().toString(36);
  return `${prefix}-${repositoryToken}-${tagToken}-${suffix}`;
};

const envArgsFromBlueprint = (input: RuntimeAdapterLaunchInput): Array<string> => {
  return Object.entries(input.blueprint.runtime.env).flatMap(([key, value]) => [
    "-e",
    `${key}=${value}`,
  ]);
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
      message: "The Docker runtime adapter currently supports only ephemeral workspaces.",
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

  private readonly containerNamePrefix: string;

  private readonly autoRemove: boolean;

  private readonly verifyRunning: boolean;

  private readonly defaultSshAuthorizedKeysFile: string | undefined;

  private readonly sshBindHost: string;

  public constructor(options: DockerRuntimeAdapterOptions = {}) {
    this.commandRunner = options.commandRunner ?? defaultCommandRunner;
    this.containerNamePrefix = options.containerNamePrefix ?? "sealant";
    this.autoRemove = options.autoRemove ?? false;
    this.verifyRunning = options.verifyRunning ?? true;
    this.defaultSshAuthorizedKeysFile = options.defaultSshAuthorizedKeysFile;
    this.sshBindHost = options.sshBindHost ?? "127.0.0.1";
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

  private async resolvePublishedSshEndpoint(
    containerId: string,
    containerSshPort: number,
  ): Promise<string | undefined> {
    const portResult = await this.commandRunner("docker", [
      "port",
      containerId,
      `${containerSshPort}/tcp`,
    ]);
    const output = portResult.stdout.trim();

    if (output.length === 0) {
      return undefined;
    }

    const lastLine = output.split("\n").pop();
    if (lastLine === undefined) {
      return undefined;
    }

    const match = /^(?<host>.+):(?<port>\d+)$/.exec(lastLine.trim());
    if (match?.groups?.host === undefined || match.groups.port === undefined) {
      return undefined;
    }

    const host = match.groups.host === "0.0.0.0" ? "127.0.0.1" : match.groups.host;
    const endpointHost = host.includes(":") ? `[${host}]` : host;
    return `ssh://root@${endpointHost}:${match.groups.port}`;
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

    const containerName = buildContainerName(parsed, this.containerNamePrefix);
    const imageReference = parsed.publishedImage.digestReference;
    const sshEnabled = parsed.blueprint.access.ssh.enabled;
    const containerSshPort = parsed.blueprint.access.ssh.listenPort ?? 2222;
    const sshArgs = sshEnabled === true ? ["-p", `${this.sshBindHost}::${containerSshPort}`] : [];
    const sshEnvArgs =
      sshEnabled === true
        ? [
            "-e",
            "SEALANT_ENABLE_SSH=true",
            "-e",
            `SEALANT_SSH_PORT=${containerSshPort}`,
            "-e",
            "SEALANT_SSH_AUTHORIZED_KEYS_FILE=/workspace/.ssh-runtime/authorized_keys.input",
            "-e",
            `SEALANT_SSH_AUTHORIZED_KEYS_BASE64=${await this.resolveAuthorizedKeysBase64(parsed)}`,
          ]
        : [];
    const args = [
      "run",
      "-d",
      "--name",
      containerName,
      "-w",
      parsed.blueprint.runtime.workingDirectory,
      ...sshArgs,
      ...sshEnvArgs,
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

    const endpoint =
      sshEnabled === true
        ? await this.resolvePublishedSshEndpoint(containerId, containerSshPort)
        : undefined;

    if (sshEnabled && endpoint === undefined) {
      throw createAdapterError(
        "adapter-unavailable",
        `Docker container '${containerName}' started but SSH endpoint discovery failed for container port ${containerSshPort}.`,
      );
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
