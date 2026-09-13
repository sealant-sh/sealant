/**
 * The in-VM agent (`microvm-image/agent.mjs`), spawned for real with a fake `sealantd` (a Unix
 * socket echo server that records its environment) and a fake `sealantctl` (records argv, can
 * stall) on PATH: lifecycle hooks, the launch push (auth, files, daemon env), health, the
 * WebSocket ↔ control-socket relay, and the bounded capture flush in the suspend/terminate hooks.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import {
  AGENT_CONTROL_ROUTE,
  AGENT_HEALTH_ROUTE,
  AGENT_LAUNCH_ROUTE,
  agentHealthResponseSchema,
  agentLaunchResponseSchema,
  HOOK_ROUTE_PREFIX,
  launchSecretForRun,
  type AgentLaunchRequest,
} from "./agent-contract.js";

const AGENT = fileURLToPath(new URL("../../../microvm-image/agent.mjs", import.meta.url));

const FAKE_SEALANTD = `#!/usr/bin/env node
// Fake sealantd: records its argv + environment, then echoes bytes on the control socket.
const fs = require("node:fs");
const net = require("node:net");
const socketPath = process.env.SEALANT_CONTROL_SOCKET;
fs.writeFileSync(process.env.FAKE_SEALANTD_RECORD, JSON.stringify({ argv: process.argv.slice(2), env: process.env }));
const server = net.createServer((socket) => socket.pipe(socket));
server.listen(socketPath);
process.on("SIGTERM", () => { server.close(); process.exit(0); });
`;

const FAKE_SEALANTCTL = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_SEALANTCTL_LOG"
if [ -n "$FAKE_SEALANTCTL_SLEEP" ]; then sleep "$FAKE_SEALANTCTL_SLEEP"; fi
exit "\${FAKE_SEALANTCTL_EXIT:-0}"
`;

const launchSecret = launchSecretForRun("control-token", "run-1");

interface Agent {
  readonly child: ChildProcess;
  readonly port: number;
  readonly dir: string;
  readonly stateDir: string;
  readonly socketPath: string;
  readonly recordFile: string;
  readonly ctlLog: string;
}

const startAgent = async (extraEnv: Record<string, string> = {}): Promise<Agent> => {
  const dir = await mkdtemp(path.join(tmpdir(), "microvm-agent-"));
  const bin = path.join(dir, "bin");
  await mkdir(bin);
  await writeFile(path.join(bin, "sealantd"), FAKE_SEALANTD);
  await writeFile(path.join(bin, "sealantctl"), FAKE_SEALANTCTL);
  await chmod(path.join(bin, "sealantd"), 0o755);
  await chmod(path.join(bin, "sealantctl"), 0o755);
  const stateDir = path.join(dir, "state");
  const socketPath = path.join(dir, "control.sock");
  const recordFile = path.join(dir, "sealantd-record.json");
  const ctlLog = path.join(dir, "sealantctl.log");
  const child = spawn(process.execPath, [AGENT], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env["PATH"] ?? ""}`,
      SEALANT_MICROVM_AGENT_PORT: "0",
      SEALANT_MICROVM_AGENT_STATE_DIR: stateDir,
      SEALANT_CONTROL_SOCKET: socketPath,
      SEALANT_MICROVM_SEALANTD: path.join(bin, "sealantd"),
      FAKE_SEALANTD_RECORD: recordFile,
      FAKE_SEALANTCTL_LOG: ctlLog,
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const port = await new Promise<number>((resolve, reject) => {
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const match = /listening on :(\d+)/.exec(output);
      if (match?.[1] !== undefined) {
        resolve(Number(match[1]));
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.once("exit", (code) => reject(new Error(`agent exited early (${code}): ${output}`)));
  });
  return { child, port, dir, stateDir, socketPath, recordFile, ctlLog };
};

const stopAgent = async (agent: Agent): Promise<void> => {
  agent.child.kill("SIGKILL");
  await new Promise<void>((resolve) => agent.child.once("exit", () => resolve()));
  await rm(agent.dir, { recursive: true, force: true });
};

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

const waitFor = async (predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const launchRequest: AgentLaunchRequest = {
  version: 1,
  runId: "run-1",
  controlToken: "control-token",
  flushTimeoutMs: 400,
  bootEnv: {
    SEALANT_WORKSPACE_SOURCE: "capture",
    SEALANT_CAPTURE_ENDPOINT: "https://mend.example.com/session/s1",
    SEALANT_SECRET_ENV_FILE: "/run/sealant/secrets/env.json",
    SEALANT_DOTFILES_ARCHIVE_DIR: "/run/sealant/dotfiles",
    MEND_SESSION_ID: "1",
  },
  secretEnvJson: JSON.stringify({ SEALANT_CAPTURE_TOKEN: "mst_secret" }),
  dotfiles: {
    manifestJson: '{"archives":[{"file":"0.tar.gz","bootstrap":false}]}\n',
    archives: [{ name: "0.tar.gz", contentBase64: Buffer.from("tarball").toString("base64") }],
  },
};

describe("microvm agent", () => {
  let agent: Agent;
  beforeAll(async () => {
    agent = await startAgent();
  });
  afterAll(async () => {
    await stopAgent(agent);
  });

  it("answers the build hooks and refuses a launch before the run hook delivered a secret", async () => {
    expect((await hook(agent, "ready")).status).toBe(200);
    expect((await hook(agent, "validate")).status).toBe(200);
    expect(
      await call(agent, "POST", AGENT_LAUNCH_ROUTE, { body: launchRequest, bearer: launchSecret }),
    ).toMatchObject({
      status: 503,
    });
    expect((await call(agent, "GET", AGENT_HEALTH_ROUTE)).status).toBe(401);
    expect((await call(agent, "POST", `${HOOK_ROUTE_PREFIX}/nope`)).status).toBe(404);
  });

  it("fails the VM start (500) on a run payload that is not the contract", async () => {
    expect(
      (await hook(agent, "run", { microvmId: "microvm-1", runHookPayload: '{"probe":true}' }))
        .status,
    ).toBe(500);
  });

  it("takes the launch secret from the run hook, then accepts exactly one authorised push", async () => {
    expect(
      await hook(agent, "run", {
        microvmId: "microvm-1",
        runHookPayload: JSON.stringify({ version: 1, runId: "run-1", launchSecret }),
      }),
    ).toMatchObject({ status: 200 });

    expect(
      await call(agent, "POST", AGENT_LAUNCH_ROUTE, { body: launchRequest, bearer: "wrong" }),
    ).toMatchObject({ status: 401 });
    expect(
      await call(agent, "POST", AGENT_LAUNCH_ROUTE, {
        body: { ...launchRequest, runId: "run-2" },
        bearer: launchSecret,
      }),
    ).toMatchObject({ status: 400 });

    const accepted = await call(agent, "POST", AGENT_LAUNCH_ROUTE, {
      body: launchRequest,
      bearer: launchSecret,
    });
    expect(accepted.status).toBe(200);
    expect(agentLaunchResponseSchema.parse(accepted.body)).toEqual({ outcome: "booting" });

    // The secret env file is private and holds exactly the sealed JSON; dotfiles are staged.
    const secretFile = path.join(agent.stateDir, "secrets", "env.json");
    expect(await readFile(secretFile, "utf8")).toBe(launchRequest.secretEnvJson);
    expect((await stat(secretFile)).mode & 0o777).toBe(0o600);
    expect(await readFile(path.join(agent.stateDir, "dotfiles", "manifest.json"), "utf8")).toBe(
      launchRequest.dotfiles?.manifestJson,
    );
    expect(await readFile(path.join(agent.stateDir, "dotfiles", "0.tar.gz"), "utf8")).toBe(
      "tarball",
    );

    // sealantd boot started with the pushed env, the file paths rewritten to where they were
    // actually written, and the control socket path the relay will use.
    await waitFor(async () =>
      stat(agent.recordFile).then(
        () => true,
        () => false,
      ),
    );
    const record = JSON.parse(await readFile(agent.recordFile, "utf8")) as {
      argv: string[];
      env: Record<string, string>;
    };
    expect(record.argv).toEqual(["boot"]);
    expect(record.env).toMatchObject({
      SEALANT_WORKSPACE_SOURCE: "capture",
      SEALANT_CAPTURE_ENDPOINT: "https://mend.example.com/session/s1",
      MEND_SESSION_ID: "1",
      SEALANT_SECRET_ENV_FILE: secretFile,
      SEALANT_DOTFILES_ARCHIVE_DIR: path.join(agent.stateDir, "dotfiles"),
      SEALANT_CONTROL_SOCKET: agent.socketPath,
    });

    // A redelivered push is a 409, whatever it carries; the launch secret is spent.
    expect(
      await call(agent, "POST", AGENT_LAUNCH_ROUTE, { body: launchRequest, bearer: launchSecret }),
    ).toMatchObject({ status: 409 });
  });

  it("reports health with the control token once the daemon's socket exists", async () => {
    await waitFor(async () =>
      stat(agent.socketPath).then(
        () => true,
        () => false,
      ),
    );
    expect((await call(agent, "GET", AGENT_HEALTH_ROUTE, { bearer: "nope" })).status).toBe(401);
    const health = await call(agent, "GET", AGENT_HEALTH_ROUTE, { bearer: "control-token" });
    expect(health.status).toBe(200);
    expect(agentHealthResponseSchema.parse(health.body)).toEqual({
      booted: true,
      controlSocket: true,
    });
  });

  it("relays a WebSocket to the daemon's control socket, control token required", async () => {
    const url = `ws://127.0.0.1:${agent.port}${AGENT_CONTROL_ROUTE}`;
    const refused = new WebSocket(url, { headers: { authorization: "Bearer nope" } });
    const refusal = await new Promise<string>((resolve) => {
      refused.once("error", (error) => resolve(error.message));
    });
    expect(refusal).toContain("401");

    const socket = new WebSocket(url, {
      headers: { authorization: "Bearer control-token" },
      perMessageDeflate: false,
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    // Small, 16-bit and 64-bit length frames all round-trip through the echo daemon in order.
    const payloads = [Buffer.from("hello"), Buffer.alloc(70_000, 7), Buffer.alloc(70_000, 9)];
    const received: Buffer[] = [];
    const done = new Promise<void>((resolve) => {
      socket.on("message", (data: Buffer) => {
        received.push(Buffer.from(data));
        const total = received.reduce((sum, chunk) => sum + chunk.length, 0);
        if (total >= payloads.reduce((sum, chunk) => sum + chunk.length, 0)) resolve();
      });
    });
    for (const payload of payloads) {
      socket.send(payload, { binary: true });
    }
    await done;
    expect(Buffer.concat(received).equals(Buffer.concat(payloads))).toBe(true);
    socket.close();
  });

  it("runs the real flush command in the suspend hook and bounds it in the terminate hook", async () => {
    const suspend = await hook(agent, "suspend");
    expect(suspend.status).toBe(200);
    expect(suspend.body).toMatchObject({
      hook: "suspend",
      flush: { ok: true, exitCode: 0, timedOut: false },
    });
    expect((await readFile(agent.ctlLog, "utf8")).trim().split("\n")).toEqual([
      `--socket ${agent.socketPath} capture flush`,
    ]);

    // A stalled flush is killed at the launch-delivered bound and reported, still with a 200.
    const stalled = await startAgent({ FAKE_SEALANTCTL_SLEEP: "5" });
    try {
      await hook(stalled, "run", {
        microvmId: "microvm-2",
        runHookPayload: JSON.stringify({ version: 1, runId: "run-1", launchSecret }),
      });
      await call(stalled, "POST", AGENT_LAUNCH_ROUTE, {
        body: launchRequest,
        bearer: launchSecret,
      });
      const startedAt = Date.now();
      const terminate = await hook(stalled, "terminate");
      expect(Date.now() - startedAt).toBeLessThan(3_000);
      expect(terminate.status).toBe(200);
      expect(terminate.body).toMatchObject({
        hook: "terminate",
        flush: { ok: false, timedOut: true },
      });
    } finally {
      await stopAgent(stalled);
    }
  });

  it("answers the hooks with a no-op before boot and rejects non-hook routes", async () => {
    const fresh = await startAgent();
    try {
      expect(await hook(fresh, "terminate")).toMatchObject({
        status: 200,
        body: { flush: "not-booted" },
      });
      expect((await call(fresh, "GET", "/")).status).toBe(404);
      expect((await call(fresh, "GET", AGENT_CONTROL_ROUTE)).status).toBe(426);
    } finally {
      await stopAgent(fresh);
    }
  });
});
