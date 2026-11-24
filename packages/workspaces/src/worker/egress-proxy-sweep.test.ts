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
  ProxyAdminRefusedError,
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

const policy = (revocationWatermark: number, policyRevision = 1): WorkspaceEgressPolicy => ({
  workspaceId: "ws_1",
  networkPolicy: { mode: "restricted", policyHash: "sha256:pinned" },
  brokeredSecrets: [],
  brokeredValuesSealed: Effect.runSync(sealBrokeredValues(cipher, {})).sealed,
  encryptionKeyId: "k1",
  revocationWatermark,
  policyRevision,
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
  network: {
    proxyIp: "10.233.0.14",
    operatorAllowedPrivateCidrs: [],
    hostPublicIps: [],
    blockedCidrs: [],
  },
  confirmedPolicyHash: egressPolicyHash({ mode: "restricted", policyHash: "sha256:pinned" }, []),
  confirmedRevocationWatermark: 2,
  confirmedPolicyRevision: 1,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const repoRecording = () => {
  const confirmed: Array<{
    policyHash: string | undefined;
    revocationWatermark: number;
    policyRevision?: number | undefined;
  }> = [];
  const networks: unknown[] = [];
  const repo: WorkspaceEgressRepoService = {
    getPolicy: () => Effect.die("unused"),
    putPolicy: () => Effect.die("unused"),
    revoke: () => Effect.die("unused"),
    listRevocations: () =>
      Effect.succeed([
        {
          id: 1,
          workspaceId: "ws_1",
          revocationWatermark: 2,
          kind: "secret",
          target: "psec_old",
          createdAt: new Date(),
        },
      ]),
    tombstones: () => Effect.succeed(tombstonesOf(2, [])),
    ensureProxy: () => Effect.die("unused"),
    recordProxyNetwork: (_runId, network) =>
      Effect.sync(() => {
        networks.push(network);
      }),
    getProxy: () => Effect.die("unused"),
    confirmProxy: (input) =>
      Effect.sync(() => {
        confirmed.push({
          policyHash: input.policyHash,
          revocationWatermark: input.revocationWatermark,
          policyRevision: input.policyRevision,
        });
      }),
    listLiveProxies: () => Effect.succeed([]),
  };
  return { repo, confirmed, networks };
};

/**
 * A Docker host with the proxy container on it, running or not, beside its workspace container
 * (running unless told otherwise), and one bridge on a public range.
 */
const dockerWithProxy = (
  running: boolean,
  options: { readonly workspaceRunning?: boolean } = {},
) => {
  const calls: string[][] = [];
  const state = { running };
  const workspaceRunning = options.workspaceRunning ?? true;
  const run: DockerCommandRunner = async (_command, args) => {
    calls.push([...args]);
    const last = args.at(-1) ?? "";
    if (args[0] === "inspect") {
      const up = last.endsWith("-proxy") ? state.running : workspaceRunning;
      return { stdout: `cid\t${String(up)}\n`, stderr: "" };
    }
    if (args[0] === "kill" || args[0] === "stop") state.running = false;
    if (args[0] === "start") state.running = true;
    if (args[0] === "network" && args[1] === "ls") return { stdout: "bridge-1\n", stderr: "" };
    if (args[0] === "network" && args[1] === "inspect" && args.includes("{{json .IPAM.Config}}")) {
      return { stdout: '[{"Subnet":"192.0.10.0/24","Gateway":"192.0.10.1"}]\n', stderr: "" };
    }
    if (args[0] === "network" && args[1] === "inspect") return { stdout: "id\n", stderr: "" };
    return { stdout: "", stderr: "" };
  };
  return { run, calls, state };
};

const clientWith = (overrides: Partial<ProxyAdminClient>) => {
  const pushed: ProxyPolicyDocument[] = [];
  const client: ProxyAdminClient = {
    health: async () => ({
      initialized: true,
      revocationWatermark: 2,
      activeConnections: 0,
      leaseRemainingMs: 1,
      leaseExpired: false,
      resyncRequired: false,
    }),
    putPolicy: async (document) => {
      pushed.push(document);
      return {
        policyHash: document.policyHash,
        revocationWatermark: document.revocationWatermark,
        closed: 0,
      };
    },
    revoke: async () => ({ revocationWatermark: 0, closed: 0 }),
    heartbeat: async (watermark) => ({
      resyncRequired: false,
      leaseRemainingMs: 120_000,
      revocationWatermark: watermark,
    }),
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
    readonly policyRevision?: number;
    /** No stored policy row at all (a standard host-vm run). */
    readonly unstored?: boolean;
  }) => {
    const { repo, confirmed, networks } = repoRecording();
    const pool = { allocate: async () => "10.233.0.0/28", release: async () => undefined };
    const proxies = new EgressProxyOrchestrator({
      run: input.docker.run,
      subnets: pool,
      controlDir,
      controlMountArgs: () => [],
      adminClient: () => input.client,
      healthTimeoutMs: 500,
      ownControlDirectory: async () => undefined,
    });
    const outcome = await Effect.runPromise(
      sweepEgressProxy({
        live: {
          proxy: input.proxy ?? proxyRow(),
          policy:
            input.unstored === true
              ? undefined
              : policy(input.watermark ?? 2, input.policyRevision ?? 1),
        },
        repo,
        cipher,
        proxies,
      }),
    );
    return { outcome, confirmed, networks };
  };

  it("only renews the lease of a proxy that is current", async () => {
    const { client, pushed } = clientWith({});
    const { outcome } = await sweep({ docker: dockerWithProxy(true), client });
    expect(outcome).toBe("renewed");
    expect(pushed).toHaveLength(0);
  });

  it("pushes the stored policy, tombstones included, when the proxy asks for a resync", async () => {
    const { client, pushed } = clientWith({
      heartbeat: async (watermark) => ({
        resyncRequired: true,
        leaseRemainingMs: 120_000,
        revocationWatermark: watermark,
      }),
    });
    const { outcome, confirmed } = await sweep({ docker: dockerWithProxy(true), client });
    expect(outcome).toBe("pushed");
    expect(pushed[0]).toMatchObject({
      revocationWatermark: 2,
      revokedSecretIds: ["psec_old"],
      executorCaCertPem: ca.certPem,
    });
    expect(confirmed).toEqual([
      { policyHash: pushed[0]?.policyHash, revocationWatermark: 2, policyRevision: 1 },
    ]);
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
    const { outcome } = await sweep({
      docker: dockerWithProxy(true),
      client,
      proxy: proxyRow({ network: null }),
    });
    expect(outcome).toBe("launching");
  });

  it("pushes again after a rotation of only a secret's value, whose policy hash did not move", async () => {
    const { client, pushed } = clientWith({});
    const { outcome, confirmed } = await sweep({
      docker: dockerWithProxy(true),
      client,
      policyRevision: 2,
    });
    expect(outcome).toBe("pushed");
    expect(pushed).toHaveLength(1);
    expect(confirmed[0]?.policyRevision).toBe(2);
  });

  it("measures the host's bridges again before a push, so the proxy refuses one made since", async () => {
    const { client, pushed } = clientWith({});
    const { networks } = await sweep({ docker: dockerWithProxy(true), client, watermark: 3 });
    expect(pushed[0]?.blockedCidrs).toEqual(
      expect.arrayContaining(["192.0.10.0/24", "192.0.10.1/32"]),
    );
    expect(networks).toHaveLength(1);
  });

  it("kills an unreachable proxy and leaves it down when its workspace is stopping", async () => {
    const docker = dockerWithProxy(true, { workspaceRunning: false });
    const { client, pushed } = clientWith({
      heartbeat: async () => {
        throw new ProxyAdminUnreachableError("connect ECONNREFUSED");
      },
    });
    const { outcome } = await sweep({ docker, client });
    expect(outcome).toBe("killed");
    expect(docker.state.running).toBe(false);
    expect(docker.calls.some((call) => call[0] === "start")).toBe(false);
    expect(pushed).toHaveLength(0);
  });

  it("resyncs a proxy that answers watermark_rollback rather than kill it", async () => {
    const docker = dockerWithProxy(true);
    const { client, pushed } = clientWith({
      heartbeat: async () => {
        throw new ProxyAdminRefusedError(409, "watermark_rollback", "behind");
      },
    });
    const { outcome } = await sweep({ docker, client });
    expect(outcome).toBe("pushed");
    expect(pushed).toHaveLength(1);
    expect(docker.calls.some((call) => call[0] === "kill")).toBe(false);
  });

  it("restarts a proxy that does not confirm closing what the policy revokes", async () => {
    const docker = dockerWithProxy(true);
    let refused = false;
    const { client } = clientWith({
      putPolicy: async (document) => {
        if (!refused) {
          refused = true;
          throw new ProxyAdminRefusedError(
            500,
            "close_unconfirmed",
            "1 connection did not confirm closing",
          );
        }
        return {
          policyHash: document.policyHash,
          revocationWatermark: document.revocationWatermark,
          closed: 1,
        };
      },
    });
    const { outcome } = await sweep({ docker, client, watermark: 3 });
    expect(outcome).toBe("restarted");
    expect(docker.calls.map((call) => call[0])).toContain("kill");
  });

  it("pushes a run with no stored policy once, then only renews it", async () => {
    const { client, pushed } = clientWith({});
    const first = await sweep({
      docker: dockerWithProxy(true),
      client,
      unstored: true,
      proxy: proxyRow({ confirmedPolicyRevision: null, confirmedRevocationWatermark: 0 }),
    });
    expect(first.outcome).toBe("pushed");
    expect(first.confirmed[0]?.policyRevision).toBe(0);
    const next = await sweep({
      docker: dockerWithProxy(true),
      client,
      unstored: true,
      proxy: proxyRow({ confirmedPolicyRevision: 0, confirmedRevocationWatermark: 0 }),
    });
    expect(next.outcome).toBe("renewed");
    expect(pushed).toHaveLength(1);
  });
});
