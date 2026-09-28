/**
 * The workspace's lifetime surface: `runtimeDeadline()` maps the runtime's deadline (null where
 * there is none, or on a control plane that predates it); a readiness timeout on a handle
 * `create()` made requests a stop (and says only that); and `stop()` reports only what the
 * control plane observed. Driven against a stub contract client (no live API).
 */
import type { WorkspaceCaptureStatus, WorkspaceDetails } from "@sealant/api-contracts";
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
const makeStub = (
  read: () => WorkspaceDetails,
  capture?: () => WorkspaceCaptureStatus | undefined,
) => {
  const stops: unknown[] = [];
  const recovers: unknown[] = [];
  const workspaces = {
    getWorkspace: () => Effect.sync(read),
    getWorkspaceCaptureStatus: () =>
      Effect.suspend(() => {
        const status = capture?.();
        return status === undefined
          ? Effect.fail(new Error("not a capture-sourced workspace"))
          : Effect.succeed(status);
      }),
    stopWorkspace: (request: { payload: { completion?: { executorId: string } } }) => {
      stops.push(request);
      const completion = request.payload.completion;
      return Effect.succeed({
        workspaceId: "ws_1",
        status: "stopped",
        ...(completion === undefined
          ? {}
          : {
              completion:
                completion.executorId === "microvm-1"
                  ? { outcome: "accepted" }
                  : { outcome: "ignored", detail: "names another executor" },
            }),
      });
    },
    recoverWorkspace: (request: unknown) => {
      recovers.push(request);
      return Effect.succeed({ workspaceId: "ws_1", state: "requested", recoverable: true });
    },
  };
  return { client: { workspaces } as unknown as ControlPlaneClient, stops, recovers };
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

  it("requests a stop of a workspace this handle created before throwing, and says only that", async () => {
    const { error, stops } = await timeOut({ created: true });
    expect(error).toMatchObject({
      code: "workspace_ready_timeout",
      message: expect.stringContaining("A stop was requested"),
    });
    // An accepted request is not a stop: the message never claims one.
    expect(error).not.toMatchObject({ message: expect.stringMatching(/was stopped/) });
    expect(stops).toEqual([
      { params: { workspaceId: "ws_1" }, payload: { ownerUserId: expect.any(String) } },
    ]);
  });

  it("fails at once on a retained workspace: its executor ended and is kept for recovery", async () => {
    const stub = makeStub(() => details({ status: "retained" }));
    await expect(workspaceFor(stub.client).ready()).rejects.toMatchObject({
      code: "workspace_not_ready",
      message: expect.stringContaining('"retained"'),
    });
  });

  it("leaves a workspace it did not create alone", async () => {
    const { error, stops } = await timeOut({});
    expect(error).toMatchObject({ code: "workspace_ready_timeout" });
    expect(stops).toEqual([]);
  });
});

describe("workspace.stop()", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const CAPTURE: WorkspaceCaptureStatus = {
    epoch: 1,
    worktreeId: "wt_1",
    pending: 12,
    stagedBytes: 4096,
    uploadedObjects: 3,
    uploadedBytes: 2048,
    registered: 30,
    fenced: false,
    paused: false,
    refused: [],
  };

  const stopWith = async (stub: ReturnType<typeof makeStub>) => {
    vi.useFakeTimers();
    const outcome = workspaceFor(stub.client)
      .stop()
      .then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
    await vi.advanceTimersByTimeAsync(61_000);
    return outcome;
  };

  it("resolves stopped once the runtime is gone", async () => {
    let reads = 0;
    const stub = makeStub(() => details({ status: (reads += 1) < 3 ? "ready" : "stopped" }));
    await expect(stopWith(stub)).resolves.toEqual({ result: { state: "stopped" } });
    expect(stub.stops).toHaveLength(1);
  });

  it("does not call a reachable capture queue a drain: stop requested", async () => {
    // The daemon answering capture.status says nothing about whether the server is draining (a
    // refused or abandoned drain answers too).
    const stub = makeStub(
      () => details({ status: "ready" }),
      () => CAPTURE,
    );
    await expect(stopWith(stub)).resolves.toEqual({
      result: { state: "requested", capture: { ...CAPTURE } },
    });
  });

  it("reports draining only when the control plane observed the drain moving", async () => {
    const drain = {
      state: "draining" as const,
      detail: "pending 12 · staged 4096 bytes",
      observedAt: "2026-09-27T10:00:30.000Z",
    };
    const stub = makeStub(
      () => details({ status: "ready", captureDrain: drain }),
      () => CAPTURE,
    );
    await expect(stopWith(stub)).resolves.toEqual({
      result: { state: "draining", drain, capture: { ...CAPTURE } },
    });
  });

  it("reports kept when the control plane will not remove the runtime", async () => {
    const drain = {
      state: "kept" as const,
      detail:
        "not saved · not confirmed · the daemon reports its final flush incomplete (ship-failed)",
    };
    const stub = makeStub(() => details({ status: "ready", captureDrain: drain }));
    await expect(stopWith(stub)).resolves.toEqual({ result: { state: "kept", drain } });
  });

  it("names the executor a kept drain is about, as the id a completion attestation uses", async () => {
    const stub = makeStub(() =>
      details({
        status: "ready",
        captureDrain: {
          state: "kept",
          detail: "not saved · retained · executor exited",
          executor: {
            runId: "run_1",
            adapter: "docker",
            resourceId: "container-1",
            reference: "sealant-run_1",
          },
        },
      }),
    );
    await expect(stopWith(stub)).resolves.toMatchObject({
      result: {
        state: "kept",
        drain: {
          executor: {
            runId: "run_1",
            kind: "docker",
            resourceId: "container-1",
            reference: "sealant-run_1",
          },
        },
      },
    });
  });

  it("reports a retained executor kept at once, without waiting out the stop (e2e 5)", async () => {
    // The executor ended with work not confirmed saved: the control plane keeps it for recovery
    // and this stop does not remove it. `retained` is what was observed; nothing is waited for.
    const drain = {
      state: "kept" as const,
      detail: "not saved · retained · executor exited",
      retained: {
        since: "2026-09-27T10:00:00.000Z",
        reason: "executor exited",
        recoverable: true,
        recoveryAttempts: 0,
      },
    };
    const stub = makeStub(() => details({ status: "retained", captureDrain: drain }));
    vi.useFakeTimers();
    const result = await workspaceFor(stub.client).stop();
    expect(result).toMatchObject({ state: "kept", drain: { retained: { recoverable: true } } });
  });

  it("reports the stop requested, never stopped, while termination is not observed", async () => {
    const saved = { state: "saved" as const, detail: "final flush complete" };
    const stub = makeStub(() => details({ status: "ready", captureDrain: saved }));
    await expect(stopWith(stub)).resolves.toEqual({
      result: { state: "requested", drain: saved },
    });
    const plain = makeStub(() => details({ status: "ready" }));
    await expect(stopWith(plain)).resolves.toEqual({ result: { state: "requested" } });
  });

  it("asks the control plane to discard unsaved captures only when told to, and reports what it did", async () => {
    const discarded = {
      state: "discarded" as const,
      detail: "unsaved captures discarded at the owner's request",
      discard: { requestedBy: "local", requestedAt: "2026-09-27T12:00:00.000Z" },
    };
    let reads = 0;
    const stub = makeStub(() =>
      (reads += 1) < 3
        ? details({ status: "ready", captureDrain: discarded })
        : details({ status: "stopped", captureDrain: discarded }),
    );
    vi.useFakeTimers();
    const outcome = workspaceFor(stub.client).stop({ discardUnsaved: true });
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(outcome).resolves.toEqual({ state: "stopped" });
    expect(stub.stops).toEqual([
      {
        params: { workspaceId: "ws_1" },
        payload: { ownerUserId: expect.any(String), discardUnsaved: true },
      },
    ]);

    const plain = makeStub(() => details({ status: "stopped" }));
    await workspaceFor(plain.client).stop();
    expect(plain.stops).toEqual([
      { params: { workspaceId: "ws_1" }, payload: { ownerUserId: expect.any(String) } },
    ]);
  });
});

describe("workspace.stop({ completion }) and workspace.recover()", () => {
  it("sends the completion attestation and reports whether the control plane accepted it", async () => {
    const stub = makeStub(() => details({ status: "stopped" }));
    await expect(
      workspaceFor(stub.client).stop({
        completion: { captureN: 41, epoch: 3, executorId: "microvm-1" },
      }),
    ).resolves.toEqual({ state: "stopped", completion: { outcome: "accepted" } });
    expect(stub.stops).toEqual([
      {
        params: { workspaceId: "ws_1" },
        payload: {
          ownerUserId: expect.any(String),
          completion: { captureN: 41, epoch: 3, executorId: "microvm-1" },
        },
      },
    ]);
    await expect(
      workspaceFor(stub.client).stop({ completion: { captureN: 1, epoch: 1, executorId: "x" } }),
    ).resolves.toEqual({
      state: "stopped",
      completion: { outcome: "ignored", detail: "names another executor" },
    });
  });

  it("names the launch the seal is about (decision 5)", async () => {
    const stub = makeStub(() => details({ status: "stopped" }));
    await workspaceFor(stub.client).stop({
      completion: { captureN: 41, epoch: 3, executorId: "microvm-1", launchId: "launch_1" },
    });
    expect(stub.stops).toEqual([
      {
        params: { workspaceId: "ws_1" },
        payload: {
          ownerUserId: expect.any(String),
          completion: { captureN: 41, epoch: 3, executorId: "microvm-1", launchId: "launch_1" },
        },
      },
    ]);
  });

  it("captureDrain() reads the drain and retention without stopping anything", async () => {
    const drain = {
      state: "kept" as const,
      detail: "not saved · retained · executor exited",
      observedAt: "2026-09-27T10:00:30.000Z",
      preservationStartsAt: "2026-09-27T10:05:00.000Z",
      discard: { requestedBy: "user_owner", requestedAt: "2026-09-27T10:01:00.000Z" },
      retained: {
        since: "2026-09-27T10:00:00.000Z",
        reason: "executor exited",
        recoverable: true,
        recoveryAttempts: 2,
        nextRecoveryAt: "2026-09-27T10:00:40.000Z",
        lastRecoveryError: "exited 75",
      },
      executor: {
        runId: "run_1",
        adapter: "docker",
        resourceId: "container-1",
        reference: "sealant-run_1",
        launchId: "launch-1",
      },
      completion: {
        executorId: "container-1",
        epoch: 3,
        captureN: 41,
        attestedAt: "2026-09-27T10:02:00.000Z",
        launchId: "launch-1",
      },
    };
    const stub = makeStub(() => details({ status: "retained", captureDrain: drain }));
    expect(await workspaceFor(stub.client).captureDrain()).toEqual({
      ...drain,
      executor: {
        runId: "run_1",
        kind: "docker",
        resourceId: "container-1",
        reference: "sealant-run_1",
        launchId: "launch-1",
      },
    });
    expect(stub.stops).toEqual([]);

    const none = makeStub(() => details({ status: "ready" }));
    expect(await workspaceFor(none.client).captureDrain()).toBeNull();
  });

  it("asks the control plane to recover the retained executor", async () => {
    const stub = makeStub(() => details({ status: "stopped" }));
    await expect(workspaceFor(stub.client).recover()).resolves.toEqual({
      state: "requested",
      recoverable: true,
    });
    expect(stub.recovers).toEqual([
      { params: { workspaceId: "ws_1" }, payload: { ownerUserId: expect.any(String) } },
    ]);
  });
});
