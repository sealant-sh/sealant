/**
 * The admin client and the policy document against a real `sealant-egress-proxy` binary: the
 * wire is the proxy's, not this package's reading of it. Run with the binary built from sealantd
 * (`cargo build -p sealant-egress-proxy`):
 *
 *   SEALANT_EGRESS_PROXY_BINARY=/path/to/sealant-egress-proxy \
 *     pnpm exec vitest run src/runtime/egress-proxy.e2e.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Redacted } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildProxyPolicyDocument, proxyRevokeRequest } from "./egress-proxy-policy.js";
import { generateExecutorCa } from "./executor-ca.js";
import {
  createProxyAdminClient,
  ProxyAdminRefusedError,
  ProxyAdminUnreachableError,
  type ProxyAdminClient,
} from "./proxy-admin-client.js";

const binary = process.env["SEALANT_EGRESS_PROXY_BINARY"];

const loopback = (port: number) => `127.0.0.1:${String(port)}`;

describe.skipIf(binary === undefined)("the admin wire of a real egress proxy", () => {
  let directory: string;
  let proxy: ChildProcess;
  let client: ProxyAdminClient;
  const ca = generateExecutorCa({ executor: "sealant-e2e" });

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "sealant-proxy-e2e-"));
    const socket = join(directory, "proxy-admin.sock");
    const base = 20_000 + Math.floor(Math.random() * 20_000);
    proxy = spawn(
      binary ?? "",
      [
        "--admin-socket",
        socket,
        "--http-proxy",
        loopback(base),
        "--transparent-http",
        loopback(base + 1),
        "--transparent-https",
        loopback(base + 2),
        "--transparent-tcp",
        loopback(base + 3),
        "--transparent-resource",
        loopback(base + 4),
        "--dns",
        loopback(base + 5),
        "--upstream-dns",
        "127.0.0.1:53",
      ],
      { stdio: ["ignore", "ignore", "inherit"] },
    );
    client = createProxyAdminClient(socket, { timeoutMs: 5_000 });
    const deadline = Date.now() + 10_000;
    for (;;) {
      try {
        await client.health();
        return;
      } catch (error) {
        if (Date.now() > deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  });

  afterAll(async () => {
    proxy.kill("SIGTERM");
    await rm(directory, { recursive: true, force: true });
  });

  const document = (revocationWatermark: number, revokedSecretIds: readonly string[] = []) =>
    buildProxyPolicyDocument({
      networkPolicy: {
        mode: "restricted",
        policyHash: "sha256:e2e",
        allowHosts: [{ host: "registry.npmjs.org" }, { host: "api.github.com", inspectTls: true }],
        allowResources: [{ name: "db", host: "db", port: 5432, guestIp: "10.201.0.1" }],
      },
      brokeredSecrets: [
        {
          secretId: "psec_vercel",
          name: "VERCEL_TOKEN",
          placeholder: "mend_sec_0123456789abcdefghijklmn",
          secretRef: "ref-vercel",
          headerName: "Authorization",
          bindHosts: ["api.vercel.com"],
        },
      ],
      brokeredValues: Redacted.make({ "ref-vercel": "Bearer not-a-real-token" }),
      ca,
      tombstones: { revocationWatermark, revokedSecretIds, revokedHosts: [] },
      host: {
        operatorAllowedPrivateCidrs: ["10.42.0.0/16"],
        hostPublicIps: ["203.0.113.7/32"],
        blockedCidrs: [],
      },
    });

  it("starts closed", async () => {
    const health = await client.health();
    expect(health.initialized).toBe(false);
  });

  it("loads the policy sealant builds, executor CA and brokered secret included", async () => {
    const applied = await client.putPolicy(document(1));
    expect(applied).toEqual({ policyHash: "sha256:e2e", revocationWatermark: 1, closed: 0 });
    const health = await client.health();
    expect(health).toMatchObject({
      initialized: true,
      mode: "restricted",
      policyHash: "sha256:e2e",
      revocationWatermark: 1,
      leaseExpired: false,
      resyncRequired: false,
    });
    expect(health.leaseRemainingMs).toBeGreaterThan(110_000);
    expect(health.leaseRemainingMs).toBeLessThanOrEqual(120_000);
  });

  it("renews the lease, and asks for a resync when sealant holds a newer watermark", async () => {
    expect((await client.heartbeat(1)).resyncRequired).toBe(false);
    const ahead = await client.heartbeat(2);
    expect(ahead).toMatchObject({ resyncRequired: true, revocationWatermark: 2 });
    const reloaded = await client.putPolicy(document(2, ["psec_vercel"]));
    expect(reloaded.revocationWatermark).toBe(2);
    expect((await client.health()).resyncRequired).toBe(false);
  });

  it("revokes, and refuses a watermark behind its own as the error callers branch on", async () => {
    const revoked = await client.revoke(
      proxyRevokeRequest({
        revocationWatermark: 3,
        secretIds: [],
        hosts: ["api.github.com"],
        all: false,
      }),
    );
    expect(revoked).toEqual({ revocationWatermark: 3, closed: 0 });
    const behind = await client.putPolicy(document(2)).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(behind).toBeInstanceOf(ProxyAdminRefusedError);
    expect(behind).toMatchObject({ status: 409, code: "watermark_rollback" });
  });

  it("refuses a framing header the way sealant's own rules do", async () => {
    const bad = {
      ...document(3),
      brokeredSecrets: [{ ...document(3).brokeredSecrets[0]!, headerName: "Host" }],
    };
    await expect(client.putPolicy(bad)).rejects.toMatchObject({
      status: 400,
      code: "invalid_policy",
    });
  });

  it("reports a socket nothing listens on as unreachable", async () => {
    const gone = createProxyAdminClient(join(directory, "absent.sock"), { timeoutMs: 1_000 });
    await expect(gone.health()).rejects.toBeInstanceOf(ProxyAdminUnreachableError);
  });
});
