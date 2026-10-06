/**
 * The SDK's per-person surface (Mend ADR 0016): `credentialsHome` on create rides the spec, `user`
 * reaches exec and sessions, `ready()` reports the launch's image with its per-person capability,
 * and `workspaces.inspectImage` reads the capability before a create. Driven against a stub
 * contract client, and a stubbed `fetch` for the client-level read.
 */
import type {
  CreateSessionRequest,
  ExecWorkspaceRequest,
  WorkspaceDetails,
} from "@sealant/api-contracts";
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

const personLayout = {
  status: "unsupported" as const,
  missing: ["sudo"],
  runtime: "docker",
  acl: "unknown" as const,
};

const publishedImage = {
  reference: "registry/demo:plan-abc",
  digestReference: "registry/demo@sha256:abc",
  digest: "sha256:abc",
  personLayout,
};

// The derived `ControlPlaneClient` surface is far wider; the narrowing cast is test-only.
const makeStub = (processUser = true) => {
  const requests: Array<{ readonly op: string; readonly body: unknown }> = [];
  const details: WorkspaceDetails = {
    workspaceId: "ws_1",
    name: "t",
    ownerUserId: "usr_owner",
    status: "ready",
    publishedImage,
    createdAt: "2026-10-06T00:00:00.000Z",
    updatedAt: "2026-10-06T00:00:00.000Z",
  };
  const workspaces = {
    execWorkspace: (request: { payload: ExecWorkspaceRequest }) => {
      requests.push({ op: "exec", body: request.payload });
      return Effect.die("stop after the request");
    },
    getWorkspace: () => Effect.succeed(details),
  };
  const sessions = {
    createSession: (request: { payload: CreateSessionRequest }) => {
      requests.push({ op: "session", body: request.payload });
      return Effect.die("stop after the request");
    },
  };
  const system = {
    getIndex: () =>
      Effect.succeed({
        name: "Sealant Control Plane API",
        version: "0.0.0",
        docsPath: "/docs",
        openApiPath: "/openapi.json",
        features: { processUser },
      }),
  };
  return { client: { workspaces, sessions, system } as unknown as ControlPlaneClient, requests };
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

describe("credentialsHome", () => {
  it("rides the spec's runtime, so the launch writes the logins into it", () => {
    const { payload } = buildCreateWorkspaceRequest(
      {
        repository: "github.com/acme/app",
        harness: opencode(),
        credentialsHome: { path: "/home/m4lice000", uid: 40001, gid: 40000 },
      },
      config,
    );
    expect((payload.spec as { runtime?: unknown }).runtime).toMatchObject({
      credentialsHome: { path: "/home/m4lice000", uid: 40001, gid: 40000 },
    });
  });
});

describe("user on exec and sessions", () => {
  it("asks for the process to run as the user", async () => {
    const { client, requests } = makeStub();
    const workspace = makeWorkspace(makeCtx(client), { id: "ws_1", name: "t", status: "ready" });

    await expect(workspace.exec(["id"], { user: "m4lice000" })).rejects.toBeDefined();
    await expect(workspace.sessions.open(["bash"], { user: "40001" })).rejects.toBeDefined();

    expect(requests).toEqual([
      {
        op: "exec",
        body: {
          ownerUserId: "usr_owner",
          commands: [{ executable: "id", args: [] }],
          user: "m4lice000",
        },
      },
      {
        op: "session",
        body: { workspaceId: "ws_1", ownerUserId: "usr_owner", argv: ["bash"], user: "40001" },
      },
    ]);
  });
});

describe("user against a control plane that does not report it", () => {
  it("is refused here, and nothing is sent", async () => {
    const { client, requests } = makeStub(false);
    const workspace = makeWorkspace(makeCtx(client), { id: "ws_1", name: "t", status: "ready" });

    await expect(workspace.exec(["id"], { user: "m4lice000" })).rejects.toMatchObject({
      code: "user-unsupported",
    });
    await expect(workspace.sessions.open(["bash"], { user: "40001" })).rejects.toMatchObject({
      code: "user-unsupported",
    });
    expect(requests).toEqual([]);
  });
});

describe("workspaces.imageKey", () => {
  it("is computed without a call, the same for creates that plan one image", () => {
    const sealant = new Sealant({ baseUrl: "http://stub.invalid", ownerUserId: "usr_owner" });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const key = sealant.workspaces.imageKey({
      repository: "github.com/acme/app",
      harness: opencode(),
    });
    expect(key).toMatch(/^isk1-[0-9a-f]{32}$/);
    // Another repository, credentials or home: the same image.
    expect(
      sealant.workspaces.imageKey({
        repository: "github.com/acme/other",
        harness: opencode(),
        credentialsHome: { path: "/home/m4lice000", uid: 40001, gid: 40000 },
      }),
    ).toBe(key);
    // Another package: another image.
    expect(
      sealant.workspaces.imageKey({
        repository: "github.com/acme/app",
        harness: opencode(),
        packages: ["ripgrep"],
      }),
    ).not.toBe(key);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("the image's per-person capability", () => {
  it("is reported by ready() on the launch, and by image()", async () => {
    const { client } = makeStub();
    const workspace = makeWorkspace(makeCtx(client), {
      id: "ws_1",
      name: "t",
      status: "queued",
      launch: { replayed: false },
    });
    await workspace.ready();
    expect(workspace.launch?.image).toEqual(publishedImage);
    expect(await workspace.image()).toEqual(publishedImage);
  });

  it("is read before create, for the spec the create would send", async () => {
    const seen: Array<{ readonly url: string; readonly body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        seen.push({ url: request.url, body: await request.json() });
        return new Response(JSON.stringify({ planHash: "abc123", publishedImage, personLayout }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    const sealant = new Sealant({ baseUrl: "http://stub.invalid", ownerUserId: "usr_owner" });
    const options = { repository: "github.com/acme/app", harness: opencode() };

    const answer = await sealant.workspaces.inspectImage(options);

    expect(answer).toEqual({
      imageKey: sealant.workspaces.imageKey(options),
      planHash: "abc123",
      image: publishedImage,
      personLayout,
    });
    expect(seen[0]?.url).toBe("http://stub.invalid/v1/workspaces/image");
    expect(seen[0]?.body).toEqual({
      ownerUserId: "usr_owner",
      registryId: "default",
      spec: buildCreateWorkspaceRequest(options, config).payload.spec,
    });
    await sealant.close();
  });
});
