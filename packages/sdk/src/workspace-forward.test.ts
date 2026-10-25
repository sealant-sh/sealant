import { Effect } from "effect";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import type { SdkRuntime } from "./effect/runtime.js";
import type { SdkContext } from "./facade/context.js";
import { makeWorkspace } from "./facade/workspace.js";
import { resolveInternalConfig } from "./internal/config.js";
import type { BoundedWorkspaceForward, WorkspaceForward } from "./types.js";

const ctx: SdkContext = {
  runtime: {
    run: () => Effect.runPromise(Effect.die("no control-plane call is expected")),
    dispose: () => Promise.resolve(),
  } satisfies SdkRuntime,
  config: resolveInternalConfig({
    baseUrl: "http://stub.invalid",
    apiKey: "slt_key",
    ownerUserId: "usr_owner",
  }),
};

const opened: Array<{ readonly url: string; readonly protocols: unknown }> = [];

class RecordingWebSocket extends EventTarget {
  binaryType = "blob";
  constructor(url: URL | string, protocols?: string | string[]) {
    super();
    opened.push({ url: String(url), protocols });
  }
  close() {}
}

afterEach(() => {
  opened.length = 0;
  vi.unstubAllGlobals();
});

describe("workspace.forward", () => {
  it("opens the bounded forward on /forward/v2 with its subprotocol", () => {
    vi.stubGlobal("WebSocket", RecordingWebSocket);
    const workspace = makeWorkspace(ctx, { id: "ws_1", name: "t", status: "ready" });

    const bounded = workspace.forward(3000, { flow: "bounded", host: "docker" });
    const legacy = workspace.forward(3000, { host: "docker" });
    expectTypeOf(bounded).resolves.toEqualTypeOf<BoundedWorkspaceForward>();
    expectTypeOf(legacy).resolves.toEqualTypeOf<WorkspaceForward>();

    expect(opened.map(({ url, protocols }) => [new URL(url).pathname, protocols])).toEqual([
      ["/v1/workspaces/ws_1/forward/v2", "sealant.forward.v2"],
      ["/v1/workspaces/ws_1/forward", undefined],
    ]);
    expect(new URL(opened[0]?.url ?? "").searchParams.get("host")).toBe("docker");
  });
});

describe("a bounded forward bound to a session", () => {
  it("asks Core for the session on the workspace's loopback", () => {
    vi.stubGlobal("WebSocket", RecordingWebSocket);
    const workspace = makeWorkspace(ctx, { id: "ws_1", name: "t", status: "ready" });

    void workspace.forward(3000, { flow: "bounded", session: "ses_1" });

    const url = new URL(opened[0]?.url ?? "");
    expect(url.searchParams.get("session")).toBe("ses_1");
    expect(url.searchParams.get("host")).toBe("127.0.0.1");
  });

  it("is a type error toward the Docker sidecar, also from an options object", () => {
    vi.stubGlobal("WebSocket", RecordingWebSocket);
    const workspace = makeWorkspace(ctx, { id: "ws_1", name: "t", status: "ready" });
    const toDocker = { flow: "bounded", host: "docker", session: "ses_1" } as const;

    // @ts-expect-error: a bound forward reaches the workspace's loopback only
    void workspace.forward(5432, toDocker).catch(() => {});
  });

  it("is refused without flow: bounded, as a type error and when JavaScript asks anyway", async () => {
    vi.stubGlobal("WebSocket", RecordingWebSocket);
    const workspace = makeWorkspace(ctx, { id: "ws_1", name: "t", status: "ready" });
    const unbounded = { host: "127.0.0.1", session: "ses_1" } as const;

    // @ts-expect-error: only a bounded forward can be bound to a session
    const opening = workspace.forward(3000, unbounded);

    await expect(opening).rejects.toMatchObject({ code: "invalid_options" });
    expect(opened).toEqual([]);
  });
});
