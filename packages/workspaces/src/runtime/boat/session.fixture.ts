import { randomUUID } from "node:crypto";
import http from "node:http";

import { credentialCipherLayer } from "@sealant/credentials";
import {
  SealantDB,
  BoatAllocationRepo,
  boatControlRequestRepoLayer,
  BoatAllocationRepoLive,
  BoatObservationRepoLive,
  WorkspaceAttemptRepoLive,
  BoatExecutionRepoLive,
  boatTunnelRepoLayer,
  NativePublicationRepoLive,
  WorkspaceCaptureDrainRepoLive,
  WorkspaceRuntimeInstanceRepoLive,
  type DB,
} from "@sealant/db";
import { StreamKind } from "@sealant/runtime-client";
import { boatAllocationInputSchema, boatExecutionTargetSchema } from "@sealant/validators";
import { Effect, Layer, ManagedRuntime, Redacted, Schedule, Stream } from "effect";
import { z } from "zod";

import { BoatTunnelError } from "../../resources/boat-tunnel.js";
import { SealantRuntime } from "../../sealantd/runtime.js";
import { boatReadinessLayer } from "../../worker/boat-readiness.js";
import { BoatResourcesHost, boatResourcesLayer } from "../../worker/boat-resources.js";
import { BoatRuntimeAdapter } from "./adapter.js";
import { GatewayFixture, GuestFixture, ProviderFixture } from "./allocation.fixture.js";
import { boatAllocationLayer } from "./allocation.js";
import { HttpBoatApi } from "./api.js";
import { BoatSecret } from "./config.js";
import { boatDischargeLayer } from "./discharge.js";
import {
  BoatGuestTransportService,
  boatExecutionLayer,
  type BoatGuestTransport,
} from "./execution.js";
import { BoatFinalCloseProvider, boatFinalCloseLayerNoDeps } from "./final-close.js";
import {
  BoatInteractiveControl,
  boatInteractiveControlLayer,
  serveBoatControlRequests,
} from "./interactive-control.js";
import { boatObserverLayer } from "./observation.js";
import { BoatAllocationProvider } from "./provider.js";
import type { boatSessionDaemon } from "./session-daemon.fixture.js";

const secret = (value: string) => {
  const parsed = BoatSecret.parse(value);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
};
const listen = async (server: http.Server) => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing fixture address");
  return `http://127.0.0.1:${address.port}`;
};
const close = (server: http.Server) =>
  new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

/** Local provider/receiver boundaries around the real database, allocation, readiness and FINAL owners. */
export const boatSessionFixture = async (
  db: DB,
  owner: string,
  daemon: Awaited<ReturnType<typeof boatSessionDaemon>>,
) => {
  const guest = new GuestFixture();
  const gateway = new GatewayFixture();
  gateway.allowRemoval = true;
  const failures: unknown[] = [];
  const wire = http.createServer((request, response) => {
    void (async () => {
      let raw = "";
      for await (const chunk of request) raw += String(chunk);
      const body: unknown = raw.length === 0 ? undefined : JSON.parse(raw);
      let value: unknown;
      if (request.url === "/bind") {
        const input = z
          .object({ target: boatExecutionTargetSchema, request: z.unknown() })
          .parse(body);
        value = await guest.bind(input.target, input.request);
      } else if (request.url === "/probe") {
        const parsed = BoatSecret.parse(request.headers.authorization?.slice(7));
        if (!parsed.ok) throw parsed.error;
        value = await daemon.probe(parsed.value);
      } else {
        if (request.headers.authorization !== `Bearer ${"a".repeat(64)}`)
          throw new Error("wrong receiver bearer");
        if (request.url === "/start" && guest.starts === 0) {
          const stage = guest.stageBodies.at(-1);
          if (stage === undefined) throw new Error("start without staged launch");
          await daemon.start(stage);
        }
        value = await guest.call(
          undefined,
          secret("a".repeat(64)),
          (request.url ?? "").slice(1),
          raw.length === 0 ? undefined : Redacted.make(raw),
        );
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(value));
    })().catch((error: unknown) => {
      failures.push(error);
      response.writeHead(500).end();
    });
  });
  const receiverOrigin = await listen(wire);
  const post = async (path: string, body?: string, bearer = secret("a".repeat(64))) => {
    const reply = await fetch(`${receiverOrigin}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer.reveal()}` },
      signal: AbortSignal.timeout(30_000),
      ...(body === undefined ? {} : { body }),
    });
    if (!reply.ok) throw new Error(`receiver refused ${path}`);
    const result: unknown = await reply.json();
    return result;
  };
  const transport: BoatGuestTransport = {
    bind: (target, request) => post("bind", JSON.stringify({ target, request })),
    host: () => guest.host(),
    call: (_host, bearer, route, body) =>
      post(route, body === undefined ? undefined : Redacted.value(body), bearer),
    probe: async (_host, bearer) =>
      z
        .object({ runtimeId: z.string(), healthy: z.boolean(), supports: z.array(z.string()) })
        .parse(await post("probe", undefined, bearer)),
  };
  let provider: ProviderFixture | undefined;
  const server = http.createServer((request, response) => {
    if (provider === undefined) {
      response.writeHead(500).end();
      return;
    }
    void (async () => {
      if (request.method === "DELETE" && request.url?.startsWith("/api/v1/sandboxes/"))
        await daemon.remove();
      await provider?.serve(request, response);
    })().catch((error: unknown) => {
      failures.push(error);
      response.writeHead(500).end();
    });
  });
  const origin = await listen(server);
  const api = HttpBoatApi.create({
    credential: secret("local-provider-only"),
    baseUrl: `${origin}/api/v1`,
    // Includes real Docker shutdown/removal. Use the production transport budget.
  });
  if (!api.ok) throw api.error;
  const Infra = Layer.mergeAll(
    Layer.succeed(SealantDB, db),
    credentialCipherLayer({ key: Buffer.alloc(32, 7).toString("base64") }).pipe(Layer.orDie),
    Layer.succeed(BoatAllocationProvider, { deploymentId: owner, api: api.value }),
    Layer.succeed(BoatFinalCloseProvider, { api: api.value }),
    Layer.succeed(BoatResourcesHost, {
      deploymentId: owner,
      gatewayHostId: randomUUID(),
      endpoint: "10.0.0.41",
      subnets: { allocate: async () => "10.98.0.32/27", release: async () => undefined },
      tunnel: {
        ensure: (input) =>
          Effect.tryPromise({
            try: () => gateway.ensure(input),
            catch: () => new BoatTunnelError("gateway-unavailable"),
          }),
        remove: () => gateway.remove(),
      },
    }),
  );
  const Exchange = boatExecutionLayer.pipe(
    Layer.provide(Layer.succeed(BoatGuestTransportService, transport)),
  );
  const Resources = boatResourcesLayer.pipe(Layer.provide(Exchange));
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      boatAllocationLayer.pipe(Layer.provide(Layer.merge(Exchange, boatObserverLayer))),
      boatReadinessLayer.pipe(Layer.provide(Layer.merge(Resources, Exchange))),
      boatFinalCloseLayerNoDeps.pipe(
        Layer.provide(
          Layer.mergeAll(
            boatObserverLayer,
            boatDischargeLayer,
            BoatObservationRepoLive,
            WorkspaceAttemptRepoLive,
            Exchange,
            NativePublicationRepoLive,
            BoatAllocationRepoLive,
            BoatExecutionRepoLive,
            boatTunnelRepoLayer,
            WorkspaceCaptureDrainRepoLive,
            WorkspaceRuntimeInstanceRepoLive,
            Layer.succeed(SealantRuntime, daemon.control),
          ),
        ),
      ),
      BoatAllocationRepoLive,
      WorkspaceRuntimeInstanceRepoLive,
      BoatExecutionRepoLive,
      NativePublicationRepoLive,
      WorkspaceCaptureDrainRepoLive,
      boatTunnelRepoLayer,
      Exchange,
      boatInteractiveControlLayer,
      boatControlRequestRepoLayer,
    ).pipe(Layer.provideMerge(Infra)),
  );
  const adapter = new BoatRuntimeAdapter({ deploymentId: owner, ownerIds: [owner], runtime });
  return {
    runtime,
    guest,
    gateway,
    get provider() {
      return provider;
    },
    failures,
    shell: (runId: string, script: string) =>
      runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.forkScoped(
              serveBoatControlRequests.pipe(Effect.repeat(Schedule.spaced(10))),
            );
            const allocation = yield* (yield* BoatAllocationRepo).get(runId);
            if (allocation?.sandboxId == null) throw new Error("missing sandbox");
            const interactive = yield* BoatInteractiveControl;
            const access = yield* Effect.promise(() =>
              interactive.connectMaterial(runId, allocation.sandboxId ?? ""),
            );
            if (access.url === undefined)
              throw new Error("interactive resolver omitted the endpoint");
            const connection = yield* daemon.control.connect({
              kind: "websocket",
              url: access.url,
              auth: access.auth,
              prepare: async () => access,
            });
            const process = yield* connection.exec({
              executable: "/bin/sh",
              args: ["-c", script],
              stdin: false,
            });
            const events = yield* connection.events.pipe(
              Stream.filter((e) => e.processId === undefined || e.processId === process.processId),
              Stream.takeUntil((e) => e.payload.case === "processExited"),
              Stream.runCollect,
            );
            let stdout = "";
            let exitCode: number | undefined;
            for (const e of events) {
              if (
                e.payload.case === "ioChunk" &&
                e.payload.value.stream === StreamKind.STDOUT &&
                e.payload.value.content !== undefined
              )
                stdout += Buffer.from(e.payload.value.content).toString();
              if (e.payload.case === "processExited") exitCode = e.payload.value.exitCode;
            }
            return { stdout, exitCode };
          }),
        ).pipe(Effect.timeout(20_000)),
      ),
    // Only the external provider's image inventory is populated here. All Core rows come from the worker.
    adapter: {
      id: adapter.id,
      supports: adapter.supports.bind(adapter),
      launch: async (...args: Parameters<typeof adapter.launch>) => {
        const input = args[0];
        provider ??= new ProviderFixture(
          boatAllocationInputSchema.parse({
            deploymentId: owner,
            workspaceId: input.workspaceId,
            consumer: { runId: input.runId, runtimeInstanceId: input.runId },
            launchAttemptId: input.launchId ?? input.runId,
            publication: input.publication,
            scope: { kind: "owner", ownerUserId: owner },
            sourceKind: "capture",
          }),
        );
        provider.parking = true;
        // A resumed workspace must allocate a different VM and bind to a fresh boot.
        return adapter.launch(...args);
      },
      stop: adapter.stop.bind(adapter),
    },
    dispose: async () => {
      await runtime.dispose();
      await close(server);
      await close(wire);
    },
  };
};
