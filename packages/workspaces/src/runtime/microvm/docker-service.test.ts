import { execFileSync, spawn, type ChildProcess } from "node:child_process";
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
// Every directory is private (0700) unless the test expects another mode for it (a group-shared
// socket directory).
const expectedModes = JSON.parse(process.env.FAKE_EXPECTED_MODES ?? "{}");
const directories = Object.fromEntries(required.map((entry) => {
  try {
    const value = fs.statSync(entry);
    return [entry, { directory: value.isDirectory(), mode: value.mode & 0o777, gid: value.gid }];
  } catch {
    return [entry, { directory: false, mode: null, gid: null }];
  }
}));
// Published whole, by rename: the fake docker answers once the record exists, so an existing
// record must already be complete (a write in place could be seen open and empty).
const record = process.env.FAKE_DOCKERD_RECORD;
fs.writeFileSync(\`\${record}.\${process.pid}.tmp\`, JSON.stringify({ argv: process.argv.slice(2), directories }));
fs.renameSync(\`\${record}.\${process.pid}.tmp\`, record);
if (Object.entries(directories).some(([entry, value]) => !value.directory || value.mode !== (expectedModes[entry] ?? 0o700))) {
  process.stderr.write("can't create unix socket: no such file or directory");
  process.exit(17);
}
setInterval(() => {}, 1000);
process.on("SIGTERM", () => process.exit(0));
`;

// \`docker info\` answers only once the daemon is up, as the real one does. A fake that always
// answered let the service report ready, and stop, before the fake daemon had started and written
// its record: on a loaded runner a node process takes longer to start than one probe interval.
// The fake is POSIX sh (dash, busybox) because each probe must also start and exit inside its own
// 100 ms timeout, and a Node fake spent much of that starting up on a loaded runner (#374). It
// writes the argv exactly as JSON.stringify does.
const FAKE_DOCKER = `#!/bin/sh
[ -e "$FAKE_DOCKERD_RECORD" ] || exit 1
quote() {
  case $1 in
    *[\\"\\\\[:cntrl:]]*) ;;
    *) q="\\"$1\\""; return ;;
  esac
  s=$1 q=
  while [ -n "$s" ]; do
    c=\${s%"\${s#?}"}
    s=\${s#?}
    case $c in
      \\" | \\\\) q="$q\\\\$c" ;;
      [[:cntrl:]])
        n=$(printf '%d' "'$c")
        case $n in
          8) q="$q\\\\b" ;;
          9) q="$q\\\\t" ;;
          10) q="$q\\\\n" ;;
          12) q="$q\\\\f" ;;
          13) q="$q\\\\r" ;;
          *) if [ "$n" -lt 32 ]; then q="$q$(printf '\\\\u%04x' "$n")"; else q="$q$c"; fi ;;
        esac
        ;;
      *) q="$q$c" ;;
    esac
  done
  q="\\"$q\\""
}
line= sep=
for arg; do
  quote "$arg"
  line="$line$sep$q"
  sep=,
done
printf '%s' "[$line]" > "$FAKE_DOCKER_RECORD" || exit 1
[ -n "$FAKE_DOCKER_LOG" ] && printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
# The real engine's failure on VM 131 run 7: the shim and containerd disagreed.
if [ "$1 $2 $3" = "--host $2 run" ] && [ -n "$FAKE_DOCKER_RUN_FAIL" ]; then
  echo "docker: Error response from daemon: failed to create task for container: failed to start shim: start failed: failed to create TTRPC connection: unsupported protocol: Yunix" >&2
  exit 125
fi
exit 0
`;

// The engine's own containerd: answers --version, and once started makes the socket its config
// names (as the real one listens), unless FAKE_CONTAINERD_DIE asks it to exit at once.
const FAKE_CONTAINERD = `#!/bin/sh
if [ "$1" = --version ]; then echo "containerd github.com/containerd/containerd/v2 v2.9.9-fake"; exit 0; fi
printf '%s\\n' "$*" > "$FAKE_CONTAINERD_RECORD"
[ -n "$FAKE_CONTAINERD_DIE" ] && exit 3
address=$(sed -n 's/^ *address = "\\(.*\\)"$/\\1/p' "$2")
: > "$address"
trap 'exit 0' TERM
while :; do sleep 1; done
`;
const FAKE_SHIM = `#!/bin/sh
echo "containerd-shim-runc-v2: v2.9.9-fake"
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
  ...JSON.parse(process.env.SERVICE_OPTIONS ?? "{}"),
  onReady: () => void finish("READY"),
  onStateChange: (health) => {
    if (health.status === "failed") {
      console.log("HEALTH:" + JSON.stringify(health));
      void finish("FAILED:" + health.reason);
    }
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
  extra: {
    readonly options?: Record<string, unknown>;
    readonly expectedModes?: Record<string, number>;
    readonly env?: Record<string, string>;
  } = {},
): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> => {
  const child: ChildProcess = spawn(
    process.execPath,
    ["--input-type=module", "--eval", SERVICE_RUNNER],
    {
      env: {
        ...process.env,
        SERVICE_PATHS: JSON.stringify(fixture.paths),
        SERVICE_OPTIONS: JSON.stringify(extra.options ?? {}),
        FAKE_EXPECTED_MODES: JSON.stringify(extra.expectedModes ?? {}),
        FAKE_DOCKERD: fixture.dockerd,
        FAKE_DOCKER: fixture.docker,
        FAKE_REQUIRED_DIRS: JSON.stringify(fixture.requiredDirectories),
        FAKE_DOCKERD_RECORD: fixture.dockerdRecord,
        FAKE_DOCKER_RECORD: fixture.dockerRecord,
        ...extra.env,
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
    z.strictObject({
      directory: z.boolean(),
      mode: z.number().int().nullable(),
      gid: z.number().int().nullable(),
    }),
  ),
});

/** The name of the group this test process runs as, from /etc/group, when it has one. */
const currentGroupName = async (): Promise<string | null> => {
  const gid = process.getgid?.();
  if (gid === undefined) return null;
  const groups = await readFile("/etc/group", "utf8").catch(() => "");
  for (const line of groups.split("\n")) {
    const fields = line.split(":");
    if (fields.length >= 3 && Number(fields[2]) === gid && fields[0] !== undefined) {
      return fields[0];
    }
  }
  return null;
};

describe("DockerService networking and socket group options", () => {
  it("passes the bridge address, address pools and group through to dockerd", async () => {
    const fixture = await createFixture();
    const gid = process.getgid?.() ?? 0;
    const socketDirectory = path.dirname(fixture.paths.socket);
    const result = await runService(fixture, {
      options: {
        bridgeIp: "198.18.0.1/16",
        addressPools: ["base=198.18.0.0/15,size=24", "base=198.19.0.0/16,size=24"],
        group: String(gid),
      },
      expectedModes: { [socketDirectory]: 0o750 },
    });
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
      "--bip",
      "198.18.0.1/16",
      "--default-address-pool",
      "base=198.18.0.0/15,size=24",
      "--default-address-pool",
      "base=198.19.0.0/16,size=24",
      "--group",
      String(gid),
    ]);
    // The socket's directory opens to the group; every other runtime directory stays private.
    expect(record.directories[socketDirectory]).toEqual({ directory: true, mode: 0o750, gid });
    for (const directory of fixture.requiredDirectories.filter((d) => d !== socketDirectory)) {
      expect(record.directories[directory]).toMatchObject({ directory: true, mode: 0o700 });
    }
  });

  it("resolves a group by name and keeps today's exact arguments when no option is set", async () => {
    const name = await currentGroupName();
    if (name !== null) {
      const fixture = await createFixture();
      const socketDirectory = path.dirname(fixture.paths.socket);
      const result = await runService(fixture, {
        options: { group: name },
        expectedModes: { [socketDirectory]: 0o750 },
      });
      expect(result).toMatchObject({ code: 0, stderr: "" });
      const record = dockerdRecordSchema.parse(
        JSON.parse(await readFile(fixture.dockerdRecord, "utf8")),
      );
      expect(record.argv.slice(-2)).toEqual(["--group", name]);
      expect(record.directories[socketDirectory]).toMatchObject({
        mode: 0o750,
        gid: process.getgid?.() ?? 0,
      });
    }
    const plain = await createFixture();
    const result = await runService(plain, { options: { addressPools: [] } });
    expect(result).toMatchObject({ code: 0, stderr: "" });
    const record = dockerdRecordSchema.parse(
      JSON.parse(await readFile(plain.dockerdRecord, "utf8")),
    );
    expect(record.argv).toEqual([
      "--host",
      `unix://${plain.paths.socket}`,
      "--data-root",
      plain.paths.dataRoot,
      "--exec-root",
      plain.paths.execRoot,
      "--pidfile",
      plain.paths.pidFile,
    ]);
  });

  it("fails directory preparation when the group cannot be resolved", async () => {
    const fixture = await createFixture();
    const result = await runService(fixture, { options: { group: "no-such-group-sealant" } });
    expect(result).toMatchObject({ code: 1, stderr: "" });
    expect(result.stdout).toContain("FAILED:directory-preparation-failed");
    await expect(readFile(fixture.dockerdRecord, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
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
      fixture.requiredDirectories.map(() => ({
        directory: true,
        mode: 0o700,
        gid: process.getgid?.() ?? 0,
      })),
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

/** The engine's own containerd socket, under the fixture's exec root. */
const socket = (fixture: ServiceFixture) =>
  path.join(fixture.paths.execRoot, "containerd", "containerd.sock");
/** The failed health the service runner prints. */
const healthOf = (stdout: string) =>
  z.object({ status: z.literal("failed"), reason: z.string(), output: z.string() }).parse(
    JSON.parse(
      stdout
        .split("\n")
        .find((line) => line.startsWith("HEALTH:"))
        ?.slice(7) ?? "{}",
    ),
  );

describe("DockerService with the engine's own containerd and a container at readiness", () => {
  const engine = async (fixture: ServiceFixture) => {
    const bin = path.join(fixture.root, "bin");
    const containerd = path.join(bin, "containerd");
    const shim = path.join(bin, "containerd-shim-runc-v2");
    const init = path.join(bin, "docker-init");
    await Promise.all([
      writeFile(containerd, FAKE_CONTAINERD),
      writeFile(shim, FAKE_SHIM),
      writeFile(init, "static docker-init stand-in"),
    ]);
    await Promise.all([chmod(containerd, 0o755), chmod(shim, 0o755)]);
    return {
      options: { containerdPath: containerd, shimPath: shim, containerProbeInitPath: init },
      containerd,
      env: {
        FAKE_CONTAINERD_RECORD: path.join(fixture.root, "containerd.args"),
        FAKE_DOCKER_LOG: path.join(fixture.root, "docker.log"),
      },
    };
  };
  it("starts its own containerd, points dockerd at it, and runs a container before it is ready", async () => {
    const fixture = await createFixture();
    const own = await engine(fixture);
    const result = await runService(fixture, { options: own.options, env: own.env });
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toContain("READY:");
    // dockerd never adopts a containerd it finds: it is told which one.
    const record = dockerdRecordSchema.parse(
      JSON.parse(await readFile(fixture.dockerdRecord, "utf8")),
    );
    expect(record.argv.slice(0, 2)).toEqual(["--containerd", socket(fixture)]);
    const config = path.join(fixture.paths.execRoot, "containerd", "containerd.toml");
    expect((await readFile(own.env.FAKE_CONTAINERD_RECORD, "utf8")).trim()).toBe(
      `--config ${config}`,
    );
    const toml = await readFile(config, "utf8");
    expect(toml).toContain(`address = ${JSON.stringify(socket(fixture))}`);
    expect(toml).toContain('"io.containerd.grpc.v1.cri"');
    expect((await stat(config)).mode & 0o777).toBe(0o600);
    // Readiness ran a real container: an image of one static file, no network, never pulled.
    const calls = (await readFile(own.env.FAKE_DOCKER_LOG, "utf8")).trim().split("\n");
    const host = `--host unix://${fixture.paths.socket}`;
    expect(calls).toContain(
      `${host} import --change ENTRYPOINT ["/probe"] - sealant-engine-probe:1`,
    );
    expect(calls).toContain(
      `${host} run --rm --network none --pull never --log-driver none sealant-engine-probe:1 --version`,
    );
    expect(calls.indexOf(`${host} info`)).toBeLessThan(calls.findIndex((c) => c.includes(" run ")));
  });

  it("is not ready when the engine answers but cannot run a container, and says what it is made of", async () => {
    const fixture = await createFixture();
    const own = await engine(fixture);
    const result = await runService(fixture, {
      options: own.options,
      env: { ...own.env, FAKE_DOCKER_RUN_FAIL: "1" },
    });
    expect(result.stdout).toContain("FAILED:container-probe-failed");
    const health = healthOf(result.stdout);
    expect(health.reason).toBe("container-probe-failed");
    expect(health.output).toContain(
      `containerd: ${own.containerd} containerd github.com/containerd/containerd/v2 v2.9.9-fake on ${socket(fixture)}`,
    );
    expect(health.output).toContain("shim: ");
    expect(health.output).toContain("v2.9.9-fake");
    expect(health.output).toMatch(/system containerd socket: (present|absent)/);
    expect(health.output).toContain("unsupported protocol: Yunix");
  });

  it("fails as containerd-failed, and never starts dockerd, when its containerd exits", async () => {
    const fixture = await createFixture();
    const own = await engine(fixture);
    const result = await runService(fixture, {
      options: own.options,
      env: { ...own.env, FAKE_CONTAINERD_DIE: "1" },
    });
    expect(result.stdout).toContain("FAILED:containerd-failed");
    await expect(readFile(fixture.dockerdRecord, "utf8")).rejects.toThrow();
  });
});

describe("singleFileTar", () => {
  it("writes a tar that tar itself lists as one executable file", async () => {
    const { singleFileTar } = await import(DOCKER_SERVICE);
    const root = await mkdtemp(path.join(tmpdir(), "single-file-tar-"));
    fixtures.add(root);
    const archive = path.join(root, "probe.tar");
    await writeFile(archive, singleFileTar("probe", Buffer.from("#!/bin/sh\necho ok\n")));
    const listed = execFileSync("tar", ["-tvf", archive], { encoding: "utf8" });
    expect(listed).toMatch(/^-rwxr-xr-x .* 18 .* probe$/m);
  });
});
