/**
 * The workspace's lifetime surface: `runtimeDeadline()` maps the runtime's deadline (null where
 * there is none, or on a control plane that predates it), and a readiness timeout on a handle
 * `create()` made stops the workspace so no abandoned runtime keeps running to its cap. Driven
 * against a stub contract client (no live API).
 */
import type { WorkspaceDetails } from "@sealant/api-contracts";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { type ControlPlaneClient, SealantApiClient } from "./effect/api-client.js";
import type { SdkRuntime, SdkServices } from "./effect/runtime.js";
import type { SdkContext } from "./facade/context.js";
import { makeWorkspace, type WorkspaceInit } from "./facade/workspace.js";
import { resolveInternalConfig } from "./internal/config.js";

const details = (overrides: Partial<WorkspaceDetails> = {}): WorkspaceDetails => ({
  workspaceId: "ws_1",
  name: "t",
  ownerUserId: "local",
  status: "running",
  createdAt: "2026-09-27T10:00:00.000Z",
  updatedAt: "2026-09-27T10:00:00.000Z",
  ...overrides,
});

// The derived `ControlPlaneClient` surface is far wider; the narrowing cast is test-only.
const makeStub = (read: () => WorkspaceDetails) => {
  const stops: unknown[] = [];
  const workspaces = {
    getWorkspace: () => Effect.sync(read),
    stopWorkspace: (request: unknown) => {
      stops.push(request);
      return Effect.succeed({ workspaceId: "ws_1", status: "stopped" });
    },
  };
  return { client: { workspaces } as unknown as ControlPlaneClient, stops };
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
  config: resolveInternalConfig({ baseUrl: "http://stub.invalid" }),
});

const workspaceFor = (client: ControlPlaneClient, init: Partial<WorkspaceInit> = {}) =>
  makeWorkspace(makeCtx(client), { id: "ws_1", name: "t", status: "queued", ...init });

const RUNTIME = {
  adapter: "microvm" as const,
  resourceId: "microvm-1",
  reference: "microvm-1",
  status: "ready" as const,
};

describe("workspace.runtimeDeadline()", () => {
  it("returns the runtime's deadline", async () => {
    const { client } = makeStub(() =>
      details({ runtime: { ...RUNTIME, deadline: "2026-09-27T11:00:00.000Z" } }),
    );
    await expect(workspaceFor(client).runtimeDeadline()).resolves.toBe("2026-09-27T11:00:00.000Z");
  });

  it("is null for a runtime with no lifetime, an older control plane, or no runtime yet", async () => {
    const none = makeStub(() => details({ runtime: { ...RUNTIME, deadline: null } }));
    const older = makeStub(() => details({ runtime: RUNTIME }));
    const unlaunched = makeStub(() => details());
    await expect(workspaceFor(none.client).runtimeDeadline()).resolves.toBeNull();
    await expect(workspaceFor(older.client).runtimeDeadline()).resolves.toBeNull();
    await expect(workspaceFor(unlaunched.client).runtimeDeadline()).resolves.toBeNull();
  });
});

describe("workspace.ready() timeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const timeOut = async (init: Partial<WorkspaceInit>) => {
    vi.useFakeTimers();
    const stub = makeStub(() => details({ status: "running" }));
    const outcome = workspaceFor(stub.client, init)
      .ready()
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    await vi.advanceTimersByTimeAsync(11 * 60 * 1_000);
    return { error: await outcome, stops: stub.stops };
  };

  it("stops a workspace this handle created before throwing", async () => {
    const { error, stops } = await timeOut({ created: true });
    expect(error).toMatchObject({
      code: "workspace_ready_timeout",
      message: expect.stringContaining("The workspace was stopped."),
    });
    expect(stops).toEqual([
      { params: { workspaceId: "ws_1" }, payload: { ownerUserId: expect.any(String) } },
    ]);
  });

  it("leaves a workspace it did not create alone", async () => {
    const { error, stops } = await timeOut({});
    expect(error).toMatchObject({ code: "workspace_ready_timeout" });
    expect(stops).toEqual([]);
  });
});
