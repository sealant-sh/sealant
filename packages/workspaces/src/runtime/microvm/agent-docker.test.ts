import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import {
  AGENT_CONTROL_ROUTE,
  AGENT_HEALTH_ROUTE,
  AGENT_LAUNCH_ROUTE,
  agentHealthResponseSchema,
  HOOK_ROUTE_PREFIX,
  launchSecretForRun,
} from "./agent-contract.js";

const AGENT = fileURLToPath(new URL("../../../microvm-image/agent.mjs", import.meta.url));
const DOCKER_SOCKET = "/run/docker/docker.sock";
const launchSecret = launchSecretForRun("docker-control-token", "docker-run-1");

const FAKE_SEALANTD = `#!/usr/bin/env node
const fs = require("node:fs");
const net = require("node:net");
const socketPath = process.env.SEALANT_CONTROL_SOCKET;
const records = process.env.FAKE_SEALANTD_RECORD;
fs.appendFileSync(records, JSON.stringify({ argv: process.argv.slice(2), env: process.env, pid: process.pid }) + "\\n");
try { fs.unlinkSync(socketPath); } catch {}
const server = net.createServer((socket) => socket.pipe(socket));
server.listen(socketPath);
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`;

const FAKE_SEALANTCTL = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_SEALANTCTL_LOG"
exit 0
`;

const FAKE_DOCKERD = `#!/usr/bin/env node
const fs = require("node:fs");
const { spawn } = require("node:child_process");
fs.appendFileSync(process.env.FAKE_DOCKERD_RECORD, JSON.stringify({ argv: process.argv.slice(2), pid: process.pid }) + "\\n");
fs.writeFileSync(process.env.FAKE_DOCKERD_PID, String(process.pid));
const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
fs.writeFileSync(process.env.FAKE_DOCKERD_DESCENDANT_PID, String(descendant.pid));
const stderrBytes = Number(process.env.FAKE_DOCKERD_STDERR_BYTES || 0);
if (stderrBytes > 0) process.stderr.write(Buffer.alloc(stderrBytes, 0x64));
if (process.env.FAKE_DOCKERD_STDERR_TEXT) {
  process.stderr.write(
    process.env.FAKE_DOCKERD_STDERR_TEXT.replaceAll(
      "__DOCKER_SOCKET__",
      process.env.SEALANT_MICROVM_DOCKER_SOCKET,
    ),
  );
}
const delay = Number(process.env.FAKE_DOCKERD_EXIT_AFTER_MS || 0);
if (delay > 0) setTimeout(() => process.exit(Number(process.env.FAKE_DOCKERD_EXIT_CODE || 0)), delay);
setInterval(() => {}, 1000);
if (process.env.FAKE_DOCKERD_IGNORE_SIGTERM === "1") {
  process.on("SIGTERM", () => {});
} else {
  process.on("SIGTERM", () => process.exit(0));
}
fs.writeFileSync(process.env.FAKE_DOCKERD_STARTED_FILE, "started");
`;

const FAKE_DOCKER = `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(process.env.FAKE_DOCKER_PROBE_RECORD, JSON.stringify({ argv: process.argv.slice(2), dockerHost: process.env.DOCKER_HOST || null, dockerContext: process.env.DOCKER_CONTEXT || null, pid: process.pid }) + "\\n");
const finish = () => {
  const gateFile = process.env.FAKE_DOCKER_PROBE_GATE_FILE;
  if (gateFile && !fs.existsSync(gateFile)) {
    setTimeout(finish, 5);
    return;
  }
  const sequenceFile = process.env.FAKE_DOCKER_PROBE_SEQUENCE_FILE;
  if (sequenceFile && fs.existsSync(sequenceFile)) {
    const sequence = fs.readFileSync(sequenceFile, "utf8");
    if (sequence.length > 0) {
      fs.writeFileSync(sequenceFile, sequence.slice(1));
      process.exit(sequence[0] === "S" ? 0 : 1);
    }
  }
  const mode = process.env.FAKE_DOCKER_PROBE_MODE || "ready";
  if (mode === "ready") process.exit(0);
  if (mode === "marker" && fs.existsSync(process.env.FAKE_DOCKER_READY_FILE)) process.exit(0);
  process.exit(1);
};
setTimeout(finish, Number(process.env.FAKE_DOCKER_PROBE_DELAY_MS || 0));
`;

interface Agent {
  readonly child: ChildProcess;
  readonly port: number;
  readonly dir: string;
  readonly recordFile: string;
  readonly ctlLog: string;
  readonly dockerdRecord: string;
  readonly dockerdPid: string;
  readonly dockerdDescendantPid: string;
  readonly dockerdStartedFile: string;
  readonly dockerSocket: string;
  readonly dockerDataRoot: string;
  readonly dockerExecRoot: string;
  readonly dockerPidFile: string;
  readonly dockerLog: string;
  readonly probeRecord: string;
  readonly probeSequenceFile: string;
  readonly probeGateFile: string;
  readonly readyFile: string;
  readonly output: () => string;
}

const runningAgents = new Set<Agent>();

const startAgent = async (extraEnv: Record<string, string> = {}): Promise<Agent> => {
  const dir = await mkdtemp(path.join(tmpdir(), "microvm-docker-agent-"));
  const bin = path.join(dir, "bin");
  await mkdir(bin);
  const sealantd = path.join(bin, "sealantd");
  const sealantctl = path.join(bin, "sealantctl");
  const dockerd = path.join(bin, "dockerd");
  const docker = path.join(bin, "docker");
  await Promise.all([
    writeFile(sealantd, FAKE_SEALANTD),
    writeFile(sealantctl, FAKE_SEALANTCTL),
    writeFile(dockerd, FAKE_DOCKERD),
    writeFile(docker, FAKE_DOCKER),
  ]);
  await Promise.all([
    chmod(sealantd, 0o755),
    chmod(sealantctl, 0o755),
    chmod(dockerd, 0o755),
    chmod(docker, 0o755),
  ]);

  const recordFile = path.join(dir, "sealantd.jsonl");
  const ctlLog = path.join(dir, "sealantctl.log");
  const dockerdRecord = path.join(dir, "dockerd.jsonl");
  const dockerdPid = path.join(dir, "dockerd.pid");
  const dockerdDescendantPid = path.join(dir, "dockerd-descendant.pid");
  const dockerdStartedFile = path.join(dir, "dockerd-started");
  const dockerSocket = path.join(dir, "runtime", "docker", "docker.sock");
  const dockerDataRoot = path.join(dir, "runtime", "docker-data");
  const dockerExecRoot = path.join(dir, "runtime", "sealant", "docker-exec");
  const dockerPidFile = path.join(dir, "runtime", "sealant", "docker.pid");
  const dockerLog = path.join(dir, "dockerd.stderr.log");
  const probeRecord = path.join(dir, "docker-probes.jsonl");
  const probeSequenceFile = path.join(dir, "docker-probe-sequence");
  const probeGateFile = path.join(dir, "docker-probe-gate");
  const readyFile = path.join(dir, "docker-ready");
  await writeFile(probeGateFile, "open");
  const child = spawn(process.execPath, [AGENT], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env["PATH"] ?? ""}`,
      SEALANT_MICROVM_AGENT_PORT: "0",
      SEALANT_MICROVM_AGENT_STATE_DIR: path.join(dir, "state"),
      SEALANT_CONTROL_SOCKET: path.join(dir, "control.sock"),
      SEALANT_MICROVM_SEALANTD: sealantd,
      SEALANT_MICROVM_SEALANTCTL: sealantctl,
      SEALANT_MICROVM_DOCKER_CAPABLE: "1",
      SEALANT_MICROVM_DOCKERD: dockerd,
      SEALANT_MICROVM_DOCKER: docker,
      SEALANT_MICROVM_DOCKER_SOCKET: dockerSocket,
      SEALANT_MICROVM_DOCKER_DATA_ROOT: dockerDataRoot,
      SEALANT_MICROVM_DOCKER_EXEC_ROOT: dockerExecRoot,
      SEALANT_MICROVM_DOCKER_PID_FILE: dockerPidFile,
      SEALANT_MICROVM_DOCKER_READY_TIMEOUT_MS: "350",
      SEALANT_MICROVM_DOCKER_PROBE_INTERVAL_MS: "30",
      SEALANT_MICROVM_DOCKER_PROBE_TIMEOUT_MS: "150",
      SEALANT_MICROVM_DOCKER_SHUTDOWN_TIMEOUT_MS: "150",
      SEALANT_MICROVM_DOCKER_LOG: dockerLog,
      SEALANT_MICROVM_DOCKER_LOG_MAX_BYTES: "128",
      FAKE_SEALANTD_RECORD: recordFile,
      FAKE_SEALANTCTL_LOG: ctlLog,
      FAKE_DOCKERD_RECORD: dockerdRecord,
      FAKE_DOCKERD_PID: dockerdPid,
      FAKE_DOCKERD_DESCENDANT_PID: dockerdDescendantPid,
      FAKE_DOCKERD_STARTED_FILE: dockerdStartedFile,
      FAKE_DOCKER_PROBE_RECORD: probeRecord,
      FAKE_DOCKER_PROBE_SEQUENCE_FILE: probeSequenceFile,
      FAKE_DOCKER_PROBE_GATE_FILE: probeGateFile,
      FAKE_DOCKER_READY_FILE: readyFile,
      FAKE_DOCKER_PROBE_MODE: "marker",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  const port = await new Promise<number>((resolve, reject) => {
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const match = /listening on :(\d+)/.exec(output);
      if (match?.[1] !== undefined) resolve(Number(match[1]));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.once("exit", (code) => reject(new Error(`agent exited early (${code}): ${output}`)));
  });
  const agent = {
    child,
    port,
    dir,
    recordFile,
    ctlLog,
    dockerdRecord,
    dockerdPid,
    dockerdDescendantPid,
    dockerdStartedFile,
    dockerSocket,
    dockerDataRoot,
    dockerExecRoot,
    dockerPidFile,
    dockerLog,
    probeRecord,
    probeSequenceFile,
    probeGateFile,
    readyFile,
    output: () => output,
  };
  runningAgents.add(agent);
  return agent;
};

const stopAgent = async (agent: Agent, signal: NodeJS.Signals = "SIGTERM"): Promise<void> => {
  if (agent.child.exitCode === null && agent.child.signalCode === null) {
    agent.child.kill(signal);
    await new Promise<void>((resolve) => agent.child.once("exit", () => resolve()));
  }
  runningAgents.delete(agent);
  await rm(agent.dir, { recursive: true, force: true });
};

afterEach(async () => {
  await Promise.all([...runningAgents].map((agent) => stopAgent(agent)));
});

const call = async (
  agent: Agent,
  method: string,
  route: string,
  options: { readonly body?: unknown; readonly bearer?: string } = {},
): Promise<{ readonly status: number; readonly body: unknown }> => {
  const response = await fetch(`http://127.0.0.1:${agent.port}${route}`, {
    method,
    headers: {
      ...(options.bearer === undefined ? {} : { authorization: `Bearer ${options.bearer}` }),
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  return { status: response.status, body: await response.json() };
};

const hook = (agent: Agent, name: string, body?: unknown) =>
  call(agent, "POST", `${HOOK_ROUTE_PREFIX}/${name}`, body === undefined ? {} : { body });

const runV2 = (agent: Agent) =>
  hook(agent, "run", {
    microvmId: "microvm-docker-1",
    runHookPayload: JSON.stringify({
      version: 2,
      runId: "docker-run-1",
      launchSecret,
      services: { docker: "required" },
    }),
  });

const launchV2 = (agent: Agent, overrides: Record<string, unknown> = {}) =>
  call(agent, "POST", AGENT_LAUNCH_ROUTE, {
    bearer: launchSecret,
    body: {
      version: 2,
      runId: "docker-run-1",
      controlToken: "docker-control-token",
      flushTimeoutMs: 400,
      bootEnv: {},
      services: { docker: "required" },
      ...overrides,
    },
  });

const health = async (agent: Agent) => {
  const response = await call(agent, "GET", AGENT_HEALTH_ROUTE, {
    bearer: "docker-control-token",
  });
  const serialized = JSON.stringify(response.body);
  if (serialized.includes('"status":"ready"')) {
    expect(serialized).toContain(`"socket":${JSON.stringify(agent.dockerSocket)}`);
  }
  const normalized = serialized.replaceAll(
    JSON.stringify(agent.dockerSocket),
    '"/run/docker/docker.sock"',
  );
  const parsed = agentHealthResponseSchema.parse(JSON.parse(normalized));
  if (!("version" in parsed)) throw new Error("expected v2 health");
  return { status: response.status, body: parsed, docker: parsed.services.docker };
};

const waitFor = async (predicate: () => Promise<boolean>, timeoutMs = 3_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const readLines = async (file: string): Promise<ReadonlyArray<string>> => {
  const contents = await readFile(file, "utf8").catch(() => "");
  return contents.trim() === "" ? [] : contents.trim().split("\n");
};

const processExists = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("microvm agent guest-local Docker", () => {
  it("rejects a v2 run before 200 when the image is not Docker-capable", async () => {
    const agent = await startAgent({ SEALANT_MICROVM_DOCKER_CAPABLE: "0" });
    expect(await runV2(agent)).toMatchObject({ status: 500 });
    expect(await launchV2(agent)).toMatchObject({ status: 503 });
  });

  it("starts Docker only during validation, returns 503 until cleanup, and blocks a run", async () => {
    const agent = await startAgent();

    expect(await hook(agent, "ready")).toMatchObject({ status: 200 });
    expect(await readLines(agent.dockerdRecord)).toEqual([]);
    expect(await readLines(agent.probeRecord)).toEqual([]);
    expect(await readLines(agent.recordFile)).toEqual([]);

    expect(await hook(agent, "validate")).toMatchObject({ status: 503 });
    await waitFor(async () => (await readLines(agent.dockerdRecord)).length === 1);
    expect(await hook(agent, "validate")).toMatchObject({ status: 503 });
    expect(await runV2(agent)).toMatchObject({ status: 500 });
    expect(await readLines(agent.dockerdRecord)).toHaveLength(1);
    expect(await readLines(agent.recordFile)).toEqual([]);

    const dockerPid = Number(await readFile(agent.dockerdPid, "utf8"));
    await writeFile(agent.readyFile, "ready");
    await waitFor(async () => (await hook(agent, "validate")).status === 200);
    expect(await hook(agent, "validate")).toMatchObject({ status: 200 });
    await waitFor(async () => !processExists(dockerPid));
    expect(await readLines(agent.dockerdRecord)).toHaveLength(1);
    expect(await readLines(agent.recordFile)).toEqual([]);
  });

  it("rejects invalid and mismatched service requirements and protocol versions", async () => {
    const agent = await startAgent();
    expect(
      await hook(agent, "run", {
        runHookPayload: JSON.stringify({ version: 2, runId: "docker-run-1", launchSecret }),
      }),
    ).toMatchObject({ status: 500 });
    expect(
      await hook(agent, "run", {
        runHookPayload: JSON.stringify({
          version: 1,
          runId: "docker-run-1",
          launchSecret,
          services: { docker: "required" },
        }),
      }),
    ).toMatchObject({ status: 500 });
    expect(
      await hook(agent, "run", {
        runHookPayload: JSON.stringify({
          version: 2,
          runId: "docker-run-1",
          launchSecret,
          services: { docker: "required" },
          extra: true,
        }),
      }),
    ).toMatchObject({ status: 500 });
    expect(await runV2(agent)).toMatchObject({ status: 200 });
    expect(await launchV2(agent, { version: 1, services: undefined })).toMatchObject({
      status: 400,
    });
    expect(await launchV2(agent, { services: { docker: "optional" } })).toMatchObject({
      status: 400,
    });
    expect(await launchV2(agent, { extra: true })).toMatchObject({ status: 400 });
  });

  it("reports a missing dockerd binary as spawn-failed without starting sealantd", async () => {
    const agent = await startAgent({
      SEALANT_MICROVM_DOCKERD: path.join(tmpdir(), "missing-dockerd"),
    });
    expect(await runV2(agent)).toMatchObject({ status: 200 });
    expect(await launchV2(agent)).toMatchObject({ status: 200 });
    await waitFor(async () => (await health(agent)).docker.status === "failed");
    expect(await health(agent)).toMatchObject({
      status: 503,
      docker: { status: "failed", reason: "spawn-failed", code: null, signal: null },
    });
    expect(await readLines(agent.recordFile)).toEqual([]);
  });

  it("reports a nonzero dockerd exit and a probe readiness timeout", async () => {
    const exited = await startAgent({
      FAKE_DOCKERD_EXIT_AFTER_MS: "40",
      FAKE_DOCKERD_EXIT_CODE: "17",
      FAKE_DOCKERD_STDERR_BYTES: "512",
    });
    expect(await runV2(exited)).toMatchObject({ status: 200 });
    expect(await launchV2(exited)).toMatchObject({ status: 200 });
    await waitFor(async () => (await health(exited)).docker.status === "failed");
    const exitedHealth = await health(exited);
    expect(exitedHealth).toMatchObject({
      status: 503,
      docker: { status: "failed", reason: "exited", code: 17, signal: null },
    });
    const descendantPid = Number(await readFile(exited.dockerdDescendantPid, "utf8"));
    await waitFor(async () => !processExists(descendantPid));
    await waitFor(async () => (await stat(exited.dockerLog)).size === 128);
    expect((await stat(exited.dockerLog)).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(exitedHealth)).not.toContain("dddddddd");

    const timedOut = await startAgent({ FAKE_DOCKER_PROBE_MODE: "never" });
    expect(await runV2(timedOut)).toMatchObject({ status: 200 });
    expect(await launchV2(timedOut)).toMatchObject({ status: 200 });
    await waitFor(async () => (await health(timedOut)).docker.status === "failed");
    expect(await health(timedOut)).toMatchObject({
      status: 503,
      docker: { status: "failed", reason: "readiness-timeout", code: null, signal: null },
    });
    expect(await readLines(timedOut.recordFile)).toEqual([]);
  });

  it("reports a missing validation binary without exposing a spawn error", async () => {
    const missingDockerd = path.join(
      tmpdir(),
      `missing-validation-dockerd-${process.pid}-${Date.now()}`,
    );
    const agent = await startAgent({ SEALANT_MICROVM_DOCKERD: missingDockerd });

    expect(await hook(agent, "validate")).toMatchObject({ status: 503 });
    await waitFor(async () => agent.output().includes("docker-image-validation-failed"));
    expect(await hook(agent, "validate")).toMatchObject({ status: 500 });
    expect(agent.output()).toContain('"reason":"spawn-failed"');
    expect(agent.output()).toContain('"missingBinary":true');
    expect(agent.output()).toContain('"dockerdBinaryExists":false');
    expect(agent.output()).not.toContain(missingDockerd);
  });

  it("emits only allowlisted validation failure facts and keeps raw stderr private", async () => {
    const privateText = "PRIVATE_TARGET=do-not-print";
    const agent = await startAgent({
      FAKE_DOCKERD_EXIT_AFTER_MS: "40",
      FAKE_DOCKERD_EXIT_CODE: "17",
      FAKE_DOCKERD_STDERR_TEXT: [
        privateText,
        "mkdir /sys/fs/cgroup/docker: read-only file system",
        "failed to mount overlay: operation not permitted",
        "error initializing graphdriver: driver not supported",
        'Error initializing network controller: failed to register "bridge" driver',
        "failed to create NAT chain DOCKER: iptables failed",
        "failed to start containerd: timeout waiting for containerd to start",
        "dockerd needs to be started with root privileges",
        "can't create unix socket __DOCKER_SOCKET__: no such file or directory",
      ].join("\n"),
    });

    expect(await hook(agent, "validate")).toMatchObject({ status: 503 });
    await waitFor(async () => agent.output().includes("docker-image-validation-failed"));
    expect(await hook(agent, "validate")).toMatchObject({ status: 500 });
    expect(await hook(agent, "validate")).toMatchObject({ status: 500 });
    expect(agent.output().match(/docker-image-validation-failed/g)).toHaveLength(1);
    expect(await readLines(agent.dockerdRecord)).toHaveLength(1);
    expect(agent.output()).toContain('"health":{"status":"failed","reason":"exited","code":17');
    expect(agent.output()).toContain('"cgroupReadonly":true');
    expect(agent.output()).toContain('"overlayDenied":true');
    expect(agent.output()).toContain('"graphDriverInit":true');
    expect(agent.output()).toContain('"bridgeNetworkInit":true');
    expect(agent.output()).toContain('"iptablesNetworkInit":true');
    expect(agent.output()).toContain('"containerdTimeout":true');
    expect(agent.output()).toContain('"rootPrivilegesRequired":true');
    expect(agent.output()).toContain('"dockerSocketParentMissing":true');
    expect(agent.output()).toContain('"uid":');
    expect(agent.output()).toContain('"gid":');
    expect(agent.output()).toContain('"capabilities":{"effective":');
    expect(agent.output()).toContain('"dockerSocketParentType":');
    expect(agent.output()).toContain('"dockerDataRootType":');
    expect(agent.output()).toContain('"dockerExecRootParentType":');
    expect(agent.output()).toContain('"identifiedSignature":true');
    expect(agent.output()).not.toContain(privateText);
    expect(await readFile(agent.dockerLog, "utf8")).toContain(privateText);
    expect((await stat(agent.dockerLog)).mode & 0o777).toBe(0o600);
    expect(await readLines(agent.recordFile)).toEqual([]);
  });

  it("reports an unidentified probe failure without printing probe output", async () => {
    // The probe has to start and exit 1 inside its own timeout, or what is reported is the probe's
    // timeout. A node process can take longer than the default 150 ms to start on a loaded runner.
    const agent = await startAgent({
      FAKE_DOCKER_PROBE_MODE: "never",
      SEALANT_MICROVM_DOCKER_READY_TIMEOUT_MS: "1500",
      SEALANT_MICROVM_DOCKER_PROBE_TIMEOUT_MS: "1400",
    });

    expect(await hook(agent, "validate")).toMatchObject({ status: 503 });
    await waitFor(async () => agent.output().includes("docker-image-validation-failed"));
    expect(agent.output()).toContain('"reason":"readiness-timeout"');
    expect(agent.output()).toContain('"probe":{"reason":"exited","code":1,"signal":null}');
    expect(agent.output()).toContain('"identifiedSignature":false');
    expect(await hook(agent, "validate")).toMatchObject({ status: 500 });
  });

  it("fails validation when bounded Docker cleanup needs SIGKILL", async () => {
    const agent = await startAgent({
      FAKE_DOCKERD_IGNORE_SIGTERM: "1",
      SEALANT_MICROVM_DOCKER_SHUTDOWN_TIMEOUT_MS: "50",
    });

    expect(await hook(agent, "validate")).toMatchObject({ status: 503 });
    await waitFor(async () =>
      stat(agent.dockerdStartedFile).then(
        () => true,
        () => false,
      ),
    );
    await writeFile(agent.readyFile, "ready");
    await waitFor(async () => agent.output().includes("docker-image-validation-failed"));
    expect(await hook(agent, "validate")).toMatchObject({ status: 500 });
    expect(agent.output()).toContain('"reason":"shutdown-timeout"');
    expect(agent.output()).toContain('"cleanup":{"ok":false,"forced":true,"killed":true}');
    const dockerPid = Number(await readFile(agent.dockerdPid, "utf8"));
    await waitFor(async () => !processExists(dockerPid));
    expect(await readLines(agent.recordFile)).toEqual([]);
  });

  it("waits for docker info, pins the guest socket, and accepts the launch only once", async () => {
    const agent = await startAgent({
      DOCKER_HOST: "tcp://process-env.invalid:2375",
      DOCKER_CONTEXT: "remote",
    });
    expect(await runV2(agent)).toMatchObject({ status: 200 });
    for (const key of [
      "DOCKER_HOST",
      "DOCKER_CONTEXT",
      "DOCKER_TLS_CERTDIR",
      "DOCKER_TLS_VERIFY",
      "DOCKER_CERT_PATH",
    ]) {
      expect(
        await launchV2(agent, {
          secretEnvJson: JSON.stringify({ [key]: "remote-value" }),
        }),
      ).toMatchObject({ status: 400 });
    }
    const acceptedRequest = {
      bootEnv: {
        DOCKER_HOST: "tcp://boot-env.invalid:2375",
        DOCKER_CONTEXT: "boot-remote",
        DOCKER_TLS_VERIFY: "1",
      },
      secretEnvJson: JSON.stringify({
        TOKEN: "launch-secret-value",
        DOCKER_CONFIG: "/workspace/.docker",
      }),
    };
    const concurrent = await Promise.all([
      launchV2(agent, acceptedRequest),
      launchV2(agent, acceptedRequest),
    ]);
    expect(concurrent.map(({ status }) => status).toSorted()).toEqual([200, 409]);
    expect(await launchV2(agent)).toMatchObject({ status: 409 });

    await waitFor(async () => (await readLines(agent.probeRecord)).length > 0);
    expect(await health(agent)).toMatchObject({
      status: 503,
      body: {
        version: 2,
        booted: false,
        controlSocket: false,
        services: { docker: { status: "starting" } },
      },
    });
    expect(await readLines(agent.recordFile)).toEqual([]);

    const probe = JSON.parse((await readLines(agent.probeRecord))[0] ?? "{}");
    expect(probe).toMatchObject({
      argv: ["--host", `unix://${agent.dockerSocket}`, "info"],
      dockerHost: null,
      dockerContext: null,
    });
    const secretEnv = JSON.parse(
      await readFile(path.join(agent.dir, "state", "secrets", "env.json"), "utf8"),
    );
    expect(secretEnv).toEqual({
      TOKEN: "launch-secret-value",
      DOCKER_CONFIG: "/workspace/.docker",
    });

    await writeFile(agent.readyFile, "ready");
    await waitFor(async () => (await health(agent)).status === 200);
    expect(await health(agent)).toMatchObject({
      status: 200,
      body: {
        version: 2,
        booted: true,
        controlSocket: true,
        services: { docker: { status: "ready", socket: DOCKER_SOCKET } },
      },
    });
    expect(await hook(agent, "resume")).toMatchObject({ status: 200 });

    const daemonRecords = await readLines(agent.recordFile);
    const dockerdRecords = await readLines(agent.dockerdRecord);
    expect(daemonRecords).toHaveLength(1);
    expect(dockerdRecords).toHaveLength(1);
    expect(JSON.parse(daemonRecords[0] ?? "{}")).toMatchObject({
      argv: ["boot"],
      env: {
        DOCKER_HOST: `unix://${agent.dockerSocket}`,
        DOCKER_CONTEXT: "",
        DOCKER_TLS_CERTDIR: "",
        DOCKER_TLS_VERIFY: "",
      },
    });
    expect(JSON.parse(dockerdRecords[0] ?? "{}").argv).toEqual([
      "--host",
      `unix://${agent.dockerSocket}`,
      "--data-root",
      agent.dockerDataRoot,
      "--exec-root",
      agent.dockerExecRoot,
      "--pidfile",
      agent.dockerPidFile,
    ]);

    expect(await hook(agent, "validate")).toMatchObject({ status: 503 });
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(await readLines(agent.dockerdRecord)).toHaveLength(1);
    expect(await readLines(agent.recordFile)).toHaveLength(1);
    expect(await health(agent)).toMatchObject({ status: 200 });
  });

  it("tolerates one missed runtime probe, resets on recovery, then fails sustained loss", async () => {
    const agent = await startAgent({
      SEALANT_MICROVM_DOCKER_PROBE_INTERVAL_MS: "200",
      FAKE_DOCKER_PROBE_DELAY_MS: "80",
    });
    expect(await runV2(agent)).toMatchObject({ status: 200 });
    await writeFile(agent.readyFile, "ready");
    expect(await launchV2(agent)).toMatchObject({ status: 200 });
    await waitFor(async () => (await health(agent)).status === 200);

    const initialProbeCount = (await readLines(agent.probeRecord)).length;
    await unlink(agent.probeGateFile);
    await writeFile(agent.probeSequenceFile, "F");
    await waitFor(async () => (await readLines(agent.probeRecord)).length > initialProbeCount);
    const resumes = [hook(agent, "resume"), hook(agent, "resume")];
    await writeFile(agent.probeGateFile, "open");
    const concurrentResume = await Promise.all(resumes);
    expect(concurrentResume.map(({ status }) => status)).toEqual([503, 503]);
    expect(await readLines(agent.probeRecord)).toHaveLength(initialProbeCount + 1);
    expect(await health(agent)).toMatchObject({
      status: 200,
      docker: { status: "ready", socket: DOCKER_SOCKET },
    });

    await writeFile(agent.probeSequenceFile, "S");
    await waitFor(async () => (await readLines(agent.probeRecord)).length > initialProbeCount + 1);
    expect(await hook(agent, "resume")).toMatchObject({ status: 200 });
    expect(await health(agent)).toMatchObject({ status: 200 });

    await writeFile(agent.probeSequenceFile, "FFF");
    await waitFor(async () => (await health(agent)).docker.status === "failed");
    expect(await health(agent)).toMatchObject({
      status: 503,
      docker: { status: "failed", reason: "probe-failed", code: null, signal: null },
    });
    expect(await hook(agent, "resume")).toMatchObject({ status: 503 });

    const socket = new WebSocket(`ws://127.0.0.1:${agent.port}${AGENT_CONTROL_ROUTE}`, {
      headers: { authorization: "Bearer docker-control-token" },
    });
    const refusal = await new Promise<string>((resolve) => {
      socket.once("error", (error) => resolve(error.message));
    });
    expect(refusal).toContain("503");

    expect(await hook(agent, "terminate")).toMatchObject({
      status: 200,
      body: { flush: { ok: true } },
    });
    expect((await readFile(agent.ctlLog, "utf8")).trim()).toBe(
      `--socket ${path.join(agent.dir, "control.sock")} capture flush`,
    );
    expect(await readLines(agent.recordFile)).toHaveLength(1);
  });

  it("keeps a racing resume failed after dockerd exits without killing sealantd", async () => {
    const agent = await startAgent({
      FAKE_DOCKER_PROBE_DELAY_MS: "100",
      SEALANT_MICROVM_DOCKER_PROBE_TIMEOUT_MS: "500",
    });
    expect(await runV2(agent)).toMatchObject({ status: 200 });
    await writeFile(agent.readyFile, "ready");
    expect(await launchV2(agent)).toMatchObject({ status: 200 });
    await waitFor(async () => (await health(agent)).status === 200);
    const dockerPid = Number(await readFile(agent.dockerdPid, "utf8"));
    await unlink(agent.probeGateFile);
    const probesBefore = (await readLines(agent.probeRecord)).length;
    await waitFor(async () => (await readLines(agent.probeRecord)).length > probesBefore);
    const resume = hook(agent, "resume");
    process.kill(dockerPid, "SIGTERM");
    await waitFor(async () => (await health(agent)).docker.status === "failed");
    await writeFile(agent.probeGateFile, "open");
    expect(await resume).toMatchObject({ status: 503 });
    expect(await health(agent)).toMatchObject({
      status: 503,
      docker: { status: "failed", reason: "exited", code: 0, signal: null },
    });
    expect(await readLines(agent.recordFile)).toHaveLength(1);
    expect(
      await stat(path.join(agent.dir, "control.sock")).then(
        () => true,
        () => false,
      ),
    ).toBe(true);
  });

  it("stops Docker, sealantd and probe work on SIGTERM", async () => {
    const agent = await startAgent();
    expect(await runV2(agent)).toMatchObject({ status: 200 });
    await writeFile(agent.readyFile, "ready");
    expect(await launchV2(agent)).toMatchObject({ status: 200 });
    await waitFor(async () => (await health(agent)).status === 200);

    const dockerPid = Number(await readFile(agent.dockerdPid, "utf8"));
    const descendantPid = Number(await readFile(agent.dockerdDescendantPid, "utf8"));
    const daemonRecord = JSON.parse((await readLines(agent.recordFile))[0] ?? "{}");
    const daemonPid = Number(daemonRecord.pid);
    agent.child.kill("SIGTERM");
    await new Promise<void>((resolve) => agent.child.once("exit", () => resolve()));
    runningAgents.delete(agent);
    const probesAtExit = (await readLines(agent.probeRecord)).length;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(processExists(dockerPid)).toBe(false);
    expect(processExists(descendantPid)).toBe(false);
    expect(processExists(daemonPid)).toBe(false);
    expect(await readLines(agent.probeRecord)).toHaveLength(probesAtExit);
    await rm(agent.dir, { recursive: true, force: true });
  });
});
