import { Writable } from "node:stream";

import type { NixExecutorCommandRunner } from "@sealant/os-integration-nix";
import Docker from "dockerode";

import type { WorkerEnv } from "./env.js";

// Docker Compose labels uniquely identify containers inside a project.
// We use these two values to find the running nix-builder container on demand.
interface NixBuilderLocator {
  composeProjectName: string;
  serviceName: string;
}

// Find the currently running nix-builder container for this compose project.
// We intentionally lookup by labels instead of hardcoding container names so
// this keeps working across different machines and compose naming variants.
const findRunningNixBuilderContainer = async (docker: Docker, locator: NixBuilderLocator) => {
  const containers = await docker.listContainers({
    all: false,
    filters: {
      label: [
        `com.docker.compose.project=${locator.composeProjectName}`,
        `com.docker.compose.service=${locator.serviceName}`,
      ],
    },
  });

  const containerInfo = containers[0];
  if (containerInfo === undefined || containerInfo.Id === undefined) {
    throw new Error(
      `No running container found for compose project '${locator.composeProjectName}' service '${locator.serviceName}'.`,
    );
  }

  return docker.getContainer(containerInfo.Id);
};

// Docker exec returns a stream. We wait until that source stream finishes
// before reading exit code via exec.inspect().
const waitForStreamCompletion = async (stream: NodeJS.ReadableStream): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    let settled = false;

    const finalize = (callback: () => void) => {
      if (settled) {
        return;
      }

      settled = true;
      callback();
    };

    stream.on("error", (error) => {
      finalize(() => reject(error));
    });

    stream.on("close", () => {
      finalize(resolve);
    });

    stream.on("end", () => {
      finalize(resolve);
    });
  });
};

// Collect stream output into buffers so we can return plain stdout/stderr
// strings from the command runner contract.
const createBufferWritable = (target: Buffer[]) => {
  return new Writable({
    write(chunk, _encoding, callback) {
      target.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      callback();
    },
  });
};

const toUtf8 = (chunks: Buffer[]): string => Buffer.concat(chunks).toString("utf8");

// Creates a command runner used by NixOsExecutor.
//
// High-level behavior:
// 1) Connect to host Docker through the mounted unix socket.
// 2) Locate the nix-builder compose service container.
// 3) Run `docker exec` equivalent command in that container.
// 4) Demultiplex combined Docker stream into stdout/stderr.
// 5) Inspect exit code and either return output or throw typed error.
export const createNixBuilderCommandRunner = (env: WorkerEnv): NixExecutorCommandRunner => {
  const docker = new Docker({ socketPath: env.DOCKER_SOCKET_PATH });
  const locator: NixBuilderLocator = {
    composeProjectName: env.COMPOSE_PROJECT_NAME,
    serviceName: env.NIX_BUILDER_SERVICE,
  };

  return async (command, args, options) => {
    // Resolve the target container each call so restarts/recreates are handled.
    const container = await findRunningNixBuilderContainer(docker, locator);

    // Create an exec instance (like `docker exec <container> <command ...args>`).
    const exec = await container.exec({
      AttachStdout: true,
      AttachStderr: true,
      // Keep TTY disabled so stdout/stderr stay as separate channels.
      Tty: false,
      Cmd: [command, ...args],
      ...(options?.cwd === undefined ? {} : { WorkingDir: options.cwd }),
    });

    // Start the exec and get a single multiplexed stream from Docker.
    const stream = await exec.start({
      hijack: true,
      stdin: false,
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const stdoutWritable = createBufferWritable(stdoutChunks);
    const stderrWritable = createBufferWritable(stderrChunks);

    // Docker multiplexes stdout/stderr into one stream. `demuxStream` splits
    // it back into two writable streams for us.
    (
      docker as Docker & {
        modem: {
          demuxStream(
            outputStream: NodeJS.ReadableStream,
            stdoutTarget: NodeJS.WritableStream,
            stderrTarget: NodeJS.WritableStream,
          ): void;
        };
      }
    ).modem.demuxStream(stream, stdoutWritable, stderrWritable);

    // Wait for command completion, then finalize our writable collectors.
    await waitForStreamCompletion(stream);
    stdoutWritable.end();
    stderrWritable.end();

    const stdout = toUtf8(stdoutChunks);
    const stderr = toUtf8(stderrChunks);

    const inspection = await exec.inspect();
    const exitCode = inspection.ExitCode ?? 1;

    // Mirror local shell behavior: non-zero exit means command failure.
    // We attach a machine-readable error code so upstream job processing can
    // persist a structured failure reason.
    if (exitCode !== 0) {
      const error = new Error(
        `Command failed in nix builder container (exit ${exitCode}): ${command} ${args.join(" ")}\n${stderr || stdout}`,
      ) as Error & { code: string };
      error.code = "nix-builder-command-failed";
      throw error;
    }

    return {
      stdout,
      stderr,
    };
  };
};
