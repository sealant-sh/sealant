/**
 * Real Docker proof for strict named-volume lowering. Vitest builds a small controller image,
 * mounts three named volumes and the host Docker socket into it, then lets that Linux controller
 * call DockerRuntimeAdapter.launch for sibling workspaces. The workspace data, launch files,
 * Mend-style session socket, and platform control sockets never use host bind paths.
 *
 * Run from the repository root:
 * `pnpm --filter @sealant/workspaces exec vitest run --config vitest.e2e.config.ts src/runtime/docker-volume-mounts.e2e.ts`
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

const execFileAsync = promisify(execFile);
const COMMAND_TIMEOUT_MS = 10 * 60_000;
const RESULT_PREFIX = "SEALANT_VOLUME_E2E_RESULT=";

const phaseOneResultSchema = z.strictObject({
  phase: z.literal("phase1"),
  controller: z.string().min(1),
  platform: z.literal("linux"),
  primary: z.string().min(1),
  standby: z.string().min(1),
  volumeMountCount: z.literal(11),
  gitCommit: z.literal("workspace volume commit"),
  sessionSocket: z.literal("controller-reply"),
  siblingSessionCount: z.literal(0),
  missingSubpathRejected: z.literal(true),
  symlinkEscapeRejected: z.literal(true),
});

const phaseTwoResultSchema = z.strictObject({
  phase: z.literal("phase2"),
  controller: z.string().min(1),
  platform: z.literal("linux"),
  replacement: z.string().min(1),
  persistedGitCommit: z.literal("workspace volume commit"),
  persistedHome: z.literal(true),
  persistedBindable: z.literal(true),
});

const controllerMountSchema = z.discriminatedUnion("Type", [
  z.object({
    Type: z.literal("volume"),
    Source: z.string().min(1),
    Target: z.string().startsWith("/"),
    ReadOnly: z.boolean().default(false),
  }),
  z.object({
    Type: z.literal("bind"),
    Source: z.string().min(1),
    Target: z.string().startsWith("/"),
    ReadOnly: z.boolean().default(false),
  }),
]);
const controllerMountsSchema = z.array(controllerMountSchema);

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

const command = async (executable: string, args: readonly string[]): Promise<CommandResult> => {
  const result = await execFileAsync(executable, args, {
    maxBuffer: 20 * 1024 * 1024,
    timeout: COMMAND_TIMEOUT_MS,
  });
  return { stdout: result.stdout, stderr: result.stderr };
};

const docker = (args: readonly string[]): Promise<CommandResult> => command("docker", args);

const parseJson = (value: string, description: string): unknown => {
  try {
    return JSON.parse(value);
  } catch (cause) {
    throw new Error(`Docker returned invalid JSON for ${description}.`, { cause });
  }
};

const ignoreDockerFailure = async (args: readonly string[]): Promise<void> => {
  try {
    await docker(args);
  } catch {
    // Every cleanup call names one resource created by this test; later calls still need to run.
  }
};

const parseControllerResult = <T>(stdout: string, schema: z.ZodType<T>): T => {
  const line = stdout.split("\n").find((candidate) => candidate.startsWith(RESULT_PREFIX));
  if (line === undefined) {
    throw new Error(`Controller emitted no result marker. Output:\n${stdout}`);
  }
  return schema.parse(parseJson(line.slice(RESULT_PREFIX.length), "the controller result"));
};

const normalizedToken = (): string =>
  `${process.pid}-${Date.now().toString(36)}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");

const dockerSocketSource = async (): Promise<string> => {
  // DOCKER_CONTEXT takes precedence over DOCKER_HOST in the Docker CLI.
  const selectedContext = process.env["DOCKER_CONTEXT"];
  let endpoint = process.env["DOCKER_HOST"];
  if (selectedContext || !endpoint) {
    const context = await docker([
      "context",
      "inspect",
      ...(selectedContext ? [selectedContext] : []),
      "--format",
      "{{.Endpoints.docker.Host}}",
    ]);
    endpoint = context.stdout.trim();
  }
  if (!endpoint.startsWith("unix://")) {
    throw new Error("Docker volume E2E requires a local Unix Docker endpoint.");
  }
  // On macOS the client socket is a Mac-side proxy. The bind source must instead name the
  // daemon socket inside the Linux VM. An explicit override supports nonstandard/rootless VMs.
  const source =
    process.env["SEALANT_E2E_DOCKER_SOCKET_SOURCE"] ??
    (process.platform === "darwin" ? "/var/run/docker.sock" : endpoint.slice("unix://".length));
  if (!source.startsWith("/") || /[,\r\n\0]/.test(source)) {
    throw new Error("SEALANT_E2E_DOCKER_SOCKET_SOURCE must be an absolute Docker bind source.");
  }
  return source;
};

const inspectControllerMounts = async (container: string): Promise<void> => {
  const result = await docker(["inspect", "--format", "{{json .HostConfig.Mounts}}", container]);
  const mounts = controllerMountsSchema.parse(
    parseJson(result.stdout.trim(), "the controller mount list"),
  );
  const dataMounts = mounts.filter((mount) => mount.Target.startsWith("/sealant/"));
  expect(dataMounts).toHaveLength(3);
  expect(dataMounts.every((mount) => mount.Type === "volume")).toBe(true);
  expect(
    dataMounts.map((mount) => mount.Target).toSorted((left, right) => left.localeCompare(right)),
  ).toEqual(["/sealant/control", "/sealant/staging", "/sealant/store"]);
  const socketMounts = mounts.filter((mount) => mount.Target === "/var/run/docker.sock");
  expect(socketMounts).toHaveLength(1);
  expect(socketMounts[0]?.Type).toBe("bind");
  expect(mounts).toHaveLength(4);
};

describe("Docker named-volume workspace mounts through an in-container adapter", () => {
  const token = normalizedToken();
  const label = `sealant.volume-e2e=${token}`;
  const containerPrefix = `sealant-ve2e-${token}`;
  const controllerImage = `sealant-volume-e2e-controller:${token}`;
  const workspaceImage = `sealant-volume-e2e-workspace:${token}`;
  const volumeNames = {
    store: `sealant-ve2e-store-${token}`,
    control: `sealant-ve2e-control-${token}`,
    staging: `sealant-ve2e-staging-${token}`,
  } as const;
  const controllerNames = [`${containerPrefix}-controller-1`, `${containerPrefix}-controller-2`];
  const possibleWorkspaceNames = ["primary", "standby", "missing", "escape", "internal-alias"].map(
    (run) => `${containerPrefix}-${run}`,
  );
  const dockerfile = fileURLToPath(
    new URL("../../scripts/docker-volume-mounts.e2e.Dockerfile", import.meta.url),
  );
  const controllerSource = fileURLToPath(
    new URL("./docker-volume-mounts.e2e-controller.ts", import.meta.url),
  );
  let buildContext = "";
  let socketSource = "";
  let dockerPlatform = "";
  let dockerVersion = "";

  beforeAll(async () => {
    const platform = await docker([
      "version",
      "--format",
      "{{.Server.Os}}|{{.Server.Version}}|{{.Client.APIVersion}}|{{.Server.APIVersion}}",
    ]);
    const fields = platform.stdout.trim().split("|");
    dockerPlatform = fields[0] ?? "";
    dockerVersion = fields[1] ?? "";
    expect(dockerPlatform).toBe("linux");
    expect(dockerVersion).not.toBe("");
    socketSource = await dockerSocketSource();

    buildContext = await mkdtemp(join(tmpdir(), "sealant-volume-e2e-"));
    await command("pnpm", [
      "exec",
      "esbuild",
      controllerSource,
      "--bundle",
      "--platform=node",
      "--format=cjs",
      "--target=node24",
      `--outfile=${join(buildContext, "controller.cjs")}`,
    ]);

    await docker([
      "build",
      "--target",
      "controller",
      "--label",
      label,
      "--tag",
      controllerImage,
      "--file",
      dockerfile,
      buildContext,
    ]);
    await docker([
      "build",
      "--target",
      "workspace",
      "--label",
      label,
      "--tag",
      workspaceImage,
      "--file",
      dockerfile,
      buildContext,
    ]);

    for (const volume of Object.values(volumeNames)) {
      await docker(["volume", "create", "--label", label, volume]);
    }
  }, COMMAND_TIMEOUT_MS);

  afterAll(async () => {
    for (const container of [...possibleWorkspaceNames, ...controllerNames]) {
      await ignoreDockerFailure(["rm", "-f", container]);
    }
    for (const volume of Object.values(volumeNames)) {
      await ignoreDockerFailure(["volume", "rm", "-f", volume]);
    }
    await ignoreDockerFailure(["image", "rm", "-f", controllerImage]);
    await ignoreDockerFailure(["image", "rm", "-f", workspaceImage]);
    if (buildContext !== "") {
      await rm(buildContext, { recursive: true, force: true });
    }
  }, 120_000);

  const runController = async (name: string, phase: "phase1" | "phase2"): Promise<string> => {
    const mappings = JSON.stringify([
      { logicalRoot: "/sealant/store", volumeName: volumeNames.store },
      { logicalRoot: "/sealant/control", volumeName: volumeNames.control },
      { logicalRoot: "/sealant/staging", volumeName: volumeNames.staging },
    ]);
    await docker([
      "create",
      "--name",
      name,
      "--label",
      label,
      "--network",
      "none",
      "--mount",
      `type=bind,src=${socketSource},dst=/var/run/docker.sock`,
      "--mount",
      `type=volume,src=${volumeNames.store},dst=/sealant/store`,
      "--mount",
      `type=volume,src=${volumeNames.control},dst=/sealant/control`,
      "--mount",
      `type=volume,src=${volumeNames.staging},dst=/sealant/staging`,
      "--env",
      `SEALANT_DOCKER_VOLUME_MAPPINGS=${mappings}`,
      "--env",
      `SEALANT_E2E_WORKSPACE_IMAGE=${workspaceImage}`,
      "--env",
      `SEALANT_E2E_CONTAINER_PREFIX=${containerPrefix}`,
      controllerImage,
      phase,
    ]);
    await inspectControllerMounts(name);
    return (await docker(["start", "--attach", name])).stdout;
  };

  it(
    "runs the real adapter and sealantd across named volumes, then survives controller replacement",
    async () => {
      const phaseOne = parseControllerResult(
        await runController(controllerNames[0] ?? "missing-controller-1", "phase1"),
        phaseOneResultSchema,
      );
      const phaseTwo = parseControllerResult(
        await runController(controllerNames[1] ?? "missing-controller-2", "phase2"),
        phaseTwoResultSchema,
      );

      expect(phaseTwo.controller).not.toBe(phaseOne.controller);
      expect(phaseTwo.replacement).toBe(phaseOne.primary);
      expect(phaseTwo.persistedGitCommit).toBe(phaseOne.gitCommit);
      expect(dockerPlatform).toBe("linux");
      expect(dockerVersion).toMatch(/^\d+\.\d+\.\d+/);

      process.stdout.write(
        `Docker volume E2E passed on ${dockerPlatform} Docker Engine ${dockerVersion}: ` +
          `${phaseOne.volumeMountCount} strict workspace mounts, controller ${phaseOne.controller} -> ${phaseTwo.controller}.\n`,
      );
    },
    COMMAND_TIMEOUT_MS,
  );
});
