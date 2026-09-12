/**
 * Adapter behavior against an in-memory bridge: support gating, launch payload shape, endpoint
 * pass-through, idempotent stop, and readable failures. No network — fetch is injected.
 */
import { describe, expect, it } from "vitest";

import { cases, publishedImage } from "../docker-runtime-adapter.golden-fixture.js";
import { CloudflareRuntimeAdapter, supportForCloudflare } from "./adapter.js";
import { bridgeLaunchRequestSchema } from "./bridge-contract.js";
import { cloudflareRuntimeConfigSchema } from "./config.js";

const config = cloudflareRuntimeConfigSchema.parse({
  bridgeUrl: "https://bridge.example.com/",
  bridgeToken: "bridge-token",
});

interface RecordedRequest {
  readonly url: string;
  readonly method: string | undefined;
  readonly authorization: string | undefined;
  readonly body: unknown;
}

const fakeBridge = (respond: (request: RecordedRequest) => Response) => {
  const requests: RecordedRequest[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    const headers = new Headers(init?.headers);
    const recorded: RecordedRequest = {
      url: String(input),
      method: init?.method,
      authorization: headers.get("authorization") ?? undefined,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    requests.push(recorded);
    return Promise.resolve(respond(recorded));
  };
  return { requests, fetchImpl };
};

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("supportForCloudflare", () => {
  it("accepts a plain git-sourced ephemeral blueprint", () => {
    expect(supportForCloudflare({ blueprint: cases.gitSource.blueprint })).toEqual({
      supported: true,
    });
  });

  it("rejects other explicit runtime families", () => {
    expect(
      supportForCloudflare({
        blueprint: {
          ...cases.gitSource.blueprint,
          target: {
            ...cases.gitSource.blueprint.target,
            runtime: { family: "k8s", mode: "require" },
          },
        },
      }),
    ).toMatchObject({ supported: false, reason: "unsupported-runtime" });
  });

  it("rejects the DinD sidecar, gVisor, mount sources and extra mounts", () => {
    expect(supportForCloudflare({ blueprint: cases.dind.blueprint })).toMatchObject({
      supported: false,
      reason: "unsupported-runtime-requirement",
    });
    expect(
      supportForCloudflare({
        blueprint: {
          ...cases.gitSource.blueprint,
          runtime: { ...cases.gitSource.blueprint.runtime, ociRuntime: "runsc" },
        },
      }),
    ).toMatchObject({ supported: false, reason: "unsupported-runtime-requirement" });
    expect(supportForCloudflare({ blueprint: cases.mendMount.blueprint })).toMatchObject({
      supported: false,
      reason: "unsupported-runtime-requirement",
    });
  });

  it("accepts a capture source: nothing to mount, the daemon materialises from the channel", () => {
    expect(supportForCloudflare({ blueprint: cases.capture.blueprint })).toEqual({
      supported: true,
    });
  });

  it("rejects cluster env references (Kubernetes-only)", () => {
    expect(
      supportForCloudflare({
        blueprint: {
          ...cases.gitSource.blueprint,
          runtime: {
            ...cases.gitSource.blueprint.runtime,
            envFrom: [{ kind: "secret", name: "app-env" }],
          },
        },
      }),
    ).toMatchObject({ supported: false, reason: "unsupported-runtime-requirement" });
  });
});

describe("CloudflareRuntimeAdapter.launch", () => {
  it("POSTs a contract-valid payload and maps the bridge answer onto the launch result", async () => {
    const bridge = fakeBridge(() =>
      json(200, {
        resourceId: "do-abc",
        reference: "cf-run-golden-1",
        status: "ready",
        controlEndpoint: "wss://bridge.example.com/v1/workspaces/do-abc/control",
      }),
    );
    const adapter = new CloudflareRuntimeAdapter({ config, fetchImpl: bridge.fetchImpl });

    const result = await adapter.launch(cases.gitSource);

    expect(result).toEqual({
      adapter: "cloudflare",
      resourceId: "do-abc",
      reference: "cf-run-golden-1",
      status: "ready",
      endpoint: "wss://bridge.example.com/v1/workspaces/do-abc/control",
    });

    const request = bridge.requests[0];
    expect(request?.url).toBe("https://bridge.example.com/v1/workspaces");
    expect(request?.method).toBe("POST");
    expect(request?.authorization).toBe("Bearer bridge-token");
    const payload = bridgeLaunchRequestSchema.parse(request?.body);
    expect(payload.runId).toBe("run-golden-1");
    // `kind` is the contract's parse-time default; the wire body carries none (asserted below).
    expect(payload.source).toEqual({
      kind: "git",
      url: "https://github.com/example/repo.git",
      ref: "main",
      auth: { username: "x-access-token", token: "ghs_secret" },
    });
    expect(request?.body).toMatchObject({ source: expect.not.objectContaining({ kind: "git" }) });
    expect(payload.image).toEqual(publishedImage);
    // Later wins: blueprint env, then platform env, then credential env.
    expect(payload.env).toEqual({
      NODE_ENV: "development",
      SEALANT_DOTFILES_HTTP_TOKEN: "dot_secret",
      GITHUB_TOKEN: "gh_secret",
      CLAUDE_CODE_OAUTH_TOKEN: "cc_secret",
    });
  });

  it("POSTs a capture source with its channel facts and the token only inside secretEnv", async () => {
    const bridge = fakeBridge(() =>
      json(200, {
        resourceId: "do-cap",
        status: "ready",
        controlEndpoint: "wss://bridge.example.com/v1/workspaces/do-cap/control",
      }),
    );
    const adapter = new CloudflareRuntimeAdapter({ config, fetchImpl: bridge.fetchImpl });

    await adapter.launch({ ...cases.capture, secretEnvDir: undefined });

    const payload = bridgeLaunchRequestSchema.parse(bridge.requests[0]?.body);
    expect(payload.source).toEqual({
      kind: "capture",
      endpoint: "https://mend.example.com/session/s1",
      worktreeId: "wt_1",
    });
    expect(payload.secretEnv).toEqual({
      MEND_SESSION_TOKEN: "mst_secret",
      SEALANT_CAPTURE_TOKEN: "mst_secret",
    });
    expect(payload.env).toEqual({ MEND_SESSION_ID: "1" });
    // The wire payload for a git source is unchanged: no `kind` key, the contract defaults it.
    await adapter.launch(cases.gitSource);
    const gitBody = bridge.requests[1]?.body as { source?: Record<string, unknown> };
    expect(gitBody.source).not.toHaveProperty("kind");
  });

  it("surfaces the bridge's message on failure", async () => {
    const bridge = fakeBridge(() => json(503, { message: "no sandbox capacity" }));
    const adapter = new CloudflareRuntimeAdapter({ config, fetchImpl: bridge.fetchImpl });
    await expect(adapter.launch(cases.gitSource)).rejects.toThrow("no sandbox capacity");
  });

  it("refuses a launch without a runId instead of minting a duplicate-prone identity", async () => {
    const bridge = fakeBridge(() => json(200, {}));
    const adapter = new CloudflareRuntimeAdapter({ config, fetchImpl: bridge.fetchImpl });
    const { runId: _runId, ...withoutRunId } = cases.gitSource;
    await expect(adapter.launch(withoutRunId)).rejects.toThrow("runId");
    expect(bridge.requests).toHaveLength(0);
  });
});

describe("CloudflareRuntimeAdapter.stop", () => {
  it("DELETEs the workspace and reports the bridge outcome", async () => {
    const bridge = fakeBridge(() => json(200, { outcome: "stopped" }));
    const adapter = new CloudflareRuntimeAdapter({ config, fetchImpl: bridge.fetchImpl });
    await expect(adapter.stop({ resourceId: "do-abc" })).resolves.toEqual({
      adapter: "cloudflare",
      resourceId: "do-abc",
      outcome: "stopped",
    });
    expect(bridge.requests[0]?.url).toBe("https://bridge.example.com/v1/workspaces/do-abc");
    expect(bridge.requests[0]?.method).toBe("DELETE");
  });

  it("asks the bridge to fence (destroy) only when the stop says so", async () => {
    const bridge = fakeBridge(() => json(200, { outcome: "stopped" }));
    const adapter = new CloudflareRuntimeAdapter({ config, fetchImpl: bridge.fetchImpl });
    await adapter.stop({ resourceId: "do-abc", fence: true });
    expect(bridge.requests[0]?.url).toBe(
      "https://bridge.example.com/v1/workspaces/do-abc?mode=fence",
    );
    await adapter.stop({ resourceId: "do-abc", fence: false });
    expect(bridge.requests[1]?.url).toBe("https://bridge.example.com/v1/workspaces/do-abc");
  });

  it("treats a 404 as not-found (idempotent stop)", async () => {
    const bridge = fakeBridge(() => json(404, { message: "unknown workspace" }));
    const adapter = new CloudflareRuntimeAdapter({ config, fetchImpl: bridge.fetchImpl });
    await expect(adapter.stop({ resourceId: "gone" })).resolves.toEqual({
      adapter: "cloudflare",
      resourceId: "gone",
      outcome: "not-found",
    });
  });
});
