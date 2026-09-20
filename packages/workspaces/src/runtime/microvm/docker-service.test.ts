import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

const DOCKER_SERVICE = fileURLToPath(
  new URL("../../../microvm-image/docker-service.mjs", import.meta.url),
);

const FAKE_DOCKERD = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const required = JSON.parse(process.env.FAKE_REQUIRED_DIRS);
const directories = Object.fromEntries(required.map((entry) => {
  try {
    const value = fs.statSync(entry);
    return [entry, { directory: value.isDirectory(), mode: value.mode & 0o777 }];
  } catch {
    return [entry, { directory: false, mode: null }];
  }
}));
fs.writeFileSync(process.env.FAKE_DOCKERD_RECORD, JSON.stringify({ argv: process.argv.slice(2), directories }));
if (Object.values(directories).some((entry) => !entry.directory || entry.mode !== 0o700)) {
  process.stderr.write("can't create unix socket: no such file or directory");
  process.exit(17);
}
setInterval(() => {}, 1000);
process.on("SIGTERM", () => process.exit(0));
`;

// \`docker info\` answers only once the daemon is up, as the real one does. A fake that always
// answered let the service report ready, and stop, before the fake daemon had started and written
// its record: on a loaded runner a node process takes longer to start than one probe interval.
const FAKE_DOCKER = `#!/usr/bin/env node
const fs = require("node:fs");
if (!fs.existsSync(process.env.FAKE_DOCKERD_RECORD)) process.exit(1);
fs.writeFileSync(process.env.FAKE_DOCKER_RECORD, JSON.stringify(process.argv.slice(2)));
process.exit(0);
`;

const SERVICE_RUNNER = `
import { createDockerService } from ${JSON.stringify(DOCKER_SERVICE)};
const paths = JSON.parse(process.env.SERVICE_PATHS);
let settling = false;
let service;
const finish = async (label) => {
  if (settling) return;
  settling = true;
  const cleanup = await service.stop();
  console.log(label + ":" + JSON.stringify(cleanup));
  process.exit(label === "READY" && cleanup.ok ? 0 : 1);
};
service = createDockerService({
  dockerdPath: process.env.FAKE_DOCKERD,
  dockerPath: process.env.FAKE_DOCKER,
  socketPath: paths.socket,
  dataRoot: paths.dataRoot,
  execRoot: paths.execRoot,
  pidFile: paths.pidFile,
  readinessTimeoutMs: 4000,
  probeIntervalMs: 10,
  probeTimeoutMs: 100,
  shutdownTimeoutMs: 100,
  logPath: paths.log,
  onReady: () => void finish("READY"),
  onStateChange: (health) => {
    if (health.status === "failed") void finish("FAILED:" + health.reason);
  },
});
service.start();
setTimeout(() => void finish("FAILED:test-timeout"), 8000);
`;

type ServicePaths = {
  readonly socket: string;
  readonly dataRoot: string;
  readonly execRoot: string;
  readonly pidFile: string;
  readonly log: string;
};

type ServiceFixture = {
  readonly root: string;
  readonly paths: ServicePaths;
  readonly dockerdRecord: string;
  readonly dockerRecord: string;
  readonly requiredDirectories: ReadonlyArray<string>;
  readonly dockerd: string;
  readonly docker: string;
};

const fixtures = new Set<string>();

const createFixture = async (): Promise<ServiceFixture> => {
  const root = await mkdtemp(path.join(tmpdir(), "docker-service-directories-"));
  fixtures.add(root);
  const bin = path.join(root, "bin");
  await mkdir(bin);
  const dockerd = path.join(bin, "dockerd");
  const docker = path.join(bin, "docker");
  await Promise.all([writeFile(dockerd, FAKE_DOCKERD), writeFile(docker, FAKE_DOCKER)]);
  await Promise.all([chmod(dockerd, 0o755), chmod(docker, 0o755)]);

  const paths = {
    socket: path.join(root, "run", "docker", "docker.sock"),
    dataRoot: path.join(root, "var", "lib", "sealant", "docker"),
    execRoot: path.join(root, "run", "sealant", "docker-exec"),
    pidFile: path.join(root, "run", "sealant", "docker.pid"),
    log: path.join(root, "run", "sealant", "dockerd.stderr.log"),
  };
  return {
    root,
    paths,
    dockerdRecord: path.join(root, "dockerd.json"),
    dockerRecord: path.join(root, "docker.json"),
    requiredDirectories: [
      path.dirname(paths.socket),
      paths.dataRoot,
      paths.execRoot,
      path.dirname(paths.pidFile),
    ],
    dockerd,
    docker,
  };
};

const runService = async (
  fixture: ServiceFixture,
): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> => {
  const child: ChildProcess = spawn(
    process.execPath,
    ["--input-type=module", "--eval", SERVICE_RUNNER],
    {
      env: {
        ...process.env,
        SERVICE_PATHS: JSON.stringify(fixture.paths),
        FAKE_DOCKERD: fixture.dockerd,
        FAKE_DOCKER: fixture.docker,
        FAKE_REQUIRED_DIRS: JSON.stringify(fixture.requiredDirectories),
        FAKE_DOCKERD_RECORD: fixture.dockerdRecord,
        FAKE_DOCKER_RECORD: fixture.dockerRecord,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const code = await new Promise<number | null>((resolve) => {
    child.once("exit", resolve);
  });
  return { code, stdout, stderr };
};

afterEach(async () => {
  await Promise.all([...fixtures].map((fixture) => rm(fixture, { recursive: true, force: true })));
  fixtures.clear();
});

const dockerdRecordSchema = z.strictObject({
  argv: z.array(z.string()),
  directories: z.record(
    z.string(),
    z.strictObject({ directory: z.boolean(), mode: z.number().int().nullable() }),
  ),
});

describe("DockerService runtime directories", () => {
  it("creates missing socket, graph, exec and pid directories as private directories", async () => {
    const fixture = await createFixture();
    for (const directory of fixture.requiredDirectories) {
      await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
    }

    const result = await runService(fixture);

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toContain("READY:");
    const record = dockerdRecordSchema.parse(
      JSON.parse(await readFile(fixture.dockerdRecord, "utf8")),
    );
    expect(record.argv).toEqual([
      "--host",
      `unix://${fixture.paths.socket}`,
      "--data-root",
      fixture.paths.dataRoot,
      "--exec-root",
      fixture.paths.execRoot,
      "--pidfile",
      fixture.paths.pidFile,
    ]);
    expect(Object.values(record.directories)).toEqual(
      fixture.requiredDirectories.map(() => ({ directory: true, mode: 0o700 })),
    );
    expect(
      z.array(z.string()).parse(JSON.parse(await readFile(fixture.dockerRecord, "utf8"))),
    ).toEqual(["--host", `unix://${fixture.paths.socket}`, "info"]);
  });

  it("reports directory preparation failure without spawning dockerd or rejecting", async () => {
    const fixture = await createFixture();
    const blockingFile = path.join(fixture.root, "not-a-directory");
    await writeFile(blockingFile, "blocked");
    const blockedFixture = {
      ...fixture,
      paths: {
        ...fixture.paths,
        socket: path.join(blockingFile, "docker.sock"),
      },
      requiredDirectories: [
        blockingFile,
        fixture.paths.dataRoot,
        fixture.paths.execRoot,
        path.dirname(fixture.paths.pidFile),
      ],
    };

    const result = await runService(blockedFixture);

    expect(result).toMatchObject({ code: 1, stderr: "" });
    expect(result.stdout).toContain("FAILED:directory-preparation-failed");
    await expect(readFile(fixture.dockerdRecord, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
