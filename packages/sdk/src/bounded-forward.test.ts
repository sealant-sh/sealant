import { afterEach, describe, expect, it, vi } from "vitest";

import { ForwardResetError } from "./errors.js";
import { openForwardV2 } from "./facade/forward.js";

const FRAME = 64 * 1024;
const WINDOW = 256 * 1024;

type Sent = { readonly text: unknown } | { readonly bytes: number };

class ScriptedCore extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static latest: ScriptedCore | undefined;

  binaryType = "blob";
  protocol = "sealant.forward.v2";
  readyState = ScriptedCore.CONNECTING;
  bufferedAmount = 0;
  readonly sent: Sent[] = [];

  constructor() {
    super();
    ScriptedCore.latest = this;
    queueMicrotask(() => {
      this.readyState = ScriptedCore.OPEN;
      this.dispatchEvent(new Event("open"));
    });
  }

  send(data: string | ArrayBufferLike | ArrayBufferView) {
    if (typeof data === "string") this.sent.push({ text: JSON.parse(data) });
    else this.sent.push({ bytes: data.byteLength });
  }

  close() {
    if (this.readyState === ScriptedCore.CLOSED) return;
    this.readyState = ScriptedCore.CLOSED;
    queueMicrotask(() => this.dispatchEvent(new Event("close")));
  }

  text(frame: object) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) }));
  }

  data(bytes: number) {
    this.dispatchEvent(new MessageEvent("message", { data: new ArrayBuffer(bytes) }));
  }

  progress(bytes: number, frames: number) {
    this.text({ t: "progress", bytes: String(bytes), frames: String(frames) });
  }

  texts() {
    return this.sent.flatMap((frame) => ("text" in frame ? [frame.text] : []));
  }

  bytesSent() {
    return this.sent.reduce((sum, frame) => sum + ("bytes" in frame ? frame.bytes : 0), 0);
  }
}

const ENDPOINT = { baseUrl: "http://core.invalid", apiKey: "slt_key", ownerUserId: "usr_owner" };

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const settled = async (promise: Promise<unknown>) => {
  let state = "pending";
  promise.then(
    () => (state = "fulfilled"),
    () => (state = "rejected"),
  );
  await tick();
  return state;
};

const opened = async (options: { readonly openWindow?: boolean } = {}) => {
  vi.stubGlobal("WebSocket", ScriptedCore);
  const opening = openForwardV2(ENDPOINT, "wks_1", 3000);
  await tick();
  const core = ScriptedCore.latest;
  if (core === undefined) throw new Error("no socket opened");
  core.text({ t: "ready", version: 2, binding: { kind: "port" } });
  if (options.openWindow !== false) core.progress(0, 0);
  return { core, opening };
};

const open = async () => {
  const { core, opening } = await opened();
  return { core, forward: await opening };
};

afterEach(() => {
  vi.unstubAllGlobals();
  ScriptedCore.latest = undefined;
});

describe("a bounded forward's writable", () => {
  it("fails once Core resets the forward, while no write is waiting", async () => {
    const { core, forward } = await open();
    const writer = forward.writable.getWriter();
    await writer.ready;

    core.text({ t: "reset", reason: "runtime-lost" });

    await expect(forward.closed).resolves.toEqual({ kind: "reset", reason: "runtime-lost" });
    await expect(writer.ready).rejects.toBeInstanceOf(ForwardResetError);
    await expect(writer.closed).rejects.toMatchObject({ reason: "runtime-lost" });
    await expect(writer.close()).rejects.toThrow();
  });

  it("reports a reset when the workspace ends before Core took what was written", async () => {
    const { core, forward } = await open();
    const writer = forward.writable.getWriter();
    await writer.write(new Uint8Array(3));
    core.data(5);

    core.text({ t: "fin", bytes: "5", frames: "1" });

    await expect(forward.closed).resolves.toEqual({ kind: "reset", reason: "workspace-ended" });
    await expect(writer.closed).rejects.toMatchObject({ reason: "workspace-ended" });
    const reader = forward.readable.getReader();
    await expect(reader.read()).resolves.toMatchObject({ done: false });
    await expect(reader.read()).resolves.toMatchObject({ done: true });
  });

  it("ends cleanly when the workspace ends after Core took everything written", async () => {
    const { core, forward } = await open();
    const writer = forward.writable.getWriter();
    await writer.write(new Uint8Array(3));
    core.progress(3, 1);

    core.text({ t: "fin", bytes: "0", frames: "0" });

    await expect(forward.closed).resolves.toEqual({ kind: "end" });
    await expect(writer.close()).resolves.toBeUndefined();
  });

  it("releases a write waiting for credit when the writer aborts", async () => {
    const { core, forward } = await open();
    const writer = forward.writable.getWriter();
    for (let frame = 0; frame < 4; frame++) writer.write(new Uint8Array(FRAME)).catch(() => {});
    const stalled = writer.write(new Uint8Array(FRAME));
    stalled.catch(() => {});
    await tick();
    expect(core.bytesSent()).toBe(WINDOW);

    await expect(writer.abort(new Error("gave up"))).resolves.toBeUndefined();
    await expect(stalled).rejects.toThrow("gave up");
    await expect(forward.closed).resolves.toEqual({ kind: "reset", reason: "aborted" });
    expect(core.texts().at(-1)).toEqual({ t: "reset", reason: "aborted" });
  });

  it("releases a write waiting for credit when the forward is closed", async () => {
    const { forward } = await open();
    const writer = forward.writable.getWriter();
    for (let frame = 0; frame < 4; frame++) writer.write(new Uint8Array(FRAME)).catch(() => {});
    const stalled = writer.write(new Uint8Array(FRAME));

    forward.close();

    await expect(stalled).rejects.toBeInstanceOf(ForwardResetError);
    await expect(forward.closed).resolves.toEqual({ kind: "reset", reason: "aborted" });
  });

  it("is ready only while Core has granted credit", async () => {
    const { core, opening } = await opened({ openWindow: false });
    expect(await settled(opening)).toBe("pending");
    core.progress(0, 0);
    const forward = await opening;
    const writer = forward.writable.getWriter();
    expect(await settled(writer.ready)).toBe("fulfilled");

    for (let frame = 0; frame < 4; frame++) {
      await writer.ready;
      writer.write(new Uint8Array(FRAME)).catch(() => {});
    }
    await tick();
    expect(writer.desiredSize).toBe(0);
    expect(await settled(writer.ready)).toBe("pending");

    core.progress(WINDOW, 4);
    expect(await settled(writer.ready)).toBe("fulfilled");
  });

  it("pulls nothing from a source while Core grants no credit", async () => {
    const { core, forward } = await open();
    let pulls = 0;
    const source = new ReadableStream<Uint8Array>({
      pull: (controller) => {
        pulls += 1;
        controller.enqueue(new Uint8Array(FRAME));
      },
    });
    void source.pipeTo(forward.writable).catch(() => {});
    await tick();
    await tick();
    const pulledAtStall = pulls;
    expect(core.bytesSent()).toBe(WINDOW);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(pulls).toBe(pulledAtStall);
    expect(pulls).toBeLessThanOrEqual(WINDOW / FRAME + 1);
  });
});

describe("a bounded forward's acknowledgements", () => {
  it("holds a progress while its socket is backed up, and sends the latest once it drains", async () => {
    const { core, forward } = await open();
    const reader = forward.readable.getReader();
    core.bufferedAmount = 1024 * 1024;
    for (let frame = 0; frame < 32; frame++) core.data(1);
    for (let frame = 0; frame < 32; frame++) await reader.read();
    const progressSent = () =>
      core.texts().filter((text) => (text as { t?: string }).t === "progress").length;
    expect(progressSent()).toBe(1);

    core.bufferedAmount = 0;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(core.texts().at(-1)).toEqual({ t: "progress", bytes: "32", frames: "32" });
    expect(progressSent()).toBe(2);
  });
});
