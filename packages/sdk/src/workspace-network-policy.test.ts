/**
 * A workspace's network policy and brokered secrets over real HTTP: what `create()` sends where
 * (the values never in the spec), what is refused before any request, and the policy, revocation
 * and read calls a workspace handle makes for its owner.
 */
import { createServer } from "node:http";

import { describe, expect, it } from "vitest";

import { opencode, Sealant, type BrokeredSecret, type CreateOptions } from "./index.js";

interface Received {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
}

const WORKSPACE_ID = "ws_policy";
const OWNER = "usr_owner";

const answer = (method: string, path: string): { status: number; body: unknown } => {
  if (method === "POST" && path === "/v1/workspaces") {
    return {
      status: 202,
      body: {
        workspaceId: WORKSPACE_ID,
        name: "policy test",
        status: "queued",
        registryId: "default",
        repository: "fixture",
        tag: "latest",
      },
    };
  }
  if (method === "PUT" && path === `/v1/workspaces/${WORKSPACE_ID}/network-policy`) {
    return {
      status: 200,
      body: {
        workspaceId: WORKSPACE_ID,
        policyHash: "sha256:new",
        revocationWatermark: 3,
        enforcement: "enforced",
        closed: 2,
      },
    };
  }
  if (method === "POST" && path === `/v1/workspaces/${WORKSPACE_ID}/network-policy/revocations`) {
    return {
      status: 200,
      body: { workspaceId: WORKSPACE_ID, revocationWatermark: 4, enforcement: "pending" },
    };
  }
  if (method === "GET" && path === `/v1/workspaces/${WORKSPACE_ID}/network-policy`) {
    return {
      status: 200,
      body: {
        workspaceId: WORKSPACE_ID,
        networkPolicy: { mode: "restricted", policyHash: "sha256:new" },
        brokeredSecrets: [secret],
        revocationWatermark: 4,
        revocations: [
          {
            revocationWatermark: 4,
            kind: "secret",
            target: "sec_old",
            revokedAt: "2026-11-24T10:00:00.000Z",
          },
          { revocationWatermark: 2, kind: "all", revokedAt: "2026-11-23T10:00:00.000Z" },
        ],
        proxy: { runId: "run_1", confirmedPolicyHash: "sha256:new" },
      },
    };
  }
  return { status: 404, body: { _tag: "WorkspaceNotFoundError", message: "no route" } };
};

const serve = async () => {
  const received: Received[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const text = Buffer.concat(chunks).toString();
      const method = request.method ?? "";
      const url = request.url ?? "";
      received.push({ method, url, body: text.length === 0 ? undefined : JSON.parse(text) });
      const { status, body } = answer(method, url.split("?")[0] ?? "");
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    })().catch(() => {
      response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected a TCP listener");
  const client = new Sealant({
    baseUrl: `http://127.0.0.1:${address.port}`,
    ownerUserId: OWNER,
  });
  return {
    client,
    received,
    [Symbol.asyncDispose]: async () => {
      await client.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error !== undefined) reject(error);
          else resolve();
        }),
      );
    },
  };
};

const secret: BrokeredSecret = {
  secretId: "sec_github",
  name: "GITHUB_AUTH",
  placeholder: "sealant-placeholder-github",
  secretRef: "github",
  headerName: "Authorization",
  bindHosts: ["api.github.com"],
};

const SECRET_VALUE = "Bearer ghp_real_value_never_in_the_spec";

const options: CreateOptions = {
  repository: "github.com/acme/app",
  harness: opencode(),
  wait: false,
  networkPolicy: {
    mode: "restricted",
    policyHash: "sha256:create",
    allowHosts: [{ host: "api.github.com" }],
  },
  brokeredSecrets: [secret],
  brokeredSecretValues: { github: SECRET_VALUE },
};

describe("workspaces.create with a network policy", () => {
  it("sends the policy and the secrets in the spec, and their values only beside it", async () => {
    await using f = await serve();
    await f.client.workspaces.create(options);
    expect(f.received).toHaveLength(1);
    const body = f.received[0]?.body;
    expect(body).toMatchObject({
      spec: { networkPolicy: options.networkPolicy, brokeredSecrets: [secret] },
      brokeredSecretValues: { github: SECRET_VALUE },
    });
    const spec = typeof body === "object" && body !== null && "spec" in body ? body.spec : null;
    expect(JSON.stringify(spec)).not.toContain(SECRET_VALUE);
  });

  it.each([
    [
      "a header that routes the request",
      { brokeredSecrets: [{ ...secret, headerName: "Host" }] },
      "headerName `Host` frames or routes the request and cannot carry a secret",
    ],
    [
      "a wildcard bind host",
      { brokeredSecrets: [{ ...secret, bindHosts: ["*.github.com"] }] },
      "bindHosts `*.github.com` is a wildcard; name exact hosts",
    ],
    [
      "a secret with no value",
      { brokeredSecretValues: {} },
      "brokeredSecretValues has no value for secretRef `github`",
    ],
    [
      "a placeholder variable also set in env",
      { env: { GITHUB_AUTH: "x" } },
      "GITHUB_AUTH is also set in runtime.env or runtime.userEnv",
    ],
  ] as const)("refuses %s before sending anything", async (_case, change, words) => {
    await using f = await serve();
    const refused = f.client.workspaces.create({ ...options, ...change });
    await expect(refused).rejects.toMatchObject({ code: "invalid_network_policy" });
    await expect(refused).rejects.toThrow(words);
    expect(f.received).toHaveLength(0);
  });

  it("never quotes a refused value", async () => {
    await using f = await serve();
    const refused = f.client.workspaces.create({
      ...options,
      brokeredSecretValues: { github: `${SECRET_VALUE}\r\nX-Injected: 1` },
    });
    await expect(refused).rejects.toMatchObject({ code: "invalid_network_policy" });
    await expect(refused).rejects.not.toThrow(SECRET_VALUE);
  });
});

describe("a workspace's network policy", () => {
  it("applies a new policy for the workspace's owner and reports its enforcement", async () => {
    await using f = await serve();
    const workspace = await f.client.workspaces.create({
      repository: "github.com/acme/app",
      harness: opencode(),
      wait: false,
    });
    const applied = await workspace.applyNetworkPolicy({
      networkPolicy: { mode: "restricted", policyHash: "sha256:new" },
      brokeredSecrets: [secret],
      brokeredSecretValues: { github: SECRET_VALUE },
    });
    expect(applied).toEqual({
      policyHash: "sha256:new",
      revocationWatermark: 3,
      enforcement: "enforced",
      closed: 2,
    });
    expect(f.received.at(-1)).toEqual({
      method: "PUT",
      url: `/v1/workspaces/${WORKSPACE_ID}/network-policy`,
      body: {
        ownerUserId: OWNER,
        networkPolicy: { mode: "restricted", policyHash: "sha256:new" },
        brokeredSecrets: [secret],
        brokeredSecretValues: { github: SECRET_VALUE },
      },
    });
  });

  it("refuses a policy that breaks a rule without sending it", async () => {
    await using f = await serve();
    const workspace = await f.client.workspaces.create({
      repository: "github.com/acme/app",
      harness: opencode(),
      wait: false,
    });
    await expect(
      workspace.applyNetworkPolicy({
        networkPolicy: { mode: "restricted", policyHash: "sha256:new" },
        brokeredSecrets: [secret],
      }),
    ).rejects.toMatchObject({ code: "invalid_network_policy" });
    expect(f.received.map(({ method }) => method)).toEqual(["POST"]);
  });

  it("revokes access for the workspace's owner", async () => {
    await using f = await serve();
    const workspace = await f.client.workspaces.create({
      repository: "github.com/acme/app",
      harness: opencode(),
      wait: false,
    });
    const revoked = await workspace.revokeAccess({ secretIds: ["sec_github"], hosts: [] });
    expect(revoked).toEqual({ revocationWatermark: 4, enforcement: "pending" });
    expect(f.received.at(-1)).toEqual({
      method: "POST",
      url: `/v1/workspaces/${WORKSPACE_ID}/network-policy/revocations`,
      body: { ownerUserId: OWNER, secretIds: ["sec_github"] },
    });
  });

  it("refuses a revocation that names nothing without sending it", async () => {
    await using f = await serve();
    const workspace = await f.client.workspaces.create({
      repository: "github.com/acme/app",
      harness: opencode(),
      wait: false,
    });
    await expect(workspace.revokeAccess({ all: false, hosts: [] })).rejects.toMatchObject({
      code: "invalid_revocation",
    });
    expect(f.received.map(({ method }) => method)).toEqual(["POST"]);
  });

  it("reads the policy, its secrets, its revocations and what the proxy confirmed", async () => {
    await using f = await serve();
    const workspace = await f.client.workspaces.create({
      repository: "github.com/acme/app",
      harness: opencode(),
      wait: false,
    });
    await expect(workspace.networkPolicy()).resolves.toEqual({
      networkPolicy: { mode: "restricted", policyHash: "sha256:new" },
      brokeredSecrets: [secret],
      revocationWatermark: 4,
      revocations: [
        {
          revocationWatermark: 4,
          kind: "secret",
          target: "sec_old",
          revokedAt: "2026-11-24T10:00:00.000Z",
        },
        { revocationWatermark: 2, kind: "all", revokedAt: "2026-11-23T10:00:00.000Z" },
      ],
      proxy: { runId: "run_1", confirmedPolicyHash: "sha256:new" },
    });
    expect(f.received.at(-1)).toMatchObject({
      method: "GET",
      url: `/v1/workspaces/${WORKSPACE_ID}/network-policy?ownerUserId=${OWNER}`,
    });
  });
});
