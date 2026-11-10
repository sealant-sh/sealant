/**
 * The workspace's own Docker on Boat (`tooling.services.docker.enabled`): a root dockerd the agent
 * starts in the VM, driven as the owner's person through the SDK exec path. Runs hello-world, a
 * build, a compose service that reaches the project's `db` through the tunnel, checks what a
 * container may and may not reach, builds a two-stage Node image with `npm ci`, and records the
 * VM's and the session's peak memory and task counts so a VM size can be judged. Also runs the
 * image's `vm-probe.sh` in the twin, as root, and keeps its output.
 *
 * Evidence goes to `BOAT_TWIN_PROOF_DIR` when set (else the stack's scratch directory).
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { expect } from "vitest";

import { docker, dockerOk } from "./docker.js";
import type { FakeSandbox } from "./fake-boat.js";
import { MEND_GID, PERSON, type Launch } from "./scenario.js";
import type { HarnessStack } from "./stack.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const run = promisify(execFile);

export const evidenceDir = (stack: HarnessStack) =>
  process.env.BOAT_TWIN_PROOF_DIR ?? stack.scratch;

/** One transcript of everything the scenario ran in the workspace and what came back. */
export class Transcript {
  readonly lines: string[] = [];
  constructor(readonly file: string) {}
  async note(text: string) {
    this.lines.push(text);
    process.stderr.write(`[boat-harness] ${text.split("\n")[0] ?? ""}\n`);
    await writeFile(this.file, this.lines.join("\n") + "\n");
  }
}

/** Runs a script in the workspace as the owner's person; the transcript keeps its outcome. */
export const asPerson = async (
  run_: Launch,
  transcript: Transcript,
  title: string,
  script: string,
  options: { readonly expectExit?: number } = {},
) => {
  const started = Date.now();
  const result = await run_.workspace.exec(["/bin/bash", "-lc", script], {
    user: String(PERSON.uid),
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  await transcript.note(
    `## ${title} (exit ${String(result.exitCode)}, ${seconds}s)\n$ ${script}\n${result.stdout}${result.stderr === "" ? "" : `--- stderr\n${result.stderr}`}`,
  );
  const expected = options.expectExit ?? 0;
  if (result.exitCode !== expected)
    throw new Error(
      `${title}: exit ${String(result.exitCode)}, expected ${String(expected)}: ${result.stderr.slice(-1500) || result.stdout.slice(-1500)}`,
    );
  return result.stdout;
};

/**
 * The person's passwd entry: made at prepare, as root, through the platform's exec (what Mend
 * does; sealantd only maps ownership to it). Their primary group is `mend`; `docker` lets them
 * reach the engine's socket, which the Boat image gives the docker group.
 */
export const preparePerson = async (run_: Launch, transcript: Transcript) => {
  const prepared = await run_.workspace.exec([
    "/bin/sh",
    "-c",
    `getent passwd ${String(PERSON.uid)} >/dev/null || useradd -u ${String(PERSON.uid)} -g ${String(MEND_GID)} -G docker -m -d ${PERSON.home} -s /bin/bash ${PERSON.id}; id ${PERSON.id}`,
  ]);
  await transcript.note(
    `## prepare the person as root (exit ${String(prepared.exitCode)})\n${prepared.stdout}${prepared.stderr}`,
  );
  if (prepared.exitCode !== 0) throw new Error(`useradd failed: ${prepared.stderr.slice(-1000)}`);
};

/** A file into the person's home, through the exec path, byte for byte. */
export const putFile = (run_: Launch, transcript: Transcript, path: string, content: string) =>
  asPerson(
    run_,
    transcript,
    `write ${path}`,
    `mkdir -p "$(dirname ${path})" && base64 -d > ${path} <<'B64'\n${Buffer.from(content).toString("base64")}\nB64\nwc -c ${path}`,
  );

/** The session VM (twin) of a launch. */
export const sessionVm = (stack: HarnessStack, run_: Launch): FakeSandbox => {
  const vm = stack.boat
    .liveSandboxes()
    .find((sandbox) => sandbox.labels["sealant-run"] === run_.runId);
  if (vm === undefined) throw new Error(`no live VM for run ${run_.runId}`);
  return vm;
};

const readNumber = async (file: string) =>
  Number((await readFile(file, "utf8").catch(() => "NaN")).trim());

/** `memory.peak` / `pids.peak` and the current values of one cgroup, by absolute path. */
interface CgroupSample {
  readonly cgroup: string;
  readonly memoryPeakBytes: number;
  readonly memoryCurrentBytes: number;
  readonly pidsPeak: number;
  readonly pidsCurrent: number;
}
const sampleHost = async (cgroup: string): Promise<CgroupSample> => ({
  cgroup,
  memoryPeakBytes: await readNumber(join(cgroup, "memory.peak")),
  memoryCurrentBytes: await readNumber(join(cgroup, "memory.current")),
  pidsPeak: await readNumber(join(cgroup, "pids.peak")),
  pidsCurrent: await readNumber(join(cgroup, "pids.current")),
});
const sampleGuest = async (vm: FakeSandbox, cgroup: string): Promise<CgroupSample> => {
  const read = (name: string) =>
    docker(["exec", vm.container, "cat", join(cgroup, name)], {
      timeoutMs: 10_000,
    }).then((result) => (result.code === 0 ? Number(result.stdout.trim()) : Number.NaN));
  return {
    cgroup: `guest:${cgroup}`,
    memoryPeakBytes: await read("memory.peak"),
    memoryCurrentBytes: await read("memory.current"),
    pidsPeak: await read("pids.peak"),
    pidsCurrent: await read("pids.current"),
  };
};

/**
 * The VM's whole cgroup (the twin, from the host) and, inside it, the agent's unit (agent, sealantd
 * and every process it runs for the session), the engine's cgroup (dockerd, containerd, shims) and
 * the containers' slice. Peaks are high-water marks since each cgroup was created.
 */
export const sampleLimits = async (vm: FakeSandbox, label: string) => {
  const id = (await dockerOk(["inspect", "-f", "{{.Id}}", vm.container])).trim();
  const twin = `/sys/fs/cgroup/system.slice/docker-${id}.scope`;
  // A slice nests by its name; the agent resolves it from systemd and so does this.
  const unitCgroup = async (unit: string) => {
    const shown = await docker(
      ["exec", vm.container, "systemctl", "show", "--property", "ControlGroup", "--value", unit],
      { timeoutMs: 10_000 },
    );
    const control = shown.stdout.trim();
    return control.startsWith("/") ? join("/sys/fs/cgroup", control) : `/sys/fs/cgroup/${unit}`;
  };
  return {
    label,
    at: new Date().toISOString(),
    twin: await sampleHost(twin),
    session: await sampleGuest(vm, await unitCgroup("sealant-agent.service")),
    dockerEngine: await sampleGuest(vm, "/sys/fs/cgroup/sealant-docker-engine"),
    dockerContainers: await sampleGuest(vm, await unitCgroup("sealant-docker.slice")),
  };
};

const mib = (bytes: number) => (bytes / 1024 ** 2).toFixed(0);
export const describeLimits = (sample: Awaited<ReturnType<typeof sampleLimits>>) =>
  [
    `${sample.label}:`,
    ...[sample.twin, sample.session, sample.dockerEngine, sample.dockerContainers].map(
      (entry) =>
        `  ${entry.cgroup}: memory peak ${mib(entry.memoryPeakBytes)} MiB (now ${mib(entry.memoryCurrentBytes)}), tasks peak ${String(entry.pidsPeak)} (now ${String(entry.pidsCurrent)})`,
    ),
  ].join("\n");

/** A minimal Node app with one dependency and the lockfile `npm ci` needs, made on the host. */
export const nodeApp = async () => {
  const dir = await mkdtemp(join(tmpdir(), "boat-twin-node-app."));
  try {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify(
        {
          name: "boat-harness-node-app",
          version: "1.0.0",
          private: true,
          type: "module",
          dependencies: { ms: "2.1.3" },
        },
        null,
        2,
      ) + "\n",
    );
    await run("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit"], {
      cwd: dir,
    });
    return {
      "package.json": await readFile(join(dir, "package.json"), "utf8"),
      "package-lock.json": await readFile(join(dir, "package-lock.json"), "utf8"),
      "index.mjs": 'import ms from "ms";\nconsole.log(`ms(1000) = ${ms(1000)}`);\n',
      Dockerfile: [
        "FROM node:24-alpine AS builder",
        "WORKDIR /app",
        "COPY package.json package-lock.json ./",
        "RUN npm ci",
        "COPY index.mjs ./",
        "",
        "FROM node:24-alpine",
        "WORKDIR /app",
        "COPY --from=builder /app /app",
        'CMD ["node", "index.mjs"]',
        "",
      ].join("\n"),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

/** Runs the image's VM probe in the twin as root, with the host-network container pass. */
export const vmProbe = async (vm: FakeSandbox, transcript: Transcript, outFile: string) => {
  const script = join(here, "../boat-image/vm-probe.sh");
  await dockerOk(["cp", script, `${vm.container}:/tmp/vm-probe.sh`]);
  const result = await docker(
    [
      "exec",
      "-e",
      "DOCKER_HOST=unix:///run/docker/docker.sock",
      vm.container,
      "/bin/bash",
      "/tmp/vm-probe.sh",
      "--host-network-container",
      "ubuntu:24.04",
    ],
    { timeoutMs: 10 * 60_000 },
  );
  const text = `# vm-probe.sh in twin ${vm.container} (exit ${String(result.code)})\n${result.stdout}${result.stderr === "" ? "" : `--- stderr\n${result.stderr}`}`;
  await writeFile(outFile, text);
  await transcript.note(text);
  return result;
};

export interface DockerScenarioResult {
  readonly limits: Awaited<ReturnType<typeof sampleLimits>>[];
}

/**
 * The Docker scenario's body, from a ready launch to the measurements. The caller stops the
 * workspace and checks the release.
 */
export const dockerScenario = async (
  stack: HarnessStack,
  run_: Launch,
  transcript: Transcript,
): Promise<DockerScenarioResult> => {
  const vm = sessionVm(stack, run_);
  const limits: Awaited<ReturnType<typeof sampleLimits>>[] = [];
  const measure = async (label: string) => {
    const sample = await sampleLimits(vm, label);
    limits.push(sample);
    await transcript.note(describeLimits(sample));
    await writeFile(join(evidenceDir(stack), "limits.json"), JSON.stringify(limits, null, 1));
  };
  await measure("ready");

  await preparePerson(run_, transcript);

  // Who we are, and what Docker we see.
  const identity = await asPerson(
    run_,
    transcript,
    "identity",
    "id; echo DOCKER_HOST=$DOCKER_HOST; docker version --format '{{.Server.Version}}'",
  );
  expect(identity).toContain(`uid=${String(PERSON.uid)}`);

  await asPerson(run_, transcript, "hello-world", "docker run --rm hello-world");

  await putFile(run_, transcript, "~/hb/Dockerfile", "FROM alpine\nRUN echo ok\n");
  const build = await asPerson(
    run_,
    transcript,
    "docker build",
    "docker build -q -t harness-ok ~/hb && docker image ls --format '{{.Repository}}:{{.Tag}}' harness-ok",
  );
  expect(build).toContain("harness-ok:latest");

  // Compose: one service that must reach the project's `db` by its gateway DNS name.
  await putFile(
    run_,
    transcript,
    "~/compose/compose.yaml",
    [
      "services:",
      "  check:",
      "    image: postgres:17-alpine",
      '    command: ["sh", "-c", "for i in $(seq 1 10); do pg_isready -h db -p 5432 && exit 0; sleep 1; done; exit 1"]',
      "",
    ].join("\n"),
  );
  const compose = await asPerson(
    run_,
    transcript,
    "docker compose reaches db:5432",
    "cd ~/compose && docker compose up --abort-on-container-exit --exit-code-from check 2>&1",
  );
  expect(compose).toMatch(/accepting connections/);

  // Egress: the Internet yes; metadata, the VM itself and the tunnel's endpoint no.
  const internet = await asPerson(
    run_,
    transcript,
    "container reaches the Internet",
    "docker run --rm alpine sh -c 'wget -S -q -O /dev/null https://registry-1.docker.io/v2/ 2>&1 | head -1'",
  );
  expect(internet).toMatch(/HTTP\/1\.[01] \d{3}/);
  const denied = await asPerson(
    run_,
    transcript,
    "container cannot reach private addresses",
    [
      "docker run --rm alpine sh -c '",
      // The metadata address and the VM's own agent port. (Not the legacy UDP gateway endpoint:
      // a carried VM is never told it, and to the VM it is just a public host.)
      "for target in 169.254.169.254:80 " +
        `${vm.ip ?? "127.0.0.1"}:8080; do ` +
        "host=${target%:*}; port=${target#*:}; " +
        'if nc -z -w 3 $host $port 2>/dev/null; then echo "$target reachable"; else echo "$target blocked"; fi; done\'',
    ].join(""),
  );
  expect(denied).not.toContain("reachable");
  expect(denied.split("\n").filter((line) => line.endsWith("blocked"))).toHaveLength(2);
  await measure("after hello-world, build, compose and egress checks");

  // Limits: a two-stage Node build with `npm ci`, the heaviest ordinary thing a session does.
  const app = await nodeApp();
  for (const [name, content] of Object.entries(app))
    await putFile(run_, transcript, `~/node-app/${name}`, content);
  const nodeBuild = await asPerson(
    run_,
    transcript,
    "two-stage Node build with npm ci",
    "cd ~/node-app && docker build --progress=plain -t harness-node . 2>&1 | tail -40 && docker run --rm harness-node",
  );
  expect(nodeBuild).toContain("ms(1000) = 1s");
  await measure("after the Node build");

  // The probe, as root in the VM.
  await vmProbe(vm, transcript, join(evidenceDir(stack), "vm-probe.txt"));

  // What the session leaves on the VM's disk, for the record.
  await asPerson(
    run_,
    transcript,
    "images on the workspace's Docker",
    "docker image ls --format '{{.Repository}}:{{.Tag}} {{.Size}}'; docker system df",
  );
  return { limits };
};
