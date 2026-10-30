import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { connect, type Socket } from "node:net";
import { Duplex } from "node:stream";

import { NOT_A_PERSON, RESOURCE_DOMAIN_ID_PREFIX } from "@sealant/api-contracts";
import {
  AccessTokenRepo,
  WorkspaceRepo,
  WorkspaceRuntimeInstanceRepo,
  WorkspaceSessionRepo,
} from "@sealant/db";
import { ForwardDialError, SealantApiError } from "@sealant/sdk";
import { openForwardV2 } from "@sealant/sdk/internal/forward";
import {
  SealantControlError,
  SealantForwardBindingUnsupported,
  type SealantError,
  type SealantForwardChannel,
  type SealantForwardConnection,
  type SealantForwardConnectionOptions,
  SealantRuntime,
  SealantRuntimeLive,
  type SealantTarget,
  SealantTransport,
  TransportError,
} from "@sealant/workspaces";
import { Effect, Layer } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  asForwardService,
  eventually,
  FORWARD_SERVICE_KEY,
  serveForwardRoutes,
  type ServedCore,
} from "./forward-v2.fixture.js";

const SERVICE_KEY = FORWARD_SERVICE_KEY;
const DOMAIN = `${RESOURCE_DOMAIN_ID_PREFIX}6f1c2a7e-3b4d-4e5f-8a9b-0c1d2e3f4a5b`;

const OWNER = "usr_forward";
const TOKEN_WITHOUT_EXEC = "slt_token_without_workspace_exec";
const ECHO_PORT = 7000;
const SLOW_DIAL_PORT = 7010;
const STALLED_PORT = 7020;
const FLOOD_PORT = 7021;
const FAILING_PORT = 7022;
const BROKEN_PUMP_PORT = 7023;
const ENDS_AFTER_UPLOAD_PORT = 7024;
const FLOOD_BYTES = 1024 * 1024;
const DAEMON_WITHOUT_BINDING_PORT = 7030;
const RUNTIME_THAT_DROPS_THE_ECHO_PORT = 7031;

const DAEMON_FAILURES: Record<number, () => SealantControlError> = {
  7001: () => controlError({ reason: "connection-refused" }),
  7002: () => controlError({ reason: "name-unresolved" }),
  7003: () => controlError({ reason: "network-unreachable" }),
  7004: () => controlError({ reason: "dial-timeout" }),
  7005: () => controlError(undefined),
  7006: () => controlError({ reason: "a-cause-this-core-has-never-heard-of" }),
  7007: () => controlError({ reason: "owner-exited" }),
  7008: () => controlError({ reason: "peer-mismatch" }),
  7009: () => controlError({ reason: "binding-unverifiable" }),
};

function controlError(detail: object | undefined) {
  return new SealantControlError({
    operation: "openForward",
    code: 13,
    message: "forward connect failed",
    ...(detail === undefined ? {} : { detailJson: JSON.stringify(detail) }),
  });
}

const echoChannel = (): SealantForwardChannel => {
  const queued: Uint8Array[] = [];
  let ended = false;
  let wake: (() => void) | undefined;
  const closed = Promise.withResolvers<Awaited<SealantForwardChannel["closed"]>>();
  return {
    write: (data) => {
      queued.push(new Uint8Array(data));
      wake?.();
      return true;
    },
    drained: () => Promise.resolve(),
    get isOutboundClosed() {
      return ended;
    },
    end: () => {
      ended = true;
      wake?.();
    },
    destroy: () => closed.resolve({ kind: "local" }),
    closed: closed.promise,
    async *[Symbol.asyncIterator]() {
      for (;;) {
        const next = queued.shift();
        if (next !== undefined) yield next;
        else if (ended) return closed.resolve({ kind: "remote", end: {} });
        else await new Promise<void>((resolve) => (wake = resolve));
      }
    },
  };
};

const stalledChannel = (): SealantForwardChannel => {
  const closed = Promise.withResolvers<Awaited<SealantForwardChannel["closed"]>>();
  return {
    write: () => false,
    isOutboundClosed: false,
    drained: () => new Promise(() => {}),
    end: () => {},
    destroy: () => closed.resolve({ kind: "local" }),
    closed: closed.promise,
    [Symbol.asyncIterator]: () => ({
      next: () => closed.promise.then(() => ({ done: true, value: undefined })),
    }),
  };
};

const floodChannel = (): SealantForwardChannel => {
  const closed = Promise.withResolvers<Awaited<SealantForwardChannel["closed"]>>();
  return {
    write: () => true,
    isOutboundClosed: false,
    drained: () => Promise.resolve(),
    end: () => {},
    destroy: () => closed.resolve({ kind: "local" }),
    closed: closed.promise,
    async *[Symbol.asyncIterator]() {
      yield new Uint8Array(FLOOD_BYTES);
      await closed.promise;
    },
  };
};

let failFloodedChannel: (() => void) | undefined;

const floodThenFailChannel = (): SealantForwardChannel => {
  const closed = Promise.withResolvers<Awaited<SealantForwardChannel["closed"]>>();
  failFloodedChannel = () => closed.resolve({ kind: "error", error: new Error("daemon gone") });
  return {
    write: () => true,
    isOutboundClosed: false,
    drained: () => Promise.resolve(),
    end: () => {},
    destroy: () => closed.resolve({ kind: "local" }),
    closed: closed.promise,
    async *[Symbol.asyncIterator]() {
      yield new Uint8Array(FLOOD_BYTES);
      await closed.promise;
    },
  };
};

const brokenPumpChannel = (): SealantForwardChannel => {
  const closed = Promise.withResolvers<Awaited<SealantForwardChannel["closed"]>>();
  return {
    write: () => true,
    isOutboundClosed: false,
    drained: () => Promise.resolve(),
    end: () => {},
    destroy: () => closed.resolve({ kind: "local" }),
    closed: closed.promise,
    [Symbol.asyncIterator]: () => ({
      next: () => Promise.reject(new Error("the channel broke")),
    }),
  };
};

const endsAfterUploadChannel = (): SealantForwardChannel => {
  const closed = Promise.withResolvers<Awaited<SealantForwardChannel["closed"]>>();
  let ended = false;
  return {
    write: () => {
      ended = true;
      setTimeout(() => closed.resolve({ kind: "remote", end: {} }), 10);
      return true;
    },
    get isOutboundClosed() {
      return ended;
    },
    drained: () => Promise.resolve(),
    end: () => {},
    destroy: () => closed.resolve({ kind: "local" }),
    closed: closed.promise,
    [Symbol.asyncIterator]: () => ({
      next: () => closed.promise.then(() => ({ done: true, value: undefined })),
    }),
  };
};

const runtimeLosingItsConnection = Effect.runSync(
  Effect.gen(function* () {
    return yield* SealantRuntime;
  }).pipe(
    Effect.provide(
      SealantRuntimeLive.pipe(
        Layer.provide(
          Layer.succeed(SealantTransport, {
            open: () =>
              Effect.sync(
                () =>
                  new Duplex({
                    read() {},
                    write(_chunk, _encoding, callback) {
                      callback();
                      setImmediate(() => this.destroy());
                    },
                  }),
              ),
          }),
        ),
      ),
    ),
  ),
);

const sessions: Record<
  string,
  {
    readonly workspaceId: string;
    readonly ownerUserId: string;
    readonly status: string;
    readonly daemonSessionId: string | null;
  }
> = {
  ses_serving: {
    workspaceId: "wks_ready",
    ownerUserId: OWNER,
    status: "running",
    daemonSessionId: "sess_serving",
  },
  ses_exited: {
    workspaceId: "wks_ready",
    ownerUserId: OWNER,
    status: "exited",
    daemonSessionId: "sess_exited",
  },
  ses_elsewhere: {
    workspaceId: "wks_idle",
    ownerUserId: OWNER,
    status: "running",
    daemonSessionId: "sess_elsewhere",
  },
  ses_theirs: {
    workspaceId: "wks_ready",
    ownerUserId: "usr_someone_else",
    status: "running",
    daemonSessionId: "sess_theirs",
  },
  ses_starting: {
    workspaceId: "wks_ready",
    ownerUserId: OWNER,
    status: "starting",
    daemonSessionId: null,
  },
  ses_on_old_daemon: {
    workspaceId: "wks_old_daemon",
    ownerUserId: OWNER,
    status: "running",
    daemonSessionId: "sess_on_old_daemon",
  },
};

const capabilitiesAsked: string[] = [];

const ownerSessionsAsked: Array<string | undefined> = [];

let daemonConnects = 0;
let daemonReleases = 0;
let dialsStarted = 0;
let releaseSlowLookup: (() => void) | undefined;
let slowLookupsStarted = 0;

const workspaces: Record<
  string,
  { readonly ownerUserId: string; readonly latestRunId: string | null }
> = {
  wks_ready: { ownerUserId: OWNER, latestRunId: "run_ready" },
  wks_old_daemon: { ownerUserId: OWNER, latestRunId: "run_old_daemon" },
  wks_slow: { ownerUserId: OWNER, latestRunId: "run_ready" },
  wks_idle: { ownerUserId: OWNER, latestRunId: null },
  wks_k8s: { ownerUserId: OWNER, latestRunId: "run_k8s" },
  wks_down: { ownerUserId: OWNER, latestRunId: "run_down" },
  wks_lost: { ownerUserId: OWNER, latestRunId: "run_lost" },
  wks_theirs: { ownerUserId: "usr_someone_else", latestRunId: "run_ready" },
};

const slowLookup = Effect.promise(
  () =>
    new Promise<void>((resolve) => {
      slowLookupsStarted += 1;
      releaseSlowLookup = resolve;
    }),
);

const fakes = Layer.mergeAll(
  Layer.succeed(WorkspaceRepo, {
    getWorkspaceById: (id: string) =>
      id === "wks_broken"
        ? Effect.fail(new Error("connection terminated"))
        : (id === "wks_slow" ? slowLookup : Effect.void).pipe(
            Effect.as(workspaces[id] === undefined ? undefined : { id, ...workspaces[id] }),
          ),
  } as never),
  Layer.succeed(WorkspaceRuntimeInstanceRepo, {
    getRuntimeInstanceByRunId: (runId: string) =>
      Effect.succeed({
        runId,
        status: "ready",
        adapter: runId === "run_k8s" ? "k8s" : "docker",
        resourceId: runId.replace("run_", "ctr_"),
        reference: "ctr",
        endpoint: null,
      }),
  } as never),
  Layer.succeed(AccessTokenRepo, {
    getTokenByHash: (hash: string) =>
      Effect.succeed(
        hash === createHash("sha256").update(TOKEN_WITHOUT_EXEC).digest("hex")
          ? {
              ownerUserId: OWNER,
              workspaceId: null,
              scopes: ["session:read"],
              revokedAt: null,
              expiresAt: null,
            }
          : undefined,
      ),
  } as never),
  Layer.succeed(WorkspaceSessionRepo, {
    getSessionById: (id: string) =>
      id === "ses_broken"
        ? Effect.fail(new Error("connection terminated"))
        : Effect.succeed(sessions[id] === undefined ? undefined : { id, ...sessions[id] }),
  } as never),
  Layer.succeed(SealantRuntime, {
    connect: (target: SealantTarget) =>
      Effect.succeed({
        openForward: (port: number) =>
          Effect.fail(DAEMON_FAILURES[port]?.() ?? controlError(undefined)),
        capabilities: Effect.sync(() => {
          const containerId = target.kind === "docker-exec" ? target.containerId : "";
          capabilitiesAsked.push(containerId);
          return { supports: containerId === "ctr_old_daemon" ? [] : ["forward.owner"] };
        }),
      }),
    openForwardConnection: (target: SealantTarget, options: SealantForwardConnectionOptions) => {
      const containerId = target.kind === "docker-exec" ? target.containerId : undefined;
      if (containerId === "ctr_lost") {
        return runtimeLosingItsConnection.openForwardConnection(target, options);
      }
      if (containerId === "ctr_down") {
        return Effect.fail(
          new TransportError({ operation: "open", message: "no such container", cause: null }),
        );
      }
      ownerSessionsAsked.push(options.ownerSessionId);
      const opened = (
        channel: SealantForwardChannel,
      ): Effect.Effect<SealantForwardConnection, SealantForwardBindingUnsupported> =>
        options.port === DAEMON_WITHOUT_BINDING_PORT && options.ownerSessionId !== undefined
          ? Effect.fail(
              new SealantForwardBindingUnsupported({ ownerSessionId: options.ownerSessionId }),
            )
          : Effect.succeed({
              channel,
              bound:
                options.ownerSessionId === undefined ||
                options.port === RUNTIME_THAT_DROPS_THE_ECHO_PORT
                  ? { kind: "port" }
                  : { kind: "session", daemonSessionId: options.ownerSessionId },
            });
      return Effect.acquireRelease(
        Effect.sync(() => (daemonConnects += 1)),
        () => Effect.sync(() => (daemonReleases += 1)),
      ).pipe(
        Effect.andThen(
          (): Effect.Effect<
            SealantForwardConnection,
            SealantError | SealantForwardBindingUnsupported
          > => {
            if (options.port === SLOW_DIAL_PORT) {
              dialsStarted += 1;
              return Effect.never;
            }
            if (options.port === STALLED_PORT) return opened(stalledChannel());
            if (options.port === FLOOD_PORT) return opened(floodChannel());
            if (options.port === FAILING_PORT) return opened(floodThenFailChannel());
            if (options.port === BROKEN_PUMP_PORT) return opened(brokenPumpChannel());
            if (options.port === ENDS_AFTER_UPLOAD_PORT) return opened(endsAfterUploadChannel());
            const failure = DAEMON_FAILURES[options.port];
            return failure === undefined ? opened(echoChannel()) : Effect.fail(failure());
          },
        ),
      );
    },
  } as never),
);

const serve = (options: {
  readonly release: "current" | "previous";
  readonly requestsPerMinute: number;
}) => serveForwardRoutes({ services: fakes, ...options });

let core: ServedCore;
beforeAll(async () => {
  core = await serve({ release: "current", requestsPerMinute: 10_000 });
});
afterAll(() => core.close());

const asService = (baseUrl: string) => asForwardService(baseUrl, OWNER);

const forwardV2Url = (workspaceId: string, query: string) =>
  new URL(
    `/v1/workspaces/${workspaceId}/forward/v2?${query}`,
    core.baseUrl.replace("http:", "ws:"),
  );

const refusalOf = async (opening: Promise<unknown>): Promise<ForwardDialError> => {
  const error = await opening.then(
    () => undefined,
    (cause: unknown) => cause,
  );
  if (!(error instanceof ForwardDialError)) {
    throw new Error(`expected a ForwardDialError, got ${String(error)}`);
  }
  return error;
};

const rawExchange = async (lines: ReadonlyArray<string>, after?: (socket: Socket) => void) => {
  const { port } = new URL(core.baseUrl);
  const socket = connect(Number(port), "127.0.0.1");
  await new Promise<void>((resolve) => socket.once("connect", resolve));
  const received = new Promise<Buffer>((resolve) => {
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.once("close", () => resolve(Buffer.concat(chunks)));
  });
  socket.write([...lines, "", ""].join("\r\n"));
  after?.(socket);
  return { socket, received };
};

const upgradeLines = (path: string, connection = "Upgrade") => [
  `GET ${path} HTTP/1.1`,
  "Host: 127.0.0.1",
  "Upgrade: websocket",
  `Connection: ${connection}`,
  "Sec-WebSocket-Version: 13",
  "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
  "Sec-WebSocket-Protocol: sealant.forward.v2",
];

describe("/forward/v2", () => {
  it("sends ready with a port binding, then relays bytes both ways until the workspace ends", async () => {
    const forward = await openForwardV2(asService(core.baseUrl), "wks_ready", ECHO_PORT);
    expect(forward.binding).toEqual({ kind: "port" });

    const writer = forward.writable.getWriter();
    await writer.write(new TextEncoder().encode("ping"));
    await writer.close();
    const received: string[] = [];
    for await (const chunk of forward.readable) received.push(new TextDecoder().decode(chunk));
    expect(received.join("")).toBe("ping");
    await expect(forward.closed).resolves.toEqual({ kind: "end" });
  });

  const cases: ReadonlyArray<{
    readonly reason: string;
    readonly status: number;
    readonly workspaceId: string;
    readonly port?: number;
    readonly host?: "docker";
    readonly apiKey?: string | undefined;
  }> = [
    { reason: "workspace-not-ready", status: 409, workspaceId: "wks_idle" },
    { reason: "runtime-untargetable", status: 503, workspaceId: "wks_k8s" },
    { reason: "runtime-unreachable", status: 503, workspaceId: "wks_down" },
    { reason: "runtime-unreachable", status: 503, workspaceId: "wks_lost" },
    { reason: "connection-refused", status: 502, workspaceId: "wks_ready", port: 7001 },
    {
      reason: "name-unresolved",
      status: 502,
      workspaceId: "wks_ready",
      port: 7002,
      host: "docker",
    },
    { reason: "network-unreachable", status: 502, workspaceId: "wks_ready", port: 7003 },
    { reason: "dial-timeout", status: 504, workspaceId: "wks_ready", port: 7004 },
    { reason: "dial-failed", status: 502, workspaceId: "wks_ready", port: 7005 },
    { reason: "dial-failed", status: 502, workspaceId: "wks_ready", port: 7006 },
    { reason: "not-found", status: 404, workspaceId: "wks_missing" },
    { reason: "not-found", status: 404, workspaceId: "wks_theirs" },
    { reason: "unauthorized", status: 401, workspaceId: "wks_ready", apiKey: undefined },
    { reason: "unauthorized", status: 401, workspaceId: "wks_ready", apiKey: "slt_not_a_key" },
    { reason: "forbidden", status: 403, workspaceId: "wks_ready", apiKey: TOKEN_WITHOUT_EXEC },
    { reason: "invalid-target", status: 400, workspaceId: "wks_ready", port: 70_000 },
    { reason: "internal", status: 500, workspaceId: "wks_broken" },
  ];

  it.each(cases)(
    "refuses $reason ($status) for $workspaceId:$port",
    async ({ reason, status, workspaceId, port, host, ...rest }) => {
      const endpoint = {
        ...asService(core.baseUrl),
        ...("apiKey" in rest ? { apiKey: rest.apiKey } : {}),
      };
      const error = await refusalOf(
        openForwardV2(endpoint, workspaceId, port ?? ECHO_PORT, host === undefined ? {} : { host }),
      );
      expect(error).toBeInstanceOf(SealantApiError);
      expect({ reason: error.reason, status: error.status }).toEqual({ reason, status });
    },
  );

  it("refuses owner-required (400) when a service key asserts no owner", async () => {
    const socket = new WebSocket(
      forwardV2Url("wks_ready", `port=${ECHO_PORT}&token=${SERVICE_KEY}`),
      "sealant.forward.v2",
    );
    const frame = await new Promise<unknown>((resolve) =>
      socket.addEventListener("message", (event) => resolve(JSON.parse(String(event.data))), {
        once: true,
      }),
    );
    expect(frame).toMatchObject({ t: "refused", reason: "owner-required", status: 400 });
  });

  it("refuses not-a-person (400) when a service key asserts a resource domain as owner", async () => {
    const socket = new WebSocket(
      forwardV2Url("wks_ready", `port=${ECHO_PORT}&token=${SERVICE_KEY}&ownerUserId=${DOMAIN}`),
      "sealant.forward.v2",
    );
    const frame = await new Promise<unknown>((resolve) =>
      socket.addEventListener("message", (event) => resolve(JSON.parse(String(event.data))), {
        once: true,
      }),
    );
    expect(frame).toMatchObject({ t: "refused", reason: "not-a-person", status: 400 });
  });

  it("refuses budget-exceeded (429) once the credential's request budget is spent", async () => {
    const tight = await serve({ release: "current", requestsPerMinute: 1 });
    try {
      const first = await openForwardV2(asService(tight.baseUrl), "wks_ready", ECHO_PORT);
      first.close();
      const error = await refusalOf(
        openForwardV2(asService(tight.baseUrl), "wks_ready", ECHO_PORT),
      );
      expect({ reason: error.reason, status: error.status }).toEqual({
        reason: "budget-exceeded",
        status: 429,
      });
    } finally {
      await tight.close();
    }
  });

  it("closes a socket that sends a frame over the limit, and keeps serving", async () => {
    const socket = new WebSocket(
      forwardV2Url("wks_ready", `port=${ECHO_PORT}&ownerUserId=${OWNER}&token=${SERVICE_KEY}`),
      "sealant.forward.v2",
    );
    await new Promise((resolve) => socket.addEventListener("message", resolve, { once: true }));
    const closed = new Promise<number>((resolve) =>
      socket.addEventListener("close", (event) => resolve(event.code)),
    );
    socket.send(new Uint8Array(64 * 1024 + 1));
    await expect(closed).resolves.toBe(1009);

    const forward = await openForwardV2(asService(core.baseUrl), "wks_ready", ECHO_PORT);
    forward.close();
  });

  it("closes with 1002 when the client sends data before ready", async () => {
    const socket = new WebSocket(
      forwardV2Url("wks_ready", `port=${SLOW_DIAL_PORT}&ownerUserId=${OWNER}&token=${SERVICE_KEY}`),
      "sealant.forward.v2",
    );
    const closed = new Promise<number>((resolve) =>
      socket.addEventListener("close", (event) => resolve(event.code)),
    );
    socket.addEventListener("open", () => socket.send(new Uint8Array([1, 2, 3])), { once: true });
    await expect(closed).resolves.toBe(1002);
  });

  it("answers a plain GET with 426 and never dials the workspace", async () => {
    const before = daemonConnects;
    const response = await fetch(
      `${core.baseUrl}/v1/workspaces/wks_ready/forward/v2?port=${ECHO_PORT}&ownerUserId=${OWNER}&token=${SERVICE_KEY}`,
    );
    expect(response.status).toBe(426);
    expect(daemonConnects).toBe(before);
  });

  it("answers 426 to an Upgrade header that Connection does not name, and never dials", async () => {
    const before = daemonConnects;
    const { received } = await rawExchange([
      ...upgradeLines(
        `/v1/workspaces/wks_ready/forward/v2?port=${ECHO_PORT}&ownerUserId=${OWNER}&token=${SERVICE_KEY}`,
        "close",
      ),
    ]);
    expect((await received).toString()).toMatch(/^HTTP\/1\.1 426 /);
    expect(daemonConnects).toBe(before);
  });

  it("refuses an unauthenticated forward before it dials", async () => {
    const before = daemonConnects;
    await refusalOf(
      openForwardV2({ ...asService(core.baseUrl), apiKey: undefined }, "wks_ready", ECHO_PORT),
    );
    expect(daemonConnects).toBe(before);
  });

  it("drops a refused client that never answers the close within the grace", async () => {
    const startedAt = Date.now();
    const { received } = await rawExchange(
      upgradeLines(`/v1/workspaces/wks_ready/forward/v2?port=${ECHO_PORT}`),
    );
    expect((await received).subarray(0, 12).toString()).toBe("HTTP/1.1 101");
    expect(Date.now() - startedAt).toBeLessThan(4_000);
  });

  it("closes the daemon connection when the client leaves during the dial", async () => {
    const [connects, releases, dials] = [daemonConnects, daemonReleases, dialsStarted];
    const socket = new WebSocket(
      forwardV2Url("wks_ready", `port=${SLOW_DIAL_PORT}&ownerUserId=${OWNER}&token=${SERVICE_KEY}`),
      "sealant.forward.v2",
    );
    await eventually(() => dialsStarted > dials);
    expect(daemonConnects).toBe(connects + 1);
    socket.close();
    await eventually(() => daemonReleases === releases + 1);
  });

  it("never dials for a client that left during admission", async () => {
    const [connects, lookups] = [daemonConnects, slowLookupsStarted];
    const socket = new WebSocket(
      forwardV2Url("wks_slow", `port=${ECHO_PORT}&ownerUserId=${OWNER}&token=${SERVICE_KEY}`),
      "sealant.forward.v2",
    );
    await eventually(() => slowLookupsStarted > lookups);
    const closed = new Promise((resolve) => socket.addEventListener("close", resolve));
    socket.close();
    await closed;
    releaseSlowLookup?.();
    await new Promise((resolve) => setTimeout(resolve, 100));
    releaseSlowLookup?.();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(daemonConnects).toBe(connects);
  });

  it("passes on bytes a client sent with its upgrade request", async () => {
    const maskedEmptyCloseFrame = Buffer.from([0x88, 0x80, 0, 0, 0, 0]);
    const { received } = await rawExchange(
      upgradeLines(
        `/v1/workspaces/wks_ready/forward/v2?port=${ECHO_PORT}&ownerUserId=${OWNER}&token=${SERVICE_KEY}`,
      ),
      (socket) => socket.write(maskedEmptyCloseFrame),
    );
    const bytes = await received;
    const headEnd = bytes.indexOf("\r\n\r\n");
    expect(bytes.subarray(0, headEnd).toString()).toMatch(/^HTTP\/1\.1 101 /);
    const opcodes: number[] = [];
    for (let at = headEnd + 4; at + 1 < bytes.length; ) {
      opcodes.push((bytes[at] ?? 0) & 0x0f);
      at += 2 + ((bytes[at + 1] ?? 0) & 0x7f);
    }
    expect(opcodes).toContain(0x8);
  });
});

const progress = (bytes: number, frames: number) =>
  JSON.stringify({ t: "progress", bytes: String(bytes), frames: String(frames) });

describe("/forward/v2 windows", () => {
  const WINDOW_BYTES = 256 * 1024;
  const FRAME = 64 * 1024;

  const openRaw = async (port: number) => {
    const socket = new WebSocket(
      forwardV2Url("wks_ready", `port=${port}&ownerUserId=${OWNER}&token=${SERVICE_KEY}`),
      "sealant.forward.v2",
    );
    socket.binaryType = "arraybuffer";
    const texts: unknown[] = [];
    const received = { bytes: 0, frames: 0 };
    socket.addEventListener("message", (event) => {
      if (typeof event.data === "string") texts.push(JSON.parse(event.data));
      else if (event.data instanceof ArrayBuffer) {
        received.bytes += event.data.byteLength;
        received.frames += 1;
      }
    });
    const closed = new Promise<void>((resolve) =>
      socket.addEventListener("close", () => resolve()),
    );
    await eventually(() => texts.length >= 2);
    return { socket, texts, received, closed };
  };

  it("opens the client's window with a progress of zero right after ready", async () => {
    const { socket, texts } = await openRaw(ECHO_PORT);
    expect(texts).toEqual([
      { t: "ready", version: 2, binding: { kind: "port" } },
      { t: "progress", bytes: "0", frames: "0" },
    ]);
    socket.close();
  });

  it("sends a client no more than its window until it says it has read", async () => {
    const { socket, received } = await openRaw(FLOOD_PORT);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(received).toEqual({ bytes: 0, frames: 0 });

    socket.send(progress(0, 0));
    await eventually(() => received.bytes === WINDOW_BYTES);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(received).toEqual({ bytes: WINDOW_BYTES, frames: WINDOW_BYTES / FRAME });

    socket.send(progress(WINDOW_BYTES, WINDOW_BYTES / FRAME));
    await eventually(() => received.bytes === 2 * WINDOW_BYTES);
    socket.close();
  });

  const violations: ReadonlyArray<{
    readonly name: string;
    readonly reason: string;
    readonly send: (socket: WebSocket) => void;
  }> = [
    {
      name: "sends more bytes than its window",
      reason: "window-exceeded",
      send: (socket) => {
        for (let frame = 0; frame <= WINDOW_BYTES / FRAME; frame++) {
          socket.send(new Uint8Array(FRAME));
        }
      },
    },
    {
      name: "sends more frames than its window",
      reason: "window-exceeded",
      send: (socket) => {
        for (let frame = 0; frame <= 32; frame++) socket.send(new Uint8Array(1));
      },
    },
    {
      name: "claims to have read more than it was sent",
      reason: "protocol-violation",
      send: (socket) => socket.send(progress(1, 1)),
    },
    {
      name: "ends with totals other than what arrived",
      reason: "protocol-violation",
      send: (socket) => {
        socket.send(new Uint8Array(1));
        socket.send(JSON.stringify({ t: "fin", bytes: "2", frames: "1" }));
      },
    },
    {
      name: "sends a text frame this Core cannot read",
      reason: "protocol-violation",
      send: (socket) => socket.send(JSON.stringify({ t: "credit", bytes: 1 })),
    },
  ];

  it("resets a client at once when the daemon fails while the client is not reading", async () => {
    const { socket, texts, received, closed } = await openRaw(FAILING_PORT);
    socket.send(progress(0, 0));
    await eventually(() => received.bytes === WINDOW_BYTES);

    failFloodedChannel?.();

    await closed;
    expect(texts.at(-1)).toEqual({ t: "reset", reason: "runtime-lost" });
  });

  it("resets a client when the relay can no longer read the daemon", async () => {
    const { texts, closed } = await openRaw(BROKEN_PUMP_PORT);
    await closed;
    expect(texts.at(-1)).toEqual({ t: "reset", reason: "runtime-lost" });
  });

  it("tells a client exactly what reached the workspace before it ends", async () => {
    const { socket, texts, closed } = await openRaw(ENDS_AFTER_UPLOAD_PORT);
    socket.send(new Uint8Array(3));
    await closed;
    expect(texts.slice(1)).toEqual([
      { t: "progress", bytes: "0", frames: "0" },
      { t: "progress", bytes: "3", frames: "1" },
      { t: "fin", bytes: "0", frames: "0" },
    ]);
  });

  it.each(violations)("resets a client that $name: $reason", async ({ reason, send }) => {
    const { socket, texts, closed } = await openRaw(STALLED_PORT);
    send(socket);
    await closed;
    expect(texts.at(-1)).toEqual({ t: "reset", reason });
  });
});

describe("a /forward/v2 bound to a session", () => {
  const openBound = (session: string, port = ECHO_PORT) =>
    openForwardV2(asService(core.baseUrl), "wks_ready", port, { session });

  it("binds the forward to the session's daemon session, and says so in ready", async () => {
    const forward = await openBound("ses_serving");
    expect(forward.binding).toEqual({ kind: "session", session: "ses_serving" });
    expect(ownerSessionsAsked.at(-1)).toBe("sess_serving");
    forward.close();
  });

  it("asks the daemon for no binding without a session", async () => {
    const forward = await openForwardV2(asService(core.baseUrl), "wks_ready", ECHO_PORT);
    expect(forward.binding).toEqual({ kind: "port" });
    expect(ownerSessionsAsked.at(-1)).toBeUndefined();
    forward.close();
  });

  const refusals: ReadonlyArray<{
    readonly reason: string;
    readonly status: number;
    readonly session: string;
    readonly port?: number;
    readonly dials: boolean;
  }> = [
    { reason: "not-found", status: 404, session: "ses_missing", dials: false },
    { reason: "not-found", status: 404, session: "ses_theirs", dials: false },
    { reason: "not-found", status: 404, session: "ses_elsewhere", dials: false },
    { reason: "internal", status: 500, session: "ses_broken", dials: false },
    { reason: "owner-exited", status: 409, session: "ses_exited", dials: false },
    { reason: "owner-exited", status: 409, session: "ses_serving", port: 7007, dials: true },
    { reason: "peer-mismatch", status: 409, session: "ses_serving", port: 7008, dials: true },
    {
      reason: "binding-unverifiable",
      status: 409,
      session: "ses_serving",
      port: 7009,
      dials: true,
    },
    {
      reason: "binding-unsupported",
      status: 409,
      session: "ses_serving",
      port: DAEMON_WITHOUT_BINDING_PORT,
      dials: true,
    },
    {
      reason: "binding-unsupported",
      status: 409,
      session: "ses_serving",
      port: RUNTIME_THAT_DROPS_THE_ECHO_PORT,
      dials: true,
    },
  ];

  it.each(refusals)(
    "refuses $reason ($status) for $session:$port",
    async ({ reason, status, session, port, dials }) => {
      const before = daemonConnects;
      const error = await refusalOf(openBound(session, port));
      expect({ reason: error.reason, status: error.status }).toEqual({ reason, status });
      expect(daemonConnects - before).toBe(dials ? 1 : 0);
    },
  );

  it("refuses binding-unsupported before it dials a runtime that cannot bind", async () => {
    const asked = (containerId: string) =>
      capabilitiesAsked.filter((id) => id === containerId).length;
    const before = { connects: daemonConnects, oldDaemonAsked: asked("ctr_old_daemon") };
    const openOnOldDaemon = () =>
      openForwardV2(asService(core.baseUrl), "wks_old_daemon", ECHO_PORT, {
        session: "ses_on_old_daemon",
      });

    expect((await refusalOf(openOnOldDaemon())).reason).toBe("binding-unsupported");
    expect((await refusalOf(openOnOldDaemon())).reason).toBe("binding-unsupported");
    expect(daemonConnects).toBe(before.connects);
    expect(asked("ctr_old_daemon") - before.oldDaemonAsked).toBe(2);

    const unbound = await openForwardV2(asService(core.baseUrl), "wks_old_daemon", ECHO_PORT);
    expect(unbound.binding).toEqual({ kind: "port" });
    unbound.close();

    for (const forward of [await openBound("ses_serving"), await openBound("ses_serving")]) {
      forward.close();
    }
    expect(asked("ctr_ready")).toBe(1);
  });

  it("tells a session that has not started yet so, rather than that it exited", async () => {
    const error = await refusalOf(openBound("ses_starting"));
    expect(error.reason).toBe("owner-exited");
    expect(error.message).toMatch(/has not started/);
  });

  it("refuses a bound forward to the Docker sidecar as invalid-target, before it dials", async () => {
    const before = daemonConnects;
    const socket = new WebSocket(
      forwardV2Url(
        "wks_ready",
        `port=${ECHO_PORT}&host=docker&session=ses_serving&ownerUserId=${OWNER}&token=${SERVICE_KEY}`,
      ),
      "sealant.forward.v2",
    );
    const frame = await new Promise<unknown>((resolve) =>
      socket.addEventListener("message", (event) => resolve(JSON.parse(String(event.data))), {
        once: true,
      }),
    );
    expect(frame).toMatchObject({ t: "refused", reason: "invalid-target", status: 400 });
    expect(daemonConnects).toBe(before);
  });
});

describe("the legacy /forward route", () => {
  const legacyAnswer = (path: string) =>
    new Promise<{ readonly status: number; readonly body: string }>((resolve, reject) => {
      const request = httpRequest(`${core.baseUrl}${path}`, {
        agent: false,
        headers: {
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-version": "13",
          "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        },
      });
      request.on("response", (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
        );
      });
      request.on("upgrade", (_response, socket) => {
        socket.destroy();
        resolve({ status: 101, body: "" });
      });
      request.on("error", reject);
      request.end();
    });

  const asOwner = `ownerUserId=${OWNER}&token=${SERVICE_KEY}`;
  const answers: ReadonlyArray<{
    readonly path: string;
    readonly status: number;
    readonly body: string;
  }> = [
    {
      path: `/v1/workspaces/wks_ready/forward?port=70000&${asOwner}`,
      status: 400,
      body: "port must be an integer in 1..65535",
    },
    {
      path: `/v1/workspaces/wks_ready/forward?port=7000&host=10.0.0.1&${asOwner}`,
      status: 400,
      body: "host must be one of: 127.0.0.1, localhost, docker",
    },
    {
      path: `/v1/workspaces/wks_ready/forward?port=7000&protocol=sctp&${asOwner}`,
      status: 400,
      body: "protocol must be one of: tcp, udp",
    },
    {
      path: `/v1/workspaces/wks_ready/forward?port=7000&token=${SERVICE_KEY}`,
      status: 400,
      body: "ownerUserId is required when authenticating as a service principal.",
    },
    {
      path: `/v1/workspaces/wks_ready/forward?port=7000&token=${SERVICE_KEY}&ownerUserId=${DOMAIN}`,
      status: 400,
      body: `ownerUserId ${NOT_A_PERSON}`,
    },
    {
      path: `/v1/workspaces/wks_ready/forward?port=7000&token=${TOKEN_WITHOUT_EXEC}`,
      status: 403,
      body: "Access token lacks the required scope: workspace:exec.",
    },
    {
      path: `/v1/workspaces/wks_ready/forward?port=7000&token=slt_not_a_key`,
      status: 401,
      body: "Unknown or revoked access token.",
    },
    {
      path: `/v1/workspaces/wks_theirs/forward?port=7000&${asOwner}`,
      status: 404,
      body: "Workspace not found: wks_theirs",
    },
    {
      path: `/v1/workspaces/wks_broken/forward?port=7000&${asOwner}`,
      status: 404,
      body: "Workspace not found: wks_broken",
    },
    {
      path: `/v1/workspaces/wks_idle/forward?port=7000&${asOwner}`,
      status: 409,
      body: "The workspace runtime is not available.",
    },
    {
      path: `/v1/workspaces/wks_ready/forward?port=7001&${asOwner}`,
      status: 502,
      body: "Nothing accepted the connection to 127.0.0.1:7001 inside the workspace.",
    },
  ];

  it.each(answers)("still answers $status before the upgrade for $path", async (answer) => {
    await expect(legacyAnswer(answer.path)).resolves.toEqual({
      status: answer.status,
      body: answer.body,
    });
  });

  it("still answers 401 from the gate without a credential", async () => {
    const { status } = await legacyAnswer(`/v1/workspaces/wks_ready/forward?port=7001`);
    expect(status).toBe(401);
  });

  it("is what a Core without /forward/v2 serves, which the v2 client reports as protocol-unsupported", async () => {
    const old = await serve({ release: "previous", requestsPerMinute: 10_000 });
    try {
      const probe = await fetch(`${old.baseUrl}/v1/workspaces/wks_ready/forward/v2`);
      expect(probe.status).toBe(401);
      const error = await refusalOf(openForwardV2(asService(old.baseUrl), "wks_ready", ECHO_PORT));
      expect({ reason: error.reason, status: error.status }).toEqual({
        reason: "protocol-unsupported",
        status: undefined,
      });
    } finally {
      await old.close();
    }
  });
});

describe("a v2 client with no server to reach", () => {
  it("reports transport-unavailable", async () => {
    const gone = await serve({ release: "current", requestsPerMinute: 10_000 });
    await gone.close();
    const error = await refusalOf(openForwardV2(asService(gone.baseUrl), "wks_ready", ECHO_PORT));
    expect({ reason: error.reason, status: error.status }).toEqual({
      reason: "transport-unavailable",
      status: undefined,
    });
  });
});
