/**
 * Adapter behaviour against an in-memory Lambda MicroVMs API, a recorded endpoint (fetch) and
 * a scripted control channel: support gating, the RunMicrovm request (golden), launch-material
 * delivery (headers, body, retries, adoption), readiness, stop/fence, inspect state mapping and
 * the poll-based exit watch. No network, no AWS.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { SealantTarget } from "../../sealantd/runtime.js";
import { cases } from "../docker-runtime-adapter.golden-fixture.js";
import type { ControlChannel } from "../kubernetes/adapter.js";
import type { CredentialFileInjection } from "../runtime-adapter.js";
import {
  buildRunInput,
  clientTokenForRun,
  endpointHost,
  microvmBootEnv,
  MicrovmRuntimeAdapter,
  supportForMicrovm,
} from "./adapter.js";
import {
  agentLaunchRequestSchema,
  launchSecretForRun,
  runHookPayloadSchema,
} from "./agent-contract.js";
import type {
  MicrovmApi,
  MicrovmAuthTokenInput,
  MicrovmDescription,
  MicrovmRunInput,
  MicrovmState,
} from "./api.js";
import { microvmRuntimeConfigFromEnv, type MicrovmRuntimeConfig } from "./config.js";

const config: MicrovmRuntimeConfig = (() => {
  const parsed = microvmRuntimeConfigFromEnv({
    SEALANT_MICROVM_REGION: "eu-central-1",
    SEALANT_MICROVM_IMAGE_ARN:
      "arn:aws:lambda:eu-central-1:123456789012:microvm-image:sealant-workspace",
    SEALANT_MICROVM_EXEC_ROLE_ARN: "arn:aws:iam::123456789012:role/sealant-microvm-exec",
    SEALANT_MICROVM_EGRESS_CONNECTOR:
      "arn:aws:lambda:eu-central-1:123456789012:network-connector:vpc-egress",
    SEALANT_MICROVM_LOG_GROUP: "/aws/lambda/microvms/sealant",
    SEALANT_MICROVM_READINESS_TIMEOUT_MS: 2_000,
    SEALANT_MICROVM_TERMINATE_TIMEOUT_MS: 2_000,
    SEALANT_MICROVM_EXIT_POLL_INTERVAL_MS: 1_000,
    SEALANT_CONTROL_BEARER_TOKEN: "control-token",
  });
  if (parsed === undefined) throw new Error("config");
  return parsed;
})();

const ENDPOINT = "abc123.lambda-microvm.eu-central-1.on.aws";

/** Stateful fake of the four operations: PENDING → RUNNING after `pendingGets` reads, etc. */
class FakeMicrovmApi implements MicrovmApi {
  readonly runs: MicrovmRunInput[] = [];
  readonly gets: string[] = [];
  readonly terminates: string[] = [];
  readonly mints: MicrovmAuthTokenInput[] = [];
  readonly vms = new Map<string, MicrovmDescription>();
  readonly #byClientToken = new Map<string, string>();
  #readsUntilRunning = new Map<string, number>();
  #readsUntilTerminated = new Map<string, number>();
  pendingGets = 1;
  terminatingGets = 1;
  /** When set, the next VM ends with this reason instead of reaching RUNNING. */
  dieWith: string | undefined;

  readonly runMicrovm = (input: MicrovmRunInput): Promise<MicrovmDescription> => {
    this.runs.push(input);
    const existing = this.#byClientToken.get(input.clientToken);
    if (existing !== undefined) {
      return Promise.resolve(this.#must(existing));
    }
    const microvmId = `microvm-${this.vms.size + 1}`;
    const vm: MicrovmDescription = {
      microvmId,
      state: "PENDING",
      endpoint: ENDPOINT,
      imageArn: input.imageIdentifier,
      maximumDurationInSeconds: input.maximumDurationInSeconds,
      startedAt: new Date("2026-09-13T10:00:00.000Z"),
    };
    this.vms.set(microvmId, vm);
    this.#byClientToken.set(input.clientToken, microvmId);
    this.#readsUntilRunning.set(microvmId, this.pendingGets);
    return Promise.resolve(vm);
  };

  readonly getMicrovm = (microvmId: string): Promise<MicrovmDescription | undefined> => {
    this.gets.push(microvmId);
    const vm = this.vms.get(microvmId);
    if (vm === undefined) {
      return Promise.resolve(undefined);
    }
    if (vm.state === "PENDING") {
      const left = (this.#readsUntilRunning.get(microvmId) ?? 0) - 1;
      this.#readsUntilRunning.set(microvmId, left);
      if (left <= 0) {
        this.#set(microvmId, this.dieWith === undefined ? "RUNNING" : "TERMINATING", this.dieWith);
      }
    } else if (vm.state === "TERMINATING") {
      const left = (this.#readsUntilTerminated.get(microvmId) ?? 0) - 1;
      this.#readsUntilTerminated.set(microvmId, left);
      if (left <= 0) {
        this.#set(microvmId, "TERMINATED");
      }
    }
    return Promise.resolve(this.#must(microvmId));
  };

  readonly terminateMicrovm = (microvmId: string): Promise<"terminated" | "not-found"> => {
    this.terminates.push(microvmId);
    const vm = this.vms.get(microvmId);
    if (vm === undefined) {
      return Promise.resolve("not-found");
    }
    if (vm.state !== "TERMINATED") {
      this.#set(microvmId, "TERMINATING", "User initiated");
      this.#readsUntilTerminated.set(microvmId, this.terminatingGets);
    }
    return Promise.resolve("terminated");
  };

  readonly createAuthToken = (input: MicrovmAuthTokenInput): Promise<string> => {
    this.mints.push(input);
    return Promise.resolve(`endpoint-token-${this.mints.length}`);
  };

  forgetVm(microvmId: string): void {
    this.vms.delete(microvmId);
  }

  #set(microvmId: string, state: MicrovmState, stateReason?: string): void {
    const vm = this.#must(microvmId);
    this.vms.set(microvmId, {
      ...vm,
      state,
      ...(stateReason === undefined ? {} : { stateReason }),
      ...(state === "TERMINATED" ? { terminatedAt: new Date("2026-09-13T10:05:00.000Z") } : {}),
    });
  }

  #must(microvmId: string): MicrovmDescription {
    const vm = this.vms.get(microvmId);
    if (vm === undefined) throw new Error(`no vm ${microvmId}`);
    return vm;
  }
}

interface RecordedRequest {
  readonly url: string;
  readonly method: string | undefined;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** An endpoint that answers from a script (one entry per request; the last repeats). */
const fakeEndpoint = (script: ReadonlyArray<Response | Error>) => {
  const requests: RecordedRequest[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    requests.push({
      url: String(input),
      method: init?.method,
      headers,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const answer = script[Math.min(requests.length - 1, script.length - 1)];
    if (answer === undefined) throw new Error("empty script");
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer.clone());
  };
  return { requests, fetchImpl };
};

/** A control channel that answers health after `failures` attempts and records file writes. */
const fakeControl = (failures = 0) => {
  const healthTargets: SealantTarget[] = [];
  const written: Array<{ target: SealantTarget; files: readonly CredentialFileInjection[] }> = [];
  let remaining = failures;
  const channel: ControlChannel = {
    health: (target) => {
      healthTargets.push(target);
      if (remaining > 0) {
        remaining -= 1;
        return Promise.reject(new Error("connect ECONNREFUSED"));
      }
      return Promise.resolve();
    },
    writeCredentialFiles: (target, files) => {
      written.push({ target, files });
      return Promise.resolve();
    },
  };
  return { channel, healthTargets, written };
};

const build = (
  api: FakeMicrovmApi,
  endpoint: ReturnType<typeof fakeEndpoint>,
  control: ReturnType<typeof fakeControl>,
) =>
  new MicrovmRuntimeAdapter({
    config,
    api,
    fetchImpl: endpoint.fetchImpl,
    controlChannel: control.channel,
    pollIntervalMs: 1,
  });

const captureLaunch = cases.capture;
/** The Mend-style mount launch with the (separately refused) gVisor selection removed. */
const mountLaunch = {
  ...cases.mendMount,
  blueprint: {
    ...cases.mendMount.blueprint,
    runtime: { ...cases.mendMount.blueprint.runtime, ociRuntime: "runc" as const },
  },
};
const launchSecret = launchSecretForRun("control-token", "run-golden-4");

describe("supportForMicrovm", () => {
  it("accepts git and capture sources on ephemeral, outbound blueprints", () => {
    expect(supportForMicrovm({ blueprint: cases.gitSource.blueprint })).toEqual({
      supported: true,
    });
    expect(supportForMicrovm({ blueprint: captureLaunch.blueprint })).toEqual({ supported: true });
  });

  it("rejects other explicit families, host mounts, DinD and gVisor", () => {
    expect(
      supportForMicrovm({
        blueprint: {
          ...cases.gitSource.blueprint,
          target: {
            ...cases.gitSource.blueprint.target,
            runtime: { family: "cloudflare", mode: "require" },
          },
        },
      }),
    ).toMatchObject({ supported: false, reason: "unsupported-runtime" });
    expect(supportForMicrovm({ blueprint: mountLaunch.blueprint })).toMatchObject({
      supported: false,
      reason: "unsupported-runtime-requirement",
      message: expect.stringContaining("capture source"),
    });
    expect(supportForMicrovm({ blueprint: cases.dind.blueprint })).toMatchObject({
      supported: false,
      reason: "unsupported-runtime-requirement",
    });
    expect(
      supportForMicrovm({
        blueprint: {
          ...cases.gitSource.blueprint,
          runtime: { ...cases.gitSource.blueprint.runtime, ociRuntime: "runsc" },
        },
      }),
    ).toMatchObject({ supported: false, reason: "unsupported-runtime-requirement" });
  });
});

describe("buildRunInput", () => {
  it("pins the RunMicrovm request: image, role, connectors, an idle policy that cannot fire, the cap, the payload", () => {
    const input = buildRunInput(config, "run-golden-4", launchSecret);
    expect(input).toEqual({
      imageIdentifier: "arn:aws:lambda:eu-central-1:123456789012:microvm-image:sealant-workspace",
      executionRoleArn: "arn:aws:iam::123456789012:role/sealant-microvm-exec",
      ingressNetworkConnectors: [
        "arn:aws:lambda:eu-central-1:aws:network-connector:aws-network-connector:ALL_INGRESS",
      ],
      egressNetworkConnectors: [
        "arn:aws:lambda:eu-central-1:123456789012:network-connector:vpc-egress",
      ],
      idlePolicy: {
        autoResumeEnabled: false,
        maxIdleDurationSeconds: 28_800,
        suspendedDurationSeconds: 28_800,
      },
      maximumDurationInSeconds: 28_800,
      logging: { cloudWatch: { logGroup: "/aws/lambda/microvms/sealant" } },
      runHookPayload: JSON.stringify({ version: 1, runId: "run-golden-4", launchSecret }),
      clientToken: clientTokenForRun("run-golden-4"),
    });
    expect(runHookPayloadSchema.parse(JSON.parse(input.runHookPayload))).toEqual({
      version: 1,
      runId: "run-golden-4",
      launchSecret,
    });
    expect(input.runHookPayload.length).toBeLessThanOrEqual(4096);
    expect(input.clientToken).toMatch(/^[0-9a-f]{64}$/);
    // The payload carries the bootstrap secret only: never env, never the secret file.
    expect(input.runHookPayload).not.toContain("mst_secret");
  });
});

describe("microvmBootEnv", () => {
  it("pins the daemon environment for a capture launch", () => {
    expect(microvmBootEnv(captureLaunch, { secretEnvFile: true, dotfiles: false })).toEqual({
      SEALANT_WORKSPACE_SOURCE: "capture",
      SEALANT_CAPTURE_ENDPOINT: "https://mend.example.com/session/s1",
      SEALANT_CAPTURE_WORKTREE_ID: "wt_1",
      SEALANT_WORKSPACE_ROOT: "/workspace",
      SEALANT_WORKING_DIRECTORY: "/workspace/repo",
      SEALANT_CONTROL_SOCKET: "/run/sealant/control.sock",
      SEALANT_OCI_RUNTIME: "runc",
      SEALANT_HARNESS_BANNER: "Starting claude-code workspace",
      SEALANT_HARNESS_LAUNCH_COMMAND: "claude",
      SEALANT_LIFECYCLE_SETUP_JSON: "[]",
      SEALANT_LIFECYCLE_STARTUP_JSON: "[]",
      MEND_SESSION_ID: "1",
      SEALANT_SECRET_ENV_FILE: "/run/sealant/secrets/env.json",
    });
  });

  it("puts git facts, clone auth, platform env and credential env in the process env, later wins", () => {
    const env = microvmBootEnv(cases.gitSource, { secretEnvFile: false, dotfiles: true });
    expect(env).toMatchObject({
      SEALANT_WORKSPACE_SOURCE: "git",
      SEALANT_WORKSPACE_REPO_URL: "https://github.com/example/repo.git",
      SEALANT_WORKSPACE_REPO_REF: "main",
      NODE_ENV: "development",
      SEALANT_DOTFILES_ARCHIVE_DIR: "/run/sealant/dotfiles",
      SEALANT_DOTFILES_HTTP_TOKEN: "dot_secret",
      GITHUB_TOKEN: "gh_secret",
      CLAUDE_CODE_OAUTH_TOKEN: "cc_secret",
    });
    expect(env).not.toHaveProperty("SEALANT_SECRET_ENV_FILE");
    const keys = Object.keys(env);
    expect(keys.indexOf("NODE_ENV")).toBeLessThan(keys.indexOf("GITHUB_TOKEN"));
  });
});

describe("endpointHost", () => {
  it("accepts the bare hostname the API returns and a scheme-prefixed form alike", () => {
    expect(endpointHost(ENDPOINT)).toBe(ENDPOINT);
    expect(endpointHost(`https://${ENDPOINT}/`)).toBe(ENDPOINT);
  });
});

describe("MicrovmRuntimeAdapter.launch", () => {
  const tempDirs: string[] = [];
  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("runs the VM, waits for RUNNING, pushes the launch material, then requires daemon health", async () => {
    const api = new FakeMicrovmApi();
    api.pendingGets = 3;
    // The proxy answers 502 until the agent is reachable, then the agent accepts the push.
    const endpoint = fakeEndpoint([json(502, "Bad Gateway"), json(200, { outcome: "booting" })]);
    const control = fakeControl(2);
    const adapter = build(api, endpoint, control);
    const files: CredentialFileInjection[] = [
      { path: "$HOME/.claude/.credentials.json", contentBase64: "e30=", mode: "600" },
    ];

    const result = await adapter.launch({ ...captureLaunch, credentialFiles: files });

    expect(result).toEqual({
      adapter: "microvm",
      resourceId: "microvm-1",
      reference: "microvm-1",
      status: "ready",
      endpoint: `wss://${ENDPOINT}/sealant/control`,
    });
    expect(api.runs).toEqual([buildRunInput(config, "run-golden-4", launchSecret)]);
    expect(api.terminates).toEqual([]);

    // Launch material: one authenticated push (retried past the 502), never through AWS.
    expect(endpoint.requests).toHaveLength(2);
    const push = endpoint.requests[1];
    expect(push?.url).toBe(`https://${ENDPOINT}/sealant/launch`);
    expect(push?.method).toBe("POST");
    expect(push?.headers).toEqual({
      "x-aws-proxy-auth": "endpoint-token-1",
      "x-aws-proxy-port": "8080",
      authorization: `Bearer ${launchSecret}`,
      "content-type": "application/json",
    });
    expect(agentLaunchRequestSchema.parse(push?.body)).toEqual({
      version: 1,
      runId: "run-golden-4",
      controlToken: "control-token",
      flushTimeoutMs: 50_000,
      bootEnv: microvmBootEnv(captureLaunch, { secretEnvFile: true, dotfiles: false }),
      secretEnvJson: JSON.stringify({
        MEND_SESSION_TOKEN: "mst_secret",
        SEALANT_CAPTURE_TOKEN: "mst_secret",
      }),
    });

    // Readiness is the daemon answering over the real control target, which carries the
    // control bearer token and mints the endpoint token per connection.
    expect(control.healthTargets).toHaveLength(3);
    const target = control.healthTargets[0];
    expect(target).toMatchObject({
      kind: "websocket",
      url: `wss://${ENDPOINT}/sealant/control`,
      auth: { bearerToken: "control-token" },
    });
    if (target?.kind !== "websocket" || target.prepare === undefined) throw new Error("target");
    await expect(target.prepare()).resolves.toEqual({
      headers: { "X-aws-proxy-auth": "endpoint-token-1", "X-aws-proxy-port": "8080" },
    });
    // One mint served the push and every control connection (the launch holds the token).
    expect(api.mints).toEqual([{ microvmId: "microvm-1", expirationInMinutes: 60, port: 8080 }]);
    expect(control.written).toEqual([{ target, files }]);
  });

  it("reads the host-staged boot file when the stager did not pass the secret env through", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "microvm-secret-"));
    tempDirs.push(dir);
    await writeFile(path.join(dir, "env.json"), JSON.stringify({ TOKEN: "staged" }));
    const dotfilesDir = await mkdtemp(path.join(tmpdir(), "microvm-dotfiles-"));
    tempDirs.push(dotfilesDir);
    await writeFile(
      path.join(dotfilesDir, "manifest.json"),
      `${JSON.stringify({ archives: [{ file: "0.tar.gz", bootstrap: false }] })}\n`,
    );
    await writeFile(path.join(dotfilesDir, "0.tar.gz"), Buffer.from("tarball"));
    const api = new FakeMicrovmApi();
    const endpoint = fakeEndpoint([json(200, { outcome: "booting" })]);
    const adapter = build(api, endpoint, fakeControl());
    const { secretEnv: _passThrough, ...launch } = captureLaunch;

    await adapter.launch({ ...launch, secretEnvDir: dir, dotfilesArchiveDir: dotfilesDir });

    const body = agentLaunchRequestSchema.parse(endpoint.requests[0]?.body);
    expect(body.secretEnvJson).toBe(JSON.stringify({ TOKEN: "staged" }));
    expect(body.bootEnv["SEALANT_SECRET_ENV_FILE"]).toBe("/run/sealant/secrets/env.json");
    expect(body.bootEnv["SEALANT_DOTFILES_ARCHIVE_DIR"]).toBe("/run/sealant/dotfiles");
    expect(body.dotfiles).toEqual({
      manifestJson: `${JSON.stringify({ archives: [{ file: "0.tar.gz", bootstrap: false }] })}\n`,
      archives: [{ name: "0.tar.gz", contentBase64: Buffer.from("tarball").toString("base64") }],
    });
  });

  it("adopts a VM whose agent already booted (a redelivered launch answers 409)", async () => {
    const api = new FakeMicrovmApi();
    const endpoint = fakeEndpoint([json(409, { message: "already booted" })]);
    const adapter = build(api, endpoint, fakeControl());
    const first = await adapter.launch(captureLaunch);
    const second = await adapter.launch(captureLaunch);
    expect(second.resourceId).toBe(first.resourceId);
    expect(api.runs).toHaveLength(2);
    expect(api.runs[0]?.clientToken).toBe(api.runs[1]?.clientToken);
    expect(api.vms.size).toBe(1);
  });

  it("terminates a VM that ends before it is ready and says why", async () => {
    const api = new FakeMicrovmApi();
    api.dieWith = "Run hook failed";
    const endpoint = fakeEndpoint([json(200, { outcome: "booting" })]);
    const adapter = build(api, endpoint, fakeControl());
    await expect(adapter.launch(captureLaunch)).rejects.toThrow(
      /microvm-1 for run run-golden-4 ended before it became ready: TERMINATING: Run hook failed/,
    );
    expect(api.terminates).toEqual(["microvm-1"]);
    expect(endpoint.requests).toEqual([]);
  });

  it("fails readably when the agent refuses the launch material", async () => {
    const api = new FakeMicrovmApi();
    const endpoint = fakeEndpoint([json(401, { message: "bad launch secret" })]);
    const adapter = build(api, endpoint, fakeControl());
    await expect(adapter.launch(captureLaunch)).rejects.toThrow(/bad launch secret/);
    expect(api.terminates).toEqual(["microvm-1"]);
  });

  it("gives up on a VM whose daemon never answers, terminating it", async () => {
    const api = new FakeMicrovmApi();
    const endpoint = fakeEndpoint([json(200, { outcome: "booting" })]);
    const adapter = build(api, endpoint, fakeControl(Number.POSITIVE_INFINITY));
    await expect(adapter.launch(captureLaunch)).rejects.toThrow(/did not answer over wss:/);
    expect(api.terminates).toEqual(["microvm-1"]);
  });

  it("refuses launches it cannot serve before touching the platform", async () => {
    const api = new FakeMicrovmApi();
    const adapter = build(api, fakeEndpoint([]), fakeControl());
    const { runId: _runId, ...noRunId } = captureLaunch;
    await expect(adapter.launch(noRunId)).rejects.toThrow(/launch.runId/);
    await expect(adapter.launch(mountLaunch)).rejects.toThrow(/capture source/);
    await expect(
      adapter.launch({
        ...cases.gitSource,
        workspaceCloneAuth: { type: "file-ref", path: "/keys/deploy" },
      }),
    ).rejects.toThrow(/file-ref/);
    expect(api.runs).toEqual([]);
  });
});

describe("MicrovmRuntimeAdapter.stop", () => {
  const launched = async () => {
    const api = new FakeMicrovmApi();
    const adapter = build(api, fakeEndpoint([json(200, { outcome: "booting" })]), fakeControl());
    await adapter.launch(captureLaunch);
    return { api, adapter };
  };

  it("terminates; the initiating stop reports stopped, later ones not-found", async () => {
    const { api, adapter } = await launched();
    await expect(adapter.stop({ resourceId: "microvm-1" })).resolves.toEqual({
      adapter: "microvm",
      resourceId: "microvm-1",
      outcome: "stopped",
    });
    await expect(adapter.stop({ resourceId: "microvm-1" })).resolves.toMatchObject({
      outcome: "not-found",
    });
    await expect(adapter.stop({ resourceId: "microvm-9" })).resolves.toMatchObject({
      outcome: "not-found",
    });
    expect(api.terminates).toEqual(["microvm-1", "microvm-1", "microvm-9"]);
  });

  it("fence waits until the platform reports TERMINATED", async () => {
    const { api, adapter } = await launched();
    api.terminatingGets = 3;
    const getsBefore = api.gets.length;
    await expect(adapter.stop({ resourceId: "microvm-1", fence: true })).resolves.toMatchObject({
      outcome: "stopped",
    });
    expect(api.vms.get("microvm-1")?.state).toBe("TERMINATED");
    expect(api.gets.length - getsBefore).toBeGreaterThanOrEqual(4);
  });

  it("fence fails readably when the VM does not reach TERMINATED in time", async () => {
    const api = new FakeMicrovmApi();
    api.terminatingGets = Number.POSITIVE_INFINITY;
    const adapter = new MicrovmRuntimeAdapter({
      config: { ...config, terminateTimeoutMs: 20 },
      api,
      fetchImpl: fakeEndpoint([json(200, { outcome: "booting" })]).fetchImpl,
      controlChannel: fakeControl().channel,
      pollIntervalMs: 1,
    });
    await adapter.launch(captureLaunch);
    await expect(adapter.stop({ resourceId: "microvm-1", fence: true })).rejects.toThrow(
      /still TERMINATING .* the fence is not confirmed/,
    );
  });
});

describe("MicrovmRuntimeAdapter.inspect", () => {
  it("maps platform states onto running (with the deadline), exited (with the reason) and missing", async () => {
    const api = new FakeMicrovmApi();
    const adapter = build(api, fakeEndpoint([json(200, { outcome: "booting" })]), fakeControl());
    await adapter.launch(captureLaunch);

    await expect(adapter.inspect({ resourceId: "microvm-1" })).resolves.toEqual({
      state: "running",
      platformState: "RUNNING",
      startedAt: "2026-09-13T10:00:00.000Z",
      maxDurationSeconds: 28_800,
      deadline: "2026-09-13T18:00:00.000Z",
    });

    api.terminatingGets = 2;
    await api.terminateMicrovm("microvm-1");
    await expect(adapter.inspect({ resourceId: "microvm-1" })).resolves.toEqual({
      state: "exited",
      detail: "TERMINATING: User initiated",
    });
    await api.getMicrovm("microvm-1");
    await expect(adapter.inspect({ resourceId: "microvm-1" })).resolves.toEqual({
      state: "exited",
      detail: "TERMINATED: User initiated",
    });

    api.forgetVm("microvm-1");
    await expect(adapter.inspect({ resourceId: "microvm-1" })).resolves.toEqual({
      state: "missing",
    });
  });

  it("treats a suspended VM as running, naming the platform state", async () => {
    const api = new FakeMicrovmApi();
    api.vms.set("microvm-7", {
      microvmId: "microvm-7",
      state: "SUSPENDED",
      startedAt: new Date("2026-09-13T10:00:00.000Z"),
      maximumDurationInSeconds: 7200,
    });
    const adapter = build(api, fakeEndpoint([]), fakeControl());
    await expect(adapter.inspect({ resourceId: "microvm-7" })).resolves.toEqual({
      state: "running",
      platformState: "SUSPENDED",
      startedAt: "2026-09-13T10:00:00.000Z",
      maxDurationSeconds: 7200,
      deadline: "2026-09-13T12:00:00.000Z",
    });
  });
});

describe("MicrovmRuntimeAdapter.watchExits", () => {
  it("polls each watched VM on the configured interval and reports each exit once", async () => {
    vi.useFakeTimers();
    try {
      const api = new FakeMicrovmApi();
      for (const id of ["microvm-1", "microvm-2"]) {
        api.vms.set(id, { microvmId: id, state: "RUNNING" });
      }
      const adapter = build(api, fakeEndpoint([]), fakeControl());
      const exits: unknown[] = [];
      const errors: unknown[] = [];
      const watch = adapter.watchExits({
        resourceIds: ["microvm-1", "microvm-2", "microvm-3"],
        onExit: (event) => exits.push(event),
        onError: (resourceId, error) => errors.push([resourceId, error]),
      });

      await vi.advanceTimersByTimeAsync(1_000);
      // microvm-3 was never known: missing, reported once and dropped from the set.
      expect(exits).toEqual([{ resourceId: "microvm-3", result: { state: "missing" } }]);
      expect(api.gets).toEqual(["microvm-1", "microvm-2", "microvm-3"]);

      api.vms.set("microvm-2", { microvmId: "microvm-2", state: "TERMINATED", stateReason: "cap" });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(exits).toEqual([
        { resourceId: "microvm-3", result: { state: "missing" } },
        { resourceId: "microvm-2", result: { state: "exited", detail: "TERMINATED: cap" } },
      ]);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(api.gets.slice(3)).toEqual(["microvm-1", "microvm-2", "microvm-1"]);

      watch.close();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(api.gets).toHaveLength(6);
      expect(errors).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports poll failures and keeps watching; closes itself once every VM has ended", async () => {
    vi.useFakeTimers();
    try {
      const api = new FakeMicrovmApi();
      let failNext = true;
      const flaky: MicrovmApi = {
        ...api,
        getMicrovm: (id) => {
          if (failNext) {
            failNext = false;
            return Promise.reject(new Error("throttled"));
          }
          return api.getMicrovm(id);
        },
      };
      const adapter = new MicrovmRuntimeAdapter({ config, api: flaky, pollIntervalMs: 1 });
      const exits: unknown[] = [];
      const errors: unknown[] = [];
      adapter.watchExits({
        resourceIds: ["microvm-1"],
        onExit: (event) => exits.push(event),
        onError: (resourceId, error) =>
          errors.push([resourceId, error instanceof Error ? error.message : error]),
      });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(errors).toEqual([["microvm-1", "throttled"]]);
      expect(exits).toEqual([]);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(exits).toEqual([{ resourceId: "microvm-1", result: { state: "missing" } }]);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(api.gets).toEqual(["microvm-1"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
