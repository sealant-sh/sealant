import { execFile } from "node:child_process";
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
  return Object.entries(input.blueprint.runtime.env).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
};

const supportForInput = (input: RuntimeAdapterSupportInput): RuntimeAdapterSupport => {
  const targetRuntime = input.blueprint.target.runtime.family;

  if (targetRuntime !== "auto" && targetRuntime !== "docker") {
    return parseRuntimeAdapterSupport({
      supported: false,
      reason: "unsupported-runtime",
      message:
        "The Docker runtime adapter only supports target.runtime.family of auto or docker.",
    });
  }

  if (input.blueprint.access.ssh.enabled) {
    return parseRuntimeAdapterSupport({
      supported: false,
      reason: "unsupported-access-mode",
      message: "The Docker runtime adapter does not support SSH wiring yet.",
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

  public constructor(options: DockerRuntimeAdapterOptions = {}) {
    this.commandRunner = options.commandRunner ?? defaultCommandRunner;
    this.containerNamePrefix = options.containerNamePrefix ?? "sealant";
    this.autoRemove = options.autoRemove ?? false;
    this.verifyRunning = options.verifyRunning ?? true;
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
      const logs = [result.stdout, result.stderr].filter((chunk) => chunk.trim().length > 0).join("\n").trim();
      return logs.length === 0 ? undefined : logs;
    } catch {
      return undefined;
    }
  }

  public supports(input: RuntimeAdapterSupportInput): RuntimeAdapterSupport {
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

    const containerName = buildContainerName(parsed, this.containerNamePrefix);
    const imageReference = parsed.publishedImage.digestReference;
    const args = [
      "run",
      "-d",
      "--name",
      containerName,
      "-w",
      parsed.blueprint.runtime.workingDirectory,
      ...envArgsFromBlueprint(parsed),
      imageReference,
    ];
    if (this.autoRemove) {
      args.splice(2, 0, "--rm");
    }
    const runResult = await this.commandRunner("docker", args);
    const containerId = runResult.stdout.trim();

    if (containerId.length === 0) {
      throw createAdapterError(
        "adapter-unavailable",
        "Docker run did not return a container id.",
      );
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

    return parseRuntimeAdapterLaunchResult({
      adapter: this.id,
      resourceId: containerId,
      reference: containerName,
      status: "running",
    });
  }
}
