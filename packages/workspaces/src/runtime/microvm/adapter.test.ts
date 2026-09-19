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
  AGENT_HEALTH_ROUTE,
  agentLaunchRequestSchema,
  DOCKER_AGENT_CONTRACT_VERSION,
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

const dockerConfig: MicrovmRuntimeConfig = {
  ...config,
  dockerImage: {
    arn: "arn:aws:lambda:eu-central-1:123456789012:microvm-image:sealant-workspace-docker",
    version: "7",
  },
};

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

/** An endpoint with independent launch and health scripts. */
const fakeEndpoint = (
  script: ReadonlyArray<Response | Error>,
  healthScript: ReadonlyArray<Response | Error> = [
    json(200, { booted: true, controlSocket: true }),
  ],
) => {
  const requests: RecordedRequest[] = [];
  const healthRequests: RecordedRequest[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const request: RecordedRequest = {
      url: String(input),
      method: init?.method,
      headers,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    const isHealth = request.url.endsWith(AGENT_HEALTH_ROUTE);
    const recorded = isHealth ? healthRequests : requests;
    recorded.push(request);
    const answers = isHealth ? healthScript : script;
    const answer = answers[Math.min(recorded.length - 1, answers.length - 1)];
    if (answer === undefined) throw new Error("empty script");
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer.clone());
  };
  return { requests, healthRequests, fetchImpl };
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
  runtimeConfig: MicrovmRuntimeConfig = config,
) =>
  new MicrovmRuntimeAdapter({
    config: runtimeConfig,
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
    expect(supportForMicrovm(config, { blueprint: cases.gitSource.blueprint })).toEqual({
      supported: true,
    });
    expect(supportForMicrovm(config, { blueprint: captureLaunch.blueprint })).toEqual({
      supported: true,
    });
  });

  it("rejects other explicit families, host mounts, DinD and gVisor", () => {
    expect(
      supportForMicrovm(config, {
        blueprint: {
          ...cases.gitSource.blueprint,
          target: {
            ...cases.gitSource.blueprint.target,
            runtime: { family: "cloudflare", mode: "require" },
          },
        },
      }),
    ).toMatchObject({ supported: false, reason: "unsupported-runtime" });
    expect(supportForMicrovm(config, { blueprint: mountLaunch.blueprint })).toMatchObject({
      supported: false,
      reason: "unsupported-runtime-requirement",
      message: expect.stringContaining("capture source"),
    });
    expect(supportForMicrovm(config, { blueprint: cases.dind.blueprint })).toMatchObject({
      supported: false,
      reason: "unsupported-runtime-requirement",
      message: expect.stringContaining("SEALANT_MICROVM_DOCKER_IMAGE_ARN"),
    });
    expect(supportForMicrovm(dockerConfig, { blueprint: cases.dind.blueprint })).toEqual({
      supported: true,
    });
    expect(
      supportForMicrovm(config, {
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
    const input = buildRunInput(config, "run-golden-4", launchSecret, {
      dockerService: "disabled",
    });
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

  it("selects the pinned elevated image and v2 service requirement only for Docker", () => {
    const input = buildRunInput(dockerConfig, "run-golden-4", launchSecret, {
      dockerService: "required",
    });
    expect(input.imageIdentifier).toBe(dockerConfig.dockerImage?.arn);
    expect(input.imageVersion).toBe("7");
    expect(runHookPayloadSchema.parse(JSON.parse(input.runHookPayload))).toEqual({
      version: DOCKER_AGENT_CONTRACT_VERSION,
      runId: "run-golden-4",
      launchSecret,
      services: { docker: "required" },
    });
    expect(Buffer.byteLength(input.runHookPayload, "utf8")).toBeLessThanOrEqual(4096);
  });

  it("rejects a run-hook payload over the 4096-byte platform limit", () => {
    expect(() =>
      buildRunInput(config, `run-${"😀".repeat(1_024)}`, launchSecret, {
        dockerService: "disabled",
      }),
    ).toThrow(/4096-byte platform limit/);
  });
});

describe("microvmBootEnv", () => {
  it("pins the daemon environment for a capture launch", () => {
    expect(microvmBootEnv(captureLaunch, { secretEnvFile: true, dotfiles: false })).toEqual({
      SEALANT_WORKSPACE_SOURCE: "capture",
      SEALANT_CAPTURE_ENDPOINT: "https://mend.example.com/session/s1",
      SEALANT_CAPTURE_WORKTREE_ID: "wt_1",
      SEALANT_CAPTURE_HARNESS_HOME: "/workspace/harness-home",
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

  it("keeps the explicit harness root authoritative over legacy runtime.env", () => {
    const input = {
      ...captureLaunch,
      blueprint: {
        ...captureLaunch.blueprint,
        runtime: {
          ...captureLaunch.blueprint.runtime,
          env: { SEALANT_CAPTURE_HARNESS_HOME: "/legacy/override" },
        },
      },
    };
    expect(microvmBootEnv(input, { secretEnvFile: true, dotfiles: false })).toMatchObject({
      SEALANT_CAPTURE_HARNESS_HOME: "/workspace/harness-home",
    });
  });

  it("puts git facts, clone auth, platform env and credential env in the process env, later wins", () => {
    const env = microvmBootEnv(cases.gitSource, { secretEnvFile: false, dotfiles: true });
    expect(env).toMatchObject({
      SEALANT_WORKSPACE_SOURCE: "clone",
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

  it("keeps all service-owned Docker client selection env authoritative", () => {
    const input = {
      ...cases.dind,
      platformEnv: {
        DOCKER_CONTEXT: "platform-remote",
        DOCKER_TLS_VERIFY: "1",
      },
      credentialEnv: {
        DOCKER_HOST: "tcp://credential-env.invalid:2375",
        DOCKER_CERT_PATH: "/credential-certs",
        DOCKER_CONFIG: "/workspace/.docker",
      },
      blueprint: {
        ...cases.dind.blueprint,
        runtime: {
          ...cases.dind.blueprint.runtime,
          env: {
            DOCKER_HOST: "tcp://attacker:2375",
            DOCKER_CONTEXT: "remote",
            DOCKER_TLS_CERTDIR: "/tmp/tls",
            DOCKER_TLS_VERIFY: "1",
            DOCKER_CERT_PATH: "/tmp/certs",
          },
        },
      },
    };
    expect(microvmBootEnv(input, { secretEnvFile: true, dotfiles: false })).toMatchObject({
      DOCKER_HOST: "unix:///run/docker/docker.sock",
      DOCKER_CONTEXT: "",
      DOCKER_TLS_CERTDIR: "",
      DOCKER_TLS_VERIFY: "",
      DOCKER_CERT_PATH: "",
      DOCKER_CONFIG: "/workspace/.docker",
    });
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
    expect(api.runs).toEqual([
      buildRunInput(config, "run-golden-4", launchSecret, { dockerService: "disabled" }),
    ]);
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

  it("selects the Docker image and sends the v2 requirement with reserved socket env", async () => {
    const api = new FakeMicrovmApi();
    const endpoint = fakeEndpoint(
      [json(200, { outcome: "booting" })],
      [
        json(200, {
          version: 2,
          booted: true,
          controlSocket: true,
          services: {
            docker: { status: "ready", socket: "/run/docker/docker.sock" },
          },
        }),
      ],
    );
    const adapter = build(api, endpoint, fakeControl(), dockerConfig);

    await adapter.launch({
      ...cases.dind,
      secretEnv: { DOCKER_CONFIG: "/workspace/.docker" },
    });

    expect(api.runs[0]?.imageIdentifier).toBe(dockerConfig.dockerImage?.arn);
    expect(api.runs[0]?.imageVersion).toBe("7");
    const request = agentLaunchRequestSchema.parse(endpoint.requests[0]?.body);
    expect(request).toMatchObject({
      version: 2,
      services: { docker: "required" },
      bootEnv: {
        DOCKER_HOST: "unix:///run/docker/docker.sock",
        DOCKER_CONTEXT: "",
        DOCKER_TLS_CERTDIR: "",
        DOCKER_TLS_VERIFY: "",
        DOCKER_CERT_PATH: "",
      },
      secretEnvJson: JSON.stringify({ DOCKER_CONFIG: "/workspace/.docker" }),
    });
  });

  it.each([
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
    "DOCKER_TLS_CERTDIR",
    "DOCKER_TLS_VERIFY",
    "DOCKER_CERT_PATH",
  ])("refuses reserved Docker variable %s in secretEnv before running a VM", async (name) => {
    const api = new FakeMicrovmApi();
    const adapter = build(
      api,
      fakeEndpoint([json(200, { outcome: "booting" })]),
      fakeControl(),
      dockerConfig,
    );
    await expect(
      adapter.launch({
        ...cases.dind,
        secretEnv: { [name]: "attacker-controlled", DOCKER_CONFIG: "/workspace/.docker" },
      }),
    ).rejects.toThrow(`reserved variable ${name}`);
    expect(api.runs).toEqual([]);
  });

  it("fails immediately on the agent's structured daemon exit and terminates the VM", async () => {
    const api = new FakeMicrovmApi();
    const endpoint = fakeEndpoint(
      [json(200, { outcome: "booting" })],
      [
        json(503, {
          booted: true,
          controlSocket: false,
          daemonExit: { code: 1, signal: null },
        }),
      ],
    );
    const control = fakeControl();
    const adapter = build(api, endpoint, control);

    await expect(adapter.launch(captureLaunch)).rejects.toMatchObject({
      code: "microvm-guest-failed",
      phase: "sealantd",
      message: expect.stringContaining("code 1"),
    });
    expect(endpoint.healthRequests).toHaveLength(1);
    expect(control.healthTargets).toEqual([]);
    expect(api.terminates).toEqual(["microvm-1"]);
  });

  it("retries a transient health transport failure", async () => {
    const api = new FakeMicrovmApi();
    const endpoint = fakeEndpoint(
      [json(200, { outcome: "booting" })],
      [new Error("temporary reset"), json(200, { booted: true, controlSocket: true })],
    );

    await expect(build(api, endpoint, fakeControl()).launch(captureLaunch)).resolves.toMatchObject({
      status: "ready",
    });
    expect(endpoint.healthRequests).toHaveLength(2);
    expect(api.terminates).toEqual([]);
  });

  it("boots its registered image and needs none built: a launch without one succeeds", async () => {
    const api = new FakeMicrovmApi();
    const endpoint = fakeEndpoint(
      [json(200, { outcome: "booting" })],
      [json(200, { booted: true, controlSocket: true })],
    );
    const adapter = build(api, endpoint, fakeControl());
    const { publishedImage: _built, ...withoutBuiltImage } = captureLaunch;

    // What the worker reads to skip the build and publish for a workspace this adapter is
    // selected for.
    expect(adapter.builtImage).toBe("unused");
    await expect(adapter.launch(withoutBuiltImage)).resolves.toMatchObject({ status: "ready" });
  });

  it("retries an endpoint 502 before valid agent health", async () => {
    const api = new FakeMicrovmApi();
    const endpoint = fakeEndpoint(
      [json(200, { outcome: "booting" })],
      [
        new Response("Bad Gateway", { status: 502 }),
        json(200, { booted: true, controlSocket: true }),
      ],
    );

    await expect(build(api, endpoint, fakeControl()).launch(captureLaunch)).resolves.toMatchObject({
      status: "ready",
    });
    expect(endpoint.healthRequests).toHaveLength(2);
    expect(api.terminates).toEqual([]);
  });

  it("retries malformed proxy 503/504 responses without exposing their content", async () => {
    const api = new FakeMicrovmApi();
    const endpoint = fakeEndpoint(
      [json(200, { outcome: "booting" })],
      [
        json(503, { message: "raw-log control-token mst_secret" }),
        new Response("raw-log control-token mst_secret", { status: 504 }),
        json(200, { booted: true, controlSocket: true }),
      ],
    );

    await expect(build(api, endpoint, fakeControl()).launch(captureLaunch)).resolves.toMatchObject({
      status: "ready",
    });
    expect(endpoint.healthRequests).toHaveLength(3);
    expect(api.terminates).toEqual([]);
  });

  it("fails immediately on valid v2 Docker failure health and cleans up", async () => {
    const api = new FakeMicrovmApi();
    const endpoint = fakeEndpoint(
      [json(200, { outcome: "booting" })],
      [
        json(503, {
          version: 2,
          booted: false,
          controlSocket: false,
          services: {
            docker: {
              status: "failed",
              reason: "exited",
              code: 2,
              signal: null,
            },
          },
        }),
      ],
    );

    await expect(
      build(api, endpoint, fakeControl(), dockerConfig).launch(cases.dind),
    ).rejects.toMatchObject({
      code: "microvm-guest-failed",
      phase: "docker",
      failureReason: "exited",
      guestExitCode: 2,
      guestSignal: null,
      message: expect.stringContaining("Guest-local Docker failed"),
    });
    expect(endpoint.healthRequests).toHaveLength(1);
    expect(api.terminates).toEqual(["microvm-1"]);
  });

  it("fails a v2 launch immediately on a valid legacy health contract", async () => {
    const api = new FakeMicrovmApi();
    const endpoint = fakeEndpoint(
      [json(200, { outcome: "booting" })],
      [json(503, { booted: true, controlSocket: true })],
    );

    await expect(
      build(api, endpoint, fakeControl(), dockerConfig).launch(cases.dind),
    ).rejects.toMatchObject({
      code: "microvm-guest-failed",
      phase: "protocol",
      message: expect.stringContaining("legacy agent health contract"),
    });
    expect(endpoint.healthRequests).toHaveLength(1);
    expect(api.terminates).toEqual(["microvm-1"]);
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

  it("fails readably without exposing the agent body when launch material is refused", async () => {
    const api = new FakeMicrovmApi();
    const endpoint = fakeEndpoint([
      json(401, { message: "bad launch secret raw-log control-token" }),
    ]);
    const adapter = build(api, endpoint, fakeControl());
    const launch = adapter.launch(captureLaunch);
    await expect(launch).rejects.toThrow(/failed with HTTP 401/);
    await expect(launch).rejects.not.toThrow(/raw-log|control-token/);
    expect(api.terminates).toEqual(["microvm-1"]);
  });

  it("gives up on a VM whose daemon never answers, terminating it", async () => {
    const api = new FakeMicrovmApi();
    const endpoint = fakeEndpoint([json(200, { outcome: "booting" })]);
    const adapter = build(api, endpoint, fakeControl(Number.POSITIVE_INFINITY));
    await expect(adapter.launch(captureLaunch)).rejects.toThrow(/did not become ready within/);
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

  it("reports a Docker service lost after readiness as an exited runtime", async () => {
    const api = new FakeMicrovmApi();
    const endpoint = fakeEndpoint(
      [json(200, { outcome: "booting" })],
      [
        json(200, {
          version: 2,
          booted: true,
          controlSocket: true,
          services: {
            docker: { status: "ready", socket: "/run/docker/docker.sock" },
          },
        }),
        json(503, {
          version: 2,
          booted: true,
          controlSocket: true,
          services: {
            docker: {
              status: "failed",
              reason: "exited",
              code: 2,
              signal: null,
            },
          },
        }),
      ],
    );
    const adapter = build(api, endpoint, fakeControl(), dockerConfig);
    const launched = await adapter.launch(cases.dind);

    await expect(adapter.inspect({ resourceId: launched.resourceId })).resolves.toEqual({
      state: "exited",
      exitCode: 2,
      detail: "Guest-local Docker failed in the MicroVM (exited; code 2, signal null).",
    });
  });

  it("propagates transient endpoint health as an inspect error instead of inferring exit", async () => {
    const api = new FakeMicrovmApi();
    const endpoint = fakeEndpoint(
      [json(200, { outcome: "booting" })],
      [
        json(200, { booted: true, controlSocket: true }),
        json(503, { message: "proxy-not-agent raw-log control-token" }),
      ],
    );
    const adapter = build(api, endpoint, fakeControl());
    const launched = await adapter.launch(captureLaunch);

    const inspection = adapter.inspect({ resourceId: launched.resourceId });
    await expect(inspection).rejects.toThrow(/HTTP 503 without a valid health body/);
    await expect(inspection).rejects.not.toThrow(/raw-log|control-token/);
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
        onError: (error, resourceId) => errors.push([resourceId, error]),
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
        onError: (error, resourceId) =>
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
