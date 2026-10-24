import { createHash } from "node:crypto";
import { createServer, request as httpRequest, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import { Duplex } from "node:stream";

import { NodeHttpServer } from "@effect/platform-node";
import { AccessTokenRepo, WorkspaceRepo, WorkspaceRuntimeInstanceRepo } from "@sealant/db";
import { ForwardDialError, SealantApiError } from "@sealant/sdk";
import { openForwardV2, type ForwardEndpoint } from "@sealant/sdk/internal/forward";
import {
  SealantControlError,
  SealantRuntime,
  SealantRuntimeLive,
  type SealantTarget,
  SealantTransport,
} from "@sealant/workspaces";
import { Effect, Exit, Layer, Scope } from "effect";
import { HttpMiddleware, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SERVICE_KEY = "slt_forward_v2_service_key";
process.env["SEALANT_SERVICE_KEYS"] = SERVICE_KEY;

const OWNER = "usr_forward";
const TOKEN_WITHOUT_EXEC = "slt_token_without_workspace_exec";
const ECHO_PORT = 7000;
const SLOW_DIAL_PORT = 7010;

const DAEMON_FAILURES: Record<number, () => SealantControlError> = {
  7001: () => controlError({ reason: "connection-refused" }),
  7002: () => controlError({ reason: "name-unresolved" }),
  7003: () => controlError({ reason: "network-unreachable" }),
  7004: () => controlError({ reason: "dial-timeout" }),
  7005: () => controlError(undefined),
  7006: () => controlError({ reason: "a-cause-this-core-has-never-heard-of" }),
};

function controlError(detail: object | undefined) {
  return new SealantControlError({
    operation: "openForward",
    code: 13,
    message: "forward connect failed",
    ...(detail === undefined ? {} : { detailJson: JSON.stringify(detail) }),
  });
}

const echoChannel = () => {
  const queued: Uint8Array[] = [];
  let ended = false;
  let wake: (() => void) | undefined;
  return {
    write: (data: Uint8Array) => {
      queued.push(new Uint8Array(data));
      wake?.();
    },
    end: () => {
      ended = true;
      wake?.();
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        const next = queued.shift();
        if (next !== undefined) yield next;
        else if (ended) return;
        else await new Promise<void>((resolve) => (wake = resolve));
      }
    },
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
  Layer.succeed(SealantRuntime, {
    connect: (target: SealantTarget) => {
      const containerId = target.kind === "docker-exec" ? target.containerId : undefined;
      if (containerId === "ctr_lost") return runtimeLosingItsConnection.connect(target);
      if (containerId === "ctr_down") {
        return Effect.fail(
          new SealantControlError({ operation: "connect", code: 14, message: "no such container" }),
        );
      }
      return Effect.acquireRelease(
        Effect.sync(() => {
          daemonConnects += 1;
          return {
            openForward: (port: number) => {
              if (port === SLOW_DIAL_PORT) {
                dialsStarted += 1;
                return Effect.never;
              }
              const failure = DAEMON_FAILURES[port];
              return failure === undefined
                ? Effect.succeed({ channelId: "chan_1", channel: echoChannel() })
                : Effect.fail(failure());
            },
            closeForward: () => Effect.void,
          };
        }),
        () => Effect.sync(() => (daemonReleases += 1)),
      );
    },
  } as never),
);

interface Served {
  readonly baseUrl: string;
  readonly close: () => Promise<void>;
}

const previousReleaseGate = HttpMiddleware.make((app) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (!new URL(request.url, "http://localhost").pathname.endsWith("/forward/v2")) {
      return yield* app;
    }
    return HttpServerResponse.jsonUnsafe(
      {
        _tag: "UnauthorizedError",
        message:
          "This control plane requires authentication: present a service key as a bearer token.",
      },
      { status: 401 },
    );
  }),
);

const serve = async (options: {
  readonly release: "current" | "previous";
  readonly requestsPerMinute: number;
}): Promise<Served> => {
  const [{ servicePrincipalMiddleware, makeServicePrincipals }, budgets, upgrade, v2, legacy] =
    await Promise.all([
      import("../../services/service-principals.js"),
      import("../../services/budgets.js"),
      import("./forward-upgrade.js"),
      import("./workspaces.forward-v2.js"),
      import("./workspaces.ws.js"),
    ]);
  const routes = (
    options.release === "current"
      ? Layer.mergeAll(legacy.WorkspaceForwardRoute, v2.WorkspaceForwardV2Route)
      : legacy.WorkspaceForwardRoute
  ).pipe(HttpRouter.provideRequest(fakes));
  const gate = servicePrincipalMiddleware(makeServicePrincipals(SERVICE_KEY), undefined, {
    window: budgets.makeRateWindow(),
    requestsPerMinute: options.requestsPerMinute,
  });
  let server: Server | undefined;
  const layer = HttpRouter.serve(routes as Layer.Layer<never, never, HttpRouter.HttpRouter>, {
    middleware: options.release === "current" ? gate : (app) => previousReleaseGate(gate(app)),
  }).pipe(
    Layer.provideMerge(
      NodeHttpServer.layer(() => (server = upgrade.captureUpgradeHeads(createServer())), {
        port: 0,
      }),
    ),
  );
  const scope = Effect.runSync(Scope.make());
  await Effect.runPromise(Layer.buildWithScope(layer, scope));
  const address = server?.address();
  if (typeof address !== "object" || address === null) throw new Error("expected a TCP address");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
  };
};

let core: Served;
beforeAll(async () => {
  core = await serve({ release: "current", requestsPerMinute: 10_000 });
});
afterAll(() => core.close());

const asService = (baseUrl: string): ForwardEndpoint => ({
  baseUrl,
  apiKey: SERVICE_KEY,
  ownerUserId: OWNER,
});

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

const eventually = async (condition: () => boolean, withinMs = 3_000) => {
  const deadline = Date.now() + withinMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${withinMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
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
    const { binding, forward } = await openForwardV2(
      asService(core.baseUrl),
      "wks_ready",
      ECHO_PORT,
    );
    expect(binding).toEqual({ kind: "port" });

    forward.send(new TextEncoder().encode("ping"));
    forward.eof();
    const received: string[] = [];
    for await (const chunk of forward.output) received.push(new TextDecoder().decode(chunk));
    expect(received.join("")).toBe("ping");
    await expect(forward.closed).resolves.toBe("end");
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

  it("refuses budget-exceeded (429) once the credential's request budget is spent", async () => {
    const tight = await serve({ release: "current", requestsPerMinute: 1 });
    try {
      const first = await openForwardV2(asService(tight.baseUrl), "wks_ready", ECHO_PORT);
      first.forward.close();
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

    const { forward } = await openForwardV2(asService(core.baseUrl), "wks_ready", ECHO_PORT);
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
