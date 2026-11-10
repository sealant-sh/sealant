import { generateKeyPairSync, randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { boatExecutionTargetSchema, boatNetworkIntentSchema } from "@sealant/validators";
import { Effect, Redacted } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SealantRuntimeService } from "../../sealantd/runtime.js";
import type { BoatSandbox } from "./api.js";
import { BoatSecret, boatSandboxIdSchema } from "./config.js";
import {
  BoatExecutionError,
  boatLaunchRequest,
  createBoatGuestTransport,
  type BoatAgentRoute,
} from "./execution.js";
import { boatLaunchDiagnostic } from "./launch-diagnostics.js";

const target = boatExecutionTargetSchema.parse({
  deploymentId: "deployment",
  workspaceId: "workspace",
  runId: "run",
  runtimeInstanceId: "run",
  launchAttemptId: "attempt",
  sourceId: "source",
  sandboxId: "bx_23456789",
  diskLineage: "disk",
  bootId: "2ead21c0-5a0f-4db0-87bf-fcc992c781b6",
  manifestDigest: "b".repeat(64),
});
const labels = {
  "sealant-runtime": "boat",
  "sealant-deployment": target.deploymentId,
  "sealant-workspace": target.workspaceId,
  "sealant-run": target.runId,
  "sealant-instance": target.runtimeInstanceId,
  "sealant-attempt": target.launchAttemptId,
  "sealant-source": target.sourceId,
};
const runtime: SealantRuntimeService = {
  connect: () => Effect.die("unexpected control connection"),
  openForwardConnection: () => Effect.die("unexpected forward connection"),
};
const unavailable = async (): Promise<never> => {
  throw new Error("must not call");
};
const secret = (value: string) => {
  const parsed = BoatSecret.parse(value);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
};
const bindRequest = () => {
  const key = generateKeyPairSync("rsa", { modulusLength: 3072 });
  return {
    format: "sealant-bootstrap-v1",
    identity: {
      deployment_id: target.deploymentId,
      instance_id: target.sandboxId,
      disk_lineage: target.diskLineage,
    },
    boot_id: target.bootId,
    manifest_digest: target.manifestDigest,
    operation_id: randomUUID(),
    public_key: key.publicKey.export({ type: "spki", format: "pem" }),
  };
};
const found = async () => ({
  ok: true as const,
  value: {
    id: boatSandboxIdSchema.parse(target.sandboxId),
    state: "running" as const,
    labels,
    autoStop: { kind: "disabled" as const },
  },
});

describe("Boat network intent boundary", () => {
  it("accepts canonical private /27 networks and rejects public, misaligned and trailing representations", () => {
    const intent = {
      epoch: 1,
      operationId: randomUUID(),
      endpoint: "10.0.0.41",
      subnet: "10.98.0.32/27",
    };
    for (const subnet of ["10.0.0.0/27", "172.16.0.32/27", "172.31.255.224/27", "192.168.4.64/27"])
      expect(boatNetworkIntentSchema.safeParse({ ...intent, subnet }).success).toBe(true);
    for (const subnet of [
      "8.8.8.0/27",
      "172.15.0.32/27",
      "172.32.0.32/27",
      "10.0.0.1/27",
      "10.0.0.0/28",
      "10.0.0.0/27/extra",
      "10.0.0.0/27\n",
    ])
      expect(boatNetworkIntentSchema.safeParse({ ...intent, subnet }).success).toBe(false);
  });
});

describe("Boat launch body", () => {
  it("names the agent contract version by whether the material asks for Docker", () => {
    const material = {
      bootEnv: { SEALANT_WORKSPACE_SOURCE: "capture" },
      secretEnv: { SEALANT_CAPTURE_TOKEN: "mst_x" },
      pins: { credentialVersions: [], dotfiles: [] },
      docker: false,
    };
    expect(boatLaunchRequest(material, "run_1", "a".repeat(64))).toEqual({
      version: 1,
      runId: "run_1",
      controlToken: "a".repeat(64),
      flushTimeoutMs: 30_000,
      bootEnv: { SEALANT_WORKSPACE_SOURCE: "capture" },
      secretEnvJson: JSON.stringify({ SEALANT_CAPTURE_TOKEN: "mst_x" }),
    });
    expect(boatLaunchRequest({ ...material, docker: true }, "run_1", "a".repeat(64))).toMatchObject(
      { version: 2, services: { docker: "required" } },
    );
  });
});

describe("Boat worker public bootstrap transport", () => {
  it("checks every provider target label before issuing a command", async () => {
    for (const key of Object.keys(labels)) {
      const actual: BoatSandbox = {
        id: boatSandboxIdSchema.parse(target.sandboxId),
        state: "running",
        labels: { ...labels, [key]: "foreign" },
        autoStop: { kind: "disabled" },
      };
      const transport = createBoatGuestTransport(
        {
          get: async () => ({ ok: true, value: actual }),
          execute: unavailable,
          hostControl: unavailable,
        },
        runtime,
      );
      await expect(transport.bind(target, {})).rejects.toThrow("target-mismatch");
      await expect(transport.host(target)).rejects.toThrow("target-mismatch");
    }
  });
  it("runs only the bind CLI under the image's own Node, and keeps an unknown outcome a lost exchange", async () => {
    let count = 0;
    const transport = createBoatGuestTransport(
      {
        get: found,
        execute: async (id, command) => {
          count++;
          expect(id).toBe(target.sandboxId);
          expect(
            command.startsWith(
              "/usr/bin/sudo -n -- /opt/sealant/node /opt/sealant/boat-bind.mjs '",
            ),
          ).toBe(true);
          expect(command).toContain("public_key");
          return {
            ok: true,
            value: {
              exitCode: null,
              timedOut: true,
              stdout: "x".repeat(9000) + "token=do-not-record-me\n",
              stderr: "Bearer do-not-record-me\nsomething else entirely",
            },
          };
        },
        hostControl: unavailable,
      },
      runtime,
    );
    await expect(transport.bind(target, bindRequest())).rejects.toThrow(
      /transport-unavailable.*stderrTail.*REDACTED_AUTH/,
    );
    expect(count).toBe(1);
  });
  it("types the bind CLI's refusal by its one reason code on stderr", async () => {
    const transport = createBoatGuestTransport(
      {
        get: found,
        execute: async () => ({
          ok: true,
          value: { exitCode: 1, timedOut: false, stdout: "", stderr: "bind-manifest-mismatch\n" },
        }),
        hostControl: unavailable,
      },
      runtime,
    );
    const failure = await transport.bind(target, bindRequest()).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(BoatExecutionError);
    const diagnostic = boatLaunchDiagnostic(failure, "bind-exchange");
    expect(diagnostic).toMatchObject({
      step: "bind-exchange",
      code: "agent-refused",
      command: { exitCode: 1, timedOut: false },
    });
    expect(diagnostic.command?.stderrTail?.trim()).toBe("bind-manifest-mismatch");
  });
});

/** The hosted origin Core holds for a VM; every test routes it to a local server. */
const HOSTED_ORIGIN = "https://fixture-8080.on.boat.dev";
const realFetch = globalThis.fetch;
const servers: http.Server[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((done) => {
          server.closeAllConnections();
          server.close(() => done());
        }),
    ),
  );
});
/** A hosted proxy in front of an agent: answers each route from a table, records what it saw. */
const hosted = async (answers: Record<string, { status: number; body: string }>) => {
  const seen: Array<{ method: string; url: string; cookie?: string; auth?: string; body: string }> =
    [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    request.on("end", () => {
      seen.push({
        method: request.method ?? "",
        url: request.url ?? "",
        ...(request.headers.cookie === undefined ? {} : { cookie: request.headers.cookie }),
        ...(request.headers.authorization === undefined
          ? {}
          : { auth: request.headers.authorization }),
        body,
      });
      const answer = answers[`${request.method ?? ""} ${request.url ?? ""}`] ?? {
        status: 404,
        body: JSON.stringify({ message: "unknown route" }),
      };
      response.writeHead(answer.status, { "content-type": "application/json" });
      response.end(answer.body);
    });
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no address");
  const local = `http://127.0.0.1:${String((address as AddressInfo).port)}`;
  // The transport checks the hosted origin before it sends; the proxy itself is this server.
  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) =>
    realFetch(String(input).replace(HOSTED_ORIGIN, local), init),
  );
  return { origin: HOSTED_ORIGIN, local, seen };
};
const bearer = secret("a".repeat(64));
const cookie = secret("local-cookie-only");
const transport = createBoatGuestTransport(
  { get: unavailable, execute: unavailable, hostControl: unavailable },
  runtime,
);

describe("Boat agent requests over the hosted proxy", () => {
  it("sends the proxy cookie and the bearer, and hands the caller the statuses a route answers", async () => {
    const { origin, seen } = await hosted({
      "GET /sealant/health": { status: 503, body: JSON.stringify({ booted: false }) },
      "POST /sealant/launch": { status: 409, body: JSON.stringify({ message: "already booted" }) },
      "POST /sealant/recover": { status: 200, body: JSON.stringify({ outcome: "running" }) },
    });
    const access = { origin, cookie };
    expect(await transport.request(access, bearer, "health")).toEqual({
      status: 503,
      body: { booted: false },
    });
    expect(
      await transport.request(access, bearer, "launch", Redacted.make(JSON.stringify({ a: 1 }))),
    ).toEqual({ status: 409, body: { message: "already booted" } });
    expect(
      await transport.request(access, bearer, "recover", Redacted.make(JSON.stringify({ b: 2 }))),
    ).toEqual({ status: 200, body: { outcome: "running" } });
    expect(seen).toEqual([
      {
        method: "GET",
        url: "/sealant/health",
        cookie: `_port_auth=${cookie.reveal()}`,
        auth: `Bearer ${bearer.reveal()}`,
        body: "",
      },
      {
        method: "POST",
        url: "/sealant/launch",
        cookie: `_port_auth=${cookie.reveal()}`,
        auth: `Bearer ${bearer.reveal()}`,
        body: JSON.stringify({ a: 1 }),
      },
      {
        method: "POST",
        url: "/sealant/recover",
        cookie: `_port_auth=${cookie.reveal()}`,
        auth: `Bearer ${bearer.reveal()}`,
        body: JSON.stringify({ b: 2 }),
      },
    ]);
  });
  it.each<{
    name: string;
    route: BoatAgentRoute;
    status: number;
    body: string;
    code: string;
    reason?: string;
  }>([
    {
      name: "a request the agent rejected",
      route: "network",
      status: 400,
      body: JSON.stringify({ reason: "invalid-network-key" }),
      code: "agent-rejected",
      reason: "invalid-network-key",
    },
    {
      name: "a bearer the agent does not hold",
      route: "health",
      status: 401,
      body: JSON.stringify({ message: "control token does not match" }),
      code: "agent-unauthorized",
    },
    {
      name: "a route this agent lacks",
      route: "recover",
      status: 404,
      body: JSON.stringify({ message: "unknown route" }),
      code: "agent-route-missing",
    },
    {
      name: "a network conflict",
      route: "network",
      status: 409,
      body: JSON.stringify({ reason: "network-binding-conflict" }),
      code: "agent-refused",
      reason: "network-binding-conflict",
    },
    {
      name: "a proxy whose VM is still booting",
      route: "network-status",
      status: 503,
      body: "<html>Service Unavailable Bearer secret-value-here</html>",
      code: "agent-not-ready",
    },
    {
      name: "a gateway error from the proxy",
      route: "launch",
      status: 502,
      body: "Bad Gateway",
      code: "agent-not-ready",
    },
    {
      // Health lists 503 as answered (the agent's own JSON 503 before a launch); the proxy's
      // 503 for a port not open yet is not that answer, and not an invalid reply either.
      name: "a proxy answering for an agent not listening yet, on a route that answers 503",
      route: "health",
      status: 503,
      body: "<html>Service Unavailable: port 8080 is not open Bearer secret-value-here</html>",
      code: "agent-not-ready",
    },
    {
      name: "a recovery whose Docker stop the agent could not prove",
      route: "recover",
      status: 503,
      body: JSON.stringify({ reason: "docker-stop-unverified" }),
      code: "agent-not-ready",
      reason: "docker-stop-unverified",
    },
  ])(
    "classifies $name by status and reason, never by text",
    async ({ route, status, body, code, reason }) => {
      const spec = {
        health: "GET /sealant/health",
        network: "POST /sealant/network",
        "network-status": "GET /sealant/network",
        launch: "POST /sealant/launch",
        recover: "POST /sealant/recover",
      }[route];
      const { origin } = await hosted({ [spec]: { status, body } });
      const failure = await transport
        .request(
          { origin, cookie },
          bearer,
          route,
          spec.startsWith("POST") ? Redacted.make(JSON.stringify({ secret: "x" })) : undefined,
        )
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      expect(failure).toBeInstanceOf(BoatExecutionError);
      if (!(failure instanceof BoatExecutionError)) throw new Error("typed");
      expect(failure.code).toBe(code);
      const diagnostic = boatLaunchDiagnostic(failure, "agent-request");
      expect(diagnostic.agent?.pathClass).toBe(spec.split(" ")[1]);
      expect(diagnostic.agent?.reason).toBe(reason);
      expect(diagnostic.provider?.status).toBe(status);
      expect(JSON.stringify(diagnostic)).not.toContain("secret-value-here");
    },
  );
  it("keeps lost transport retryable and a malformed answer not", async () => {
    const { origin } = await hosted({
      "GET /sealant/health": { status: 200, body: "not json at all" },
    });
    await expect(transport.request({ origin, cookie }, bearer, "health")).rejects.toThrow(
      "invalid-reply",
    );
    const closed = await hosted({});
    await new Promise<void>((done) => servers.pop()?.close(() => done()));
    await expect(
      transport.request({ origin: closed.origin, cookie }, bearer, "health"),
    ).rejects.toThrow("transport-unavailable");
  });
});
