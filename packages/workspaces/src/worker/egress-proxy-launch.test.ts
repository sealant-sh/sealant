import { randomBytes, X509Certificate } from "node:crypto";

import { CredentialCipher, credentialCipherLayer } from "@sealant/credentials";
import {
  tombstonesOf,
  type WorkspaceEgressPolicy,
  type WorkspaceEgressProxy,
  type WorkspaceEgressRepoService,
  type WorkspaceEgressRevocation,
} from "@sealant/db";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { sealBrokeredValues } from "../runtime/egress-proxy-store.js";
import {
  egressProxyLaunch,
  withBrokeredPlaceholders,
  withPinnedEgressPolicy,
} from "./egress-proxy-launch.js";

const cipher = Effect.runSync(
  Effect.gen(function* () {
    return yield* CredentialCipher;
  }).pipe(Effect.provide(credentialCipherLayer({ key: randomBytes(32).toString("base64") }))),
);

const BROKERED = {
  secretId: "psec_vercel",
  name: "VERCEL_TOKEN",
  placeholder: "mend_sec_0123456789abcdefghijklmn",
  secretRef: "ref-vercel",
  headerName: "Authorization",
  bindHosts: ["api.vercel.com"],
};

/** The egress store in memory, as the repository's interface promises it. */
const memoryRepo = (policy: WorkspaceEgressPolicy | undefined) => {
  const proxies = new Map<string, WorkspaceEgressProxy>();
  const revocations: WorkspaceEgressRevocation[] = [];
  const now = new Date();
  const repo: WorkspaceEgressRepoService = {
    getPolicy: () => Effect.succeed(policy),
    putPolicy: () => Effect.die("unused"),
    revoke: () => Effect.die("unused"),
    listRevocations: () => Effect.succeed(revocations),
    tombstones: () => Effect.succeed(tombstonesOf(0, revocations)),
    ensureProxy: (input) =>
      Effect.sync(() => {
        const existing = proxies.get(input.runId);
        if (existing !== undefined) return { proxy: existing, created: false };
        const created: WorkspaceEgressProxy = {
          ...input,
          network: null,
          confirmedPolicyHash: null,
          confirmedRevocationWatermark: null,
          createdAt: now,
          updatedAt: now,
        };
        proxies.set(input.runId, created);
        return { proxy: created, created: true };
      }),
    recordProxyNetwork: (runId, network) =>
      Effect.sync(() => {
        const proxy = proxies.get(runId);
        if (proxy !== undefined) proxies.set(runId, { ...proxy, network });
      }),
    getProxy: (runId) => Effect.sync(() => proxies.get(runId)),
    confirmProxy: (input) =>
      Effect.sync(() => {
        const proxy = proxies.get(input.runId);
        if (proxy !== undefined)
          proxies.set(input.runId, {
            ...proxy,
            confirmedPolicyHash: input.policyHash ?? proxy.confirmedPolicyHash,
            confirmedRevocationWatermark: input.revocationWatermark,
          });
      }),
    listLiveProxies: () => Effect.succeed([]),
  };
  return { repo, proxies };
};

const storedPolicy = (): WorkspaceEgressPolicy => {
  const sealed = Effect.runSync(sealBrokeredValues(cipher, { "ref-vercel": "Bearer sk-live" }));
  return {
    workspaceId: "ws_1",
    networkPolicy: { mode: "restricted", policyHash: "sha256:pinned" },
    brokeredSecrets: [BROKERED],
    brokeredValuesSealed: sealed.sealed,
    encryptionKeyId: sealed.keyId,
    revocationWatermark: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
};

const measured = {
  proxyContainer: "sealant-run-1-proxy",
  adminSocketPath: "/run/sealant/sockets/sealant-run-1-proxy/proxy-admin.sock",
  proxyIp: "10.233.0.14",
  host: { operatorAllowedPrivateCidrs: [], hostPublicIps: ["203.0.113.9/32"], blockedCidrs: [] },
};

describe("the worker's half of a proxy-backed launch", () => {
  it("mints one CA per run, keeps its key sealed, and gives a redelivered launch the same CA", async () => {
    const { repo, proxies } = memoryRepo(storedPolicy());
    const launch = egressProxyLaunch({ runId: "run-1", workspaceId: "ws_1", repo, cipher });
    const first = await launch.prepare(measured);
    const again = await egressProxyLaunch({
      runId: "run-1",
      workspaceId: "ws_1",
      repo,
      cipher,
    }).prepare(measured);
    expect(again.caCertPem).toBe(first.caCertPem);
    expect(new X509Certificate(first.caCertPem).ca).toBe(true);
    const stored = proxies.get("run-1");
    expect(stored?.caKeySealed).not.toContain("PRIVATE KEY");
    expect(stored?.network).toMatchObject({ proxyIp: "10.233.0.14" });
    // The proxy alone gets the key and the real value.
    expect(first.document.executorCaKeyPem).toContain("PRIVATE KEY");
    expect(first.document.brokeredSecrets[0]?.value).toBe("Bearer sk-live");
    expect(first.document).toMatchObject({ mode: "restricted", policyHash: "sha256:pinned" });
  });

  it("records what the proxy confirmed", async () => {
    const { repo, proxies } = memoryRepo(storedPolicy());
    const launch = egressProxyLaunch({ runId: "run-1", workspaceId: "ws_1", repo, cipher });
    await launch.prepare(measured);
    await launch.confirmed?.({ policyHash: "sha256:pinned", revocationWatermark: 0, closed: 0 });
    expect(proxies.get("run-1")).toMatchObject({
      confirmedPolicyHash: "sha256:pinned",
      confirmedRevocationWatermark: 0,
    });
  });

  it("refuses to load a proxy for a workspace with no stored policy", async () => {
    const { repo } = memoryRepo(undefined);
    await expect(
      egressProxyLaunch({ runId: "run-1", workspaceId: "ws_1", repo, cipher }).prepare(measured),
    ).rejects.toThrow(/no stored network policy/);
  });
});

describe("what a proxy-backed workspace boots with", () => {
  it("gets each placeholder in the secret channel, over any secret env of the same name, never the value", () => {
    expect(withBrokeredPlaceholders({ OTHER: "x" }, [BROKERED])).toEqual({
      OTHER: "x",
      VERCEL_TOKEN: "mend_sec_0123456789abcdefghijklmn",
    });
    expect(withBrokeredPlaceholders(undefined, [])).toBeUndefined();
  });

  it("launches under the pinned policy, not the one it was created with", () => {
    const created: {
      readonly harness: string;
      readonly networkPolicy?: {
        readonly mode: "standard" | "restricted";
        readonly policyHash: string;
      };
      readonly brokeredSecrets?: readonly (typeof BROKERED)[];
    } = { harness: "x", networkPolicy: { mode: "standard", policyHash: "sha256:created" } };
    const pinned = withPinnedEgressPolicy(created, storedPolicy());
    expect(pinned.networkPolicy?.policyHash).toBe("sha256:pinned");
    expect(pinned.brokeredSecrets).toEqual([BROKERED]);
    expect(withPinnedEgressPolicy(created, undefined)).toBe(created);
  });
});
