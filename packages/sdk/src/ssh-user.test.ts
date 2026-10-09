/**
 * A workspace's SSH user (Mend ADR 0016: VS Code Remote-SSH as the launcher's Linux user):
 * `sshUser` rides the create's top level, `setSshUser()` sets and clears it, and neither is sent
 * to a control plane that does not report `features.workspaceSshUser` (its gateway would run the
 * session as root). Driven against a stub contract client, and a stubbed `fetch` for the create.
 */
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Sealant } from "./client.js";
import { type ControlPlaneClient, SealantApiClient } from "./effect/api-client.js";
import type { SdkRuntime, SdkServices } from "./effect/runtime.js";
import type { SdkContext } from "./facade/context.js";
import { makeWorkspace } from "./facade/workspace.js";
import { opencode } from "./harness.js";
import { buildCreateWorkspaceRequest } from "./internal/blueprint.js";
import { resolveInternalConfig } from "./internal/config.js";

const config = resolveInternalConfig({ baseUrl: "http://stub.invalid", ownerUserId: "usr_owner" });

// The derived `ControlPlaneClient` surface is far wider; the narrowing cast is test-only.
const makeStub = (features: Record<string, boolean>) => {
  const requests: Array<{ readonly op: string; readonly body: unknown }> = [];
  const workspaces = {
    setWorkspaceSshUser: (request: { payload: unknown }) => {
      requests.push({ op: "ssh-user", body: request.payload });
      return Effect.succeed({ workspaceId: "ws_1", sshUser: null });
    },
  };
  const system = {
    getIndex: () =>
      Effect.succeed({
        name: "Sealant Control Plane API",
        version: "0.0.0",
        docsPath: "/docs",
        openApiPath: "/openapi.json",
        features,
      }),
  };
  return { client: { workspaces, system } as unknown as ControlPlaneClient, requests };
};

const makeCtx = (client: ControlPlaneClient): SdkContext => ({
  runtime: {
    run: <A, E, R extends SdkServices>(effect: Effect.Effect<A, E, R>): Promise<A> =>
      // The stub provides all of SdkServices; see run-lifecycle.test.ts for the same narrowing.
      Effect.runPromise(
        Effect.provideService(effect, SealantApiClient, client) as Effect.Effect<A, E>,
      ),
    dispose: () => Promise.resolve(),
  } satisfies SdkRuntime,
  config,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a workspace's SSH user", () => {
  it("rides the create's top level, never the spec", () => {
    const { payload } = buildCreateWorkspaceRequest(
      { repository: "github.com/acme/app", harness: opencode(), sshUser: "m4lice000" },
      config,
    );
    expect(payload.sshUser).toBe("m4lice000");
    expect(JSON.stringify(payload.spec)).not.toContain("m4lice000");
  });

  it("is set and cleared with setSshUser()", async () => {
    const { client, requests } = makeStub({ workspaceSshUser: true });
    const workspace = makeWorkspace(makeCtx(client), { id: "ws_1", name: "t", status: "ready" });

    await workspace.setSshUser("m4lice000");
    await workspace.setSshUser(null);

    expect(requests).toEqual([
      { op: "ssh-user", body: { user: "m4lice000", ownerUserId: "usr_owner" } },
      { op: "ssh-user", body: { user: null, ownerUserId: "usr_owner" } },
    ]);
  });

  it("is refused here against a control plane that does not report it, and nothing is sent", async () => {
    const { client, requests } = makeStub({ processUserRoutes: true });
    const workspace = makeWorkspace(makeCtx(client), { id: "ws_1", name: "t", status: "ready" });

    await expect(workspace.setSshUser("m4lice000")).rejects.toMatchObject({
      code: "ssh-user-unsupported",
    });
    expect(requests).toEqual([]);
  });

  it("refuses a create with one against such a control plane, creating nothing", async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        seen.push(`${request.method} ${new URL(request.url).pathname}`);
        return new Response(
          JSON.stringify({
            name: "Sealant Control Plane API",
            version: "0.0.0",
            docsPath: "/docs",
            openApiPath: "/openapi.json",
            features: { processUser: false, processUserRoutes: true },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );
    const sealant = new Sealant({ baseUrl: "http://stub.invalid", ownerUserId: "usr_owner" });

    await expect(
      sealant.workspaces.create({
        repository: "github.com/acme/app",
        harness: opencode(),
        sshUser: "m4lice000",
      }),
    ).rejects.toMatchObject({ code: "ssh-user-unsupported" });
    expect(seen.some((call) => call.startsWith("POST /v1/workspaces"))).toBe(false);
    await sealant.close();
  });
});
