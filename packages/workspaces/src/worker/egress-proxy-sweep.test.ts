import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CredentialCipher, credentialCipherLayer } from "@sealant/credentials";
import type {
  WorkspaceEgressPolicy,
  WorkspaceEgressProxy,
  WorkspaceEgressRepoService,
} from "@sealant/db";
import { tombstonesOf } from "@sealant/db";
import { Effect, Redacted } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DockerCommandRunner } from "../runtime/docker-runtime-adapter.js";
import { EgressProxyOrchestrator } from "../runtime/egress-proxy-orchestrator.js";
import { egressPolicyHash } from "../runtime/egress-proxy-policy.js";
import { sealBrokeredValues } from "../runtime/egress-proxy-store.js";
import { generateExecutorCa } from "../runtime/executor-ca.js";
import {
  ProxyAdminUnreachableError,
  type ProxyAdminClient,
  type ProxyPolicyDocument,
} from "../runtime/proxy-admin-client.js";
import { sweepEgressProxy } from "./egress-proxy-sweep.js";

const cipher = Effect.runSync(
  Effect.gen(function* () {
    return yield* CredentialCipher;
  }).pipe(Effect.provide(credentialCipherLayer({ key: randomBytes(32).toString("base64") }))),
);

const ca = generateExecutorCa({ executor: "sealant-run-1" });
const caKeySealed = Effect.runSync(cipher.encrypt(Redacted.value(ca.keyPem))).sealed;

const policy = (revocationWatermark: number): WorkspaceEgressPolicy => ({
  workspaceId: "ws_1",
  networkPolicy: { mode: "restricted", policyHash: "sha256:pinned" },
  brokeredSecrets: [],
  brokeredValuesSealed: Effect.runSync(sealBrokeredValues(cipher, {})).sealed,
  encryptionKeyId: "k1",
  revocationWatermark,
  createdAt: new Date(),
  updatedAt: new Date(),
});

const proxyRow = (overrides: Partial<WorkspaceEgressProxy> = {}): WorkspaceEgressProxy => ({
  runId: "run-1",
  workspaceId: "ws_1",
  proxyContainer: "sealant-run-1-proxy",
  adminSocketPath: "/unused",
  caCertPem: ca.certPem,
  caKeySealed,
  encryptionKeyId: "k1",
  caNotAfter: ca.notAfter,
  network: { proxyIp: "10.233.0.14", operatorAllowedPrivateCidrs: [], hostPublicIps: [], blockedCidrs: [] },
  confirmedPolicyHash: egressPolicyHash({ mode: "restricted", policyHash: "sha256:pinned" }, []),
  confirmedRevocationWatermark: 2,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const repoRecording = () => {
  const confirmed: Array<{ policyHash: string | undefined; revocationWatermark: number }> = [];
  const repo: WorkspaceEgressRepoService = {
    getPolicy: () => Effect.die("unused"),
    putPolicy: () => Effect.die("unused"),
    revoke: () => Effect.die("unused"),
    listRevocations: () =>
      Effect.succeed([
        { id: 1, workspaceId: "ws_1", revocationWatermark: 2, kind: "secret", target: "psec_old", createdAt: new Date() },
      ]),
    tombstones: () => Effect.succeed(tombstonesOf(2, [])),
    ensureProxy: () => Effect.die("unused"),
    recordProxyNetwork: () => Effect.die("unused"),
    getProxy: () => Effect.die("unused"),
    confirmProxy: (input) =>
      Effect.sync(() => {
        confirmed.push({ policyHash: input.policyHash, revocationWatermark: input.revocationWatermark });
      }),
    listLiveProxies: () => Effect.succeed([]),
  };
  return { repo, confirmed };
};

/** A Docker host with the proxy container on it, running or not. */
const dockerWithProxy = (running: boolean) => {
  const calls: string[][] = [];
  const state = { running };
  const run: DockerCommandRunner = async (_command, args) => {
    calls.push([...args]);
    if (args[0] === "inspect") return { stdout: `cid\t${String(state.running)}\n`, stderr: "" };
    if (args[0] === "kill" || args[0] === "stop") state.running = false;
    if (args[0] === "start") state.running = true;
    if (args[0] === "network" && args[1] === "inspect") return { stdout: "id\n", stderr: "" };
    return { stdout: "", stderr: "" };
  };
  return { run, calls, state };
};

const clientWith = (overrides: Partial<ProxyAdminClient>) => {
  const pushed: ProxyPolicyDocument[] = [];
  const client: ProxyAdminClient = {
    health: async () => ({ initialized: true, revocationWatermark: 2, activeConnections: 0, leaseRemainingMs: 1, leaseExpired: false, resyncRequired: false }),
    putPolicy: async (document) => {
      pushed.push(document);
      return { policyHash: document.policyHash, revocationWatermark: document.revocationWatermark, closed: 0 };
    },
    revoke: async () => ({ revocationWatermark: 0, closed: 0 }),
    heartbeat: async (watermark) => ({ resyncRequired: false, leaseRemainingMs: 120_000, revocationWatermark: watermark }),
    ...overrides,
  };
  return { client, pushed };
};

describe("the egress proxy sweep", () => {
  let controlDir: string;
  beforeEach(async () => {
    controlDir = await mkdtemp(join(tmpdir(), "sealant-sweep-"));
  });
  afterEach(async () => {
    await rm(controlDir, { recursive: true, force: true });
  });

  const sweep = async (input: {
    readonly docker: ReturnType<typeof dockerWithProxy>;
    readonly client: ProxyAdminClient;
    readonly proxy?: WorkspaceEgressProxy;
    readonly watermark?: number;
  }) => {
    const { repo, confirmed } = repoRecording();
    const pool = { allocate: async () => "10.233.0.0/28", release: async () => undefined };
    const proxies = new EgressProxyOrchestrator({
      run: input.docker.run,
      subnets: pool,
      controlDir,
      controlMountArgs: () => [],
      adminClient: () => input.client,
      healthTimeoutMs: 500,
    });
    const outcome = await Effect.runPromise(
      sweepEgressProxy({
        live: { proxy: input.proxy ?? proxyRow(), policy: policy(input.watermark ?? 2) },
        repo,
        cipher,
        proxies,
      }),
    );
    return { outcome, confirmed };
  };

  it("only renews the lease of a proxy that is current", async () => {
    const { client, pushed } = clientWith({});
    const { outcome } = await sweep({ docker: dockerWithProxy(true), client });
    expect(outcome).toBe("renewed");
    expect(pushed).toHaveLength(0);
  });

  it("pushes the stored policy, tombstones included, when the proxy asks for a resync", async () => {
    const { client, pushed } = clientWith({
      heartbeat: async (watermark) => ({ resyncRequired: true, leaseRemainingMs: 120_000, revocationWatermark: watermark }),
    });
    const { outcome, confirmed } = await sweep({ docker: dockerWithProxy(true), client });
    expect(outcome).toBe("pushed");
    expect(pushed[0]).toMatchObject({ revocationWatermark: 2, revokedSecretIds: ["psec_old"], executorCaCertPem: ca.certPem });
    expect(confirmed).toEqual([{ policyHash: pushed[0]?.policyHash, revocationWatermark: 2 }]);
  });

  it("pushes a revocation the proxy never confirmed (the API could not reach it)", async () => {
    const { client, pushed } = clientWith({});
    const { outcome } = await sweep({ docker: dockerWithProxy(true), client, watermark: 3 });
    expect(outcome).toBe("pushed");
    expect(pushed[0]?.revocationWatermark).toBe(3);
  });

  it("kills a proxy that stops answering, then starts it again with the same CA and the full policy", async () => {
    const docker = dockerWithProxy(true);
    const { client, pushed } = clientWith({
      heartbeat: async () => {
        throw new ProxyAdminUnreachableError("connect ECONNREFUSED");
      },
    });
    const { outcome } = await sweep({ docker, client, watermark: 3 });
    expect(outcome).toBe("restarted");
    const verbs = docker.calls.map((call) => call[0]);
    expect(verbs.indexOf("kill")).toBeGreaterThanOrEqual(0);
    expect(verbs.indexOf("start")).toBeGreaterThan(verbs.indexOf("kill"));
    expect(pushed[0]).toMatchObject({ revocationWatermark: 3, executorCaCertPem: ca.certPem });
    expect(docker.state.running).toBe(true);
  });

  it("leaves a proxy whose launch has not measured the host to its launch", async () => {
    const { client } = clientWith({});
    const { outcome } = await sweep({ docker: dockerWithProxy(true), client, proxy: proxyRow({ network: null }) });
    expect(outcome).toBe("launching");
  });
});
