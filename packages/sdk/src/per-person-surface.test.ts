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
import { SealantError } from "./errors.js";
import type { SdkContext } from "./facade/context.js";
import { makeWorkspace } from "./facade/workspace.js";
import { opencode } from "./harness.js";
import { buildCreateWorkspaceRequest } from "./internal/blueprint.js";
import { resolveInternalConfig } from "./internal/config.js";
import { readFeatures } from "./internal/features.js";
import type { WorkspaceCaptureOwnerMap } from "./types.js";

const config = resolveInternalConfig({ baseUrl: "http://stub.invalid", ownerUserId: "usr_owner" });

const personLayout = {
  status: "unsupported" as const,
  missing: ["setpriv"],
  unknown: [],
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
const makeStub = (features: Record<string, boolean> = { processUserRoutes: true }) => {
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
    execWorkspaceAsUser: (request: { payload: ExecWorkspaceRequest }) => {
      requests.push({ op: "exec-as-user", body: request.payload });
      return Effect.die("stop after the request");
    },
    getWorkspace: () => Effect.succeed(details),
  };
  const sessions = {
    createSession: (request: { payload: CreateSessionRequest }) => {
      requests.push({ op: "session", body: request.payload });
      return Effect.die("stop after the request");
    },
    createSessionAsUser: (request: { payload: CreateSessionRequest }) => {
      requests.push({ op: "session-as-user", body: request.payload });
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
        features,
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

const captureSource = (map: WorkspaceCaptureOwnerMap | undefined) => ({
  kind: "capture" as const,
  endpoint: "https://mend.example.com/session/s1",
  worktreeId: "wt_1",
  token: "mct_1",
  harnessHome: "/workspace/harness-home",
  ...(map === undefined ? {} : { ownerMap: map }),
});

describe("a capture source's ownerMap", () => {
  const ownerMap = {
    gid: 40000,
    worktreeUid: 40012,
    people: [
      { id: "acct_a", uid: 40012 },
      { id: "acct_b", uid: 40031 },
    ],
  };

  it("rides the spec's capture source as given, and is absent when not given", () => {
    const { payload } = buildCreateWorkspaceRequest(
      { source: captureSource(ownerMap), harness: opencode() },
      config,
    );
    const spec = payload.spec as { sources: { workspace: Record<string, unknown> } };
    expect(spec.sources.workspace["ownerMap"]).toEqual(ownerMap);
    const plain = buildCreateWorkspaceRequest(
      { source: captureSource(undefined), harness: opencode() },
      config,
    ).payload.spec as { sources: { workspace: Record<string, unknown> } };
    expect(plain.sources.workspace).not.toHaveProperty("ownerMap");
  });

  it("is refused as a SealantError, never a TypeError, when plain JavaScript hands a malformed map", () => {
    for (const malformed of [
      { gid: 40000, worktreeUid: 40012 },
      { gid: 40000, worktreeUid: 40012, people: [null] },
      { gid: 40000, worktreeUid: 40012, people: [{ uid: 40012 }] },
      null,
    ]) {
      let thrown: unknown;
      try {
        buildCreateWorkspaceRequest(
          {
            // A plain JavaScript caller: nothing typed reaches here.
            source: JSON.parse(
              JSON.stringify({ ...captureSource(undefined), ownerMap: malformed }),
            ),
            harness: opencode(),
          },
          config,
        );
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(SealantError);
      expect(thrown).toMatchObject({ code: "invalid_create_options" });
    }
  });

  it("is refused here, with the control plane's words, before anything is sent", () => {
    for (const [bad, reason] of [
      [{ ...ownerMap, gid: 1000 }, /gid must be 40000/],
      [{ ...ownerMap, worktreeUid: 0 }, /worktreeUid 0/],
      [{ ...ownerMap, people: [{ id: "../x", uid: 40002 }] }, /people\[0\]\.id/],
      [
        {
          ...ownerMap,
          people: [
            { id: "acct_a", uid: 40012 },
            { id: "acct_b", uid: 40012 },
          ],
        },
        /the same uid 40012/,
      ],
    ] as const) {
      expect(() =>
        buildCreateWorkspaceRequest(
          {
            source: { ...captureSource(undefined), ownerMap: bad },
            harness: opencode(),
          },
          config,
        ),
      ).toThrow(reason);
    }
  });
});

describe("user on exec and sessions", () => {
  it("asks for the process to run as the user on the as-user routes, never the plain ones", async () => {
    const { client, requests } = makeStub();
    const workspace = makeWorkspace(makeCtx(client), { id: "ws_1", name: "t", status: "ready" });

    await expect(workspace.exec(["id"], { user: "m4lice000" })).rejects.toBeDefined();
    await expect(workspace.sessions.open(["bash"], { user: "40001" })).rejects.toBeDefined();

    expect(requests).toEqual([
      {
        op: "exec-as-user",
        body: {
          ownerUserId: "usr_owner",
          commands: [{ executable: "id", args: [] }],
          user: "m4lice000",
        },
      },
      {
        op: "session-as-user",
        body: { workspaceId: "ws_1", ownerUserId: "usr_owner", argv: ["bash"], user: "40001" },
      },
    ]);
  });
});

describe("user against a control plane that does not report it", () => {
  it("is refused here, and nothing is sent", async () => {
    const { client, requests } = makeStub({ processUser: false });
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

describe("user against a control plane that reports only the old flag", () => {
  it("is never sent: `features.processUser: true` is not leave to send it", async () => {
    // An older control plane (or an older pod of a mixed fleet) that said `processUser: true`
    // would take `user` on the plain routes; this SDK never sends it there, nor anywhere else.
    const { client, requests } = makeStub({ processUser: true });
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

describe("the control plane's feature answer", () => {
  it("is asked again after a failed read, never kept for the client's life", async () => {
    vi.useFakeTimers();
    try {
      const { client, requests } = makeStub();
      let reads = 0;
      const flaky = {
        ...client,
        system: {
          getIndex: () => {
            reads += 1;
            return reads === 1
              ? Effect.fail(new Error("unreachable"))
              : (
                  client as unknown as { system: { getIndex: () => Effect.Effect<unknown> } }
                ).system.getIndex();
          },
        },
      } as unknown as ControlPlaneClient;
      const workspace = makeWorkspace(makeCtx(flaky), { id: "ws_1", name: "t", status: "ready" });

      await expect(workspace.exec(["id"], { user: "m4lice000" })).rejects.toMatchObject({
        code: "user-unsupported",
      });
      vi.setSystemTime(Date.now() + 20_000);
      await expect(workspace.exec(["id"], { user: "m4lice000" })).rejects.toBeDefined();
      expect(reads).toBe(2);
      expect(requests.map((request) => request.op)).toEqual(["exec-as-user"]);
    } finally {
      vi.useRealTimers();
    }
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

const withIndex = (features: unknown) =>
  ({
    system: {
      getIndex: () =>
        Effect.succeed({
          name: "Sealant Control Plane API",
          version: "0.0.0",
          docsPath: "/docs",
          openApiPath: "/openapi.json",
          ...(features === undefined ? {} : { features }),
        }),
    },
  }) as unknown as ControlPlaneClient;

const withDetails = (processUser: WorkspaceDetails["processUser"]) =>
  ({
    workspaces: {
      getWorkspace: () =>
        Effect.succeed({
          workspaceId: "ws_1",
          name: "t",
          ownerUserId: "usr_owner",
          status: "ready",
          ...(processUser === undefined ? {} : { processUser }),
          createdAt: "2026-10-06T00:00:00.000Z",
          updatedAt: "2026-10-06T00:00:00.000Z",
        } satisfies WorkspaceDetails),
    },
  }) as unknown as ControlPlaneClient;

describe("features()", () => {
  it("names every feature this control plane reports, and absent ones false", async () => {
    expect(
      await readFeatures(
        makeCtx(
          withIndex({
            processUser: false,
            processUserRoutes: true,
            dotfilesApply: true,
            credentialsPartialPut: true,
            credentialsPiOpencode: true,
            captureOwnerMap: true,
            workspaceSshUser: true,
            personBinding: true,
            sshKeyRemovalEndsConnections: true,
          }),
        ),
      ),
    ).toEqual({
      processUserRoutes: true,
      dotfilesApply: true,
      credentialsPartialPut: true,
      credentialsPiOpencode: true,
      captureOwnerMap: true,
      workspaceSshUser: true,
      personBinding: true,
      sshKeyRemovalEndsConnections: true,
    });
    // A control plane from before the as-user routes names only `processUser`, and its `true`
    // is not read as the routes.
    expect(await readFeatures(makeCtx(withIndex({ processUser: true })))).toEqual({
      processUserRoutes: false,
      dotfilesApply: false,
      credentialsPartialPut: false,
      credentialsPiOpencode: false,
      captureOwnerMap: false,
      workspaceSshUser: false,
      personBinding: false,
      sshKeyRemovalEndsConnections: false,
    });
    // One from before `features`: nothing.
    expect(Object.values(await readFeatures(makeCtx(withIndex(undefined))))).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it("rejects when the control plane could not be asked", async () => {
    const failing = {
      system: { getIndex: () => Effect.fail(new Error("unreachable")) },
    } as unknown as ControlPlaneClient;
    await expect(readFeatures(makeCtx(failing))).rejects.toBeDefined();
  });
});

describe("workspace.processUser()", () => {
  it("reads the workspace's own answer, and unknown from a control plane without one", async () => {
    for (const answer of ["supported", "unsupported", "unknown"] as const) {
      const workspace = makeWorkspace(makeCtx(withDetails(answer)), {
        id: "ws_1",
        name: "t",
        status: "ready",
      });
      expect(await workspace.processUser()).toBe(answer);
    }
    const older = makeWorkspace(makeCtx(withDetails(undefined)), {
      id: "ws_1",
      name: "t",
      status: "ready",
    });
    expect(await older.processUser()).toBe("unknown");
  });

  it("is filled in on the launch by ready()", async () => {
    const workspace = makeWorkspace(makeCtx(withDetails("supported")), {
      id: "ws_1",
      name: "t",
      status: "ready",
      launch: { replayed: false },
    });
    await workspace.ready();
    expect(workspace.launch?.processUser).toBe("supported");
  });
});
