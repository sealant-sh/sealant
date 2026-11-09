import { spawn, type ChildProcess } from "node:child_process";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import dgram from "node:dgram";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { CredentialCipher } from "@sealant/credentials";
import { BoatAllocationRepo, BoatExecutionRepo, WorkspaceCaptureDrainRepo } from "@sealant/db";
import {
  boatAllocationRecordSchema,
  boatExecutionRecordSchema,
  nativePublicationSchema,
  type BoatExecutionRecord,
  type BoatExecutionTarget,
} from "@sealant/validators";
import { Effect, Layer, Redacted, Result } from "effect";
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import receiverRoutes from "../../../boat-image/receiver-routes.json" with { type: "json" };
import {
  BoatReadiness,
  BoatReadinessError,
  boatReadinessLayerNoDeps,
} from "../../worker/boat-readiness.js";
import { BoatResources } from "../../worker/boat-resources.js";
import { BoatAdapterError } from "./adapter.js";
import { BoatSecret } from "./config.js";
import {
  BoatExecution,
  BoatExecutionError,
  BoatGuestTransportService,
  boatExecutionLayerNoDeps,
  boatReceiverRoutes,
  createBoatGuestTransport,
} from "./execution.js";
import { boatLaunchDiagnostic } from "./launch-diagnostics.js";

// Core's real request builders and transport, the real relay process and the real receiver entry.
// Only the provider edge (a local socket) and privileged guest observations are substituted.
const image = fileURLToPath(new URL("../../../boat-image/", import.meta.url));
const token = "a".repeat(64);
const contractTarget: BoatExecutionTarget = {
  deploymentId: "contract",
  workspaceId: "workspace",
  runId: "run",
  runtimeInstanceId: "run",
  launchAttemptId: "11111111-1111-4111-8111-111111111111",
  sourceId: "source",
  sandboxId: "bx_23456789",
  diskLineage: "disk",
  bootId: "22222222-2222-4222-8222-222222222222",
  manifestDigest: "a".repeat(64),
};
const origin = "https://contract-8080.on.boat.dev";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of cleanup.splice(0).toReversed()) await stop();
});
const stopChild = async (child: ChildProcess) => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await exited;
};
const until = async (check: () => Promise<boolean>, what: () => string) => {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await check()) return;
    await new Promise<void>((done) => setTimeout(done, 25));
  }
  throw new Error(`${what()} did not become ready`);
};
const freePort = async () => {
  const listener = net.createServer();
  await new Promise<void>((done) => listener.listen(0, "127.0.0.1", done));
  const address = listener.address();
  if (address === null || typeof address === "string") throw new Error("no test port");
  await new Promise<void>((done) => listener.close(() => done()));
  return address.port;
};
const secret = (value: string) => {
  const parsed = BoatSecret.parse(value);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
};

/** A DNS reply naming the gateway address for the single question in `query`. */
const answer = (query: Buffer) => {
  let end = 12;
  while (query[end] !== 0) end += (query[end] ?? 0) + 1;
  const question = query.subarray(12, end + 5);
  const header = Buffer.from([0, 0, 0x81, 0x80, 0, 1, 0, 1, 0, 0, 0, 0]);
  query.copy(header, 0, 0, 2);
  const record = Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 30, 0, 4, 100, 127, 255, 253]);
  return Buffer.concat([header, question, record]);
};

/**
 * The tunnel gateway's resolver, on loopback: answers the guest's real DNS probe over UDP and TCP
 * with the gateway address, and stays silent for the UDP queries it is told to lose.
 */
const resolver = async (lose: readonly number[]) => {
  let queries = 0;
  // The probe asks UDP and TCP on one port; find a port free for both.
  for (let attempt = 0; attempt < 20; attempt++) {
    const udp = dgram.createSocket("udp4");
    udp.on("message", (message, from) => {
      if (!lose.includes(++queries)) udp.send(answer(message), from.port, from.address);
    });
    await new Promise<void>((done) => udp.bind(0, "127.0.0.1", done));
    const port = udp.address().port;
    const tcp = net.createServer((socket) => {
      socket.on("error", () => undefined);
      socket.once("data", (data) => {
        const reply = answer(data.subarray(2));
        const length = Buffer.alloc(2);
        length.writeUInt16BE(reply.length);
        socket.end(Buffer.concat([length, reply]));
      });
    });
    const listening = await new Promise<boolean>((done) => {
      tcp.once("error", () => done(false));
      tcp.listen(port, "127.0.0.1", () => done(true));
    });
    if (!listening) {
      udp.close();
      continue;
    }
    cleanup.push(async () => {
      udp.close();
      await new Promise<void>((done) => tcp.close(() => done()));
    });
    return { port, queries: () => queries };
  }
  throw new Error("no port free for both UDP and TCP");
};

/** Starts receiver and relay exactly as the guest units wire them, then returns Core's execution. */
const guest = async (options: {
  readonly kernelLimits?: boolean;
  readonly delays?: Readonly<Record<string, number>>;
  readonly dnsPort?: number;
  readonly target?: BoatExecutionTarget;
}) => {
  const { target: chosen, ...harness } = options;
  const target = chosen ?? contractTarget;
  const root = await mkdtemp(join(tmpdir(), "boat-guest-contract-"));
  cleanup.push(async () => {
    process.stdout.write(
      JSON.stringify({ ownedScratch: root, entries: await readdir(root, { recursive: true }) }) +
        "\n",
    );
    await rm(root, { recursive: true });
  });
  const state = join(root, "state");
  await mkdir(state, { mode: 0o700 });
  const keys = generateKeyPairSync("x25519").privateKey.export({ format: "jwk" });
  if (keys.d === undefined || keys.x === undefined) throw new Error("x25519 export");
  const privateKey = Buffer.from(keys.d, "base64url").toString("base64");
  const publicKey = Buffer.from(keys.x, "base64url").toString("base64");
  let receiverLog = "";
  const receiver = spawn(
    "python3",
    [
      "-B",
      join(image, "fixtures/receiver_harness.py"),
      image,
      state,
      JSON.stringify({
        bootId: target.bootId,
        token,
        wireguardPublicKey: publicKey,
        identity: {
          deployment_id: target.deploymentId,
          instance_id: target.sandboxId,
          disk_lineage: target.diskLineage,
        },
        ...harness,
      }),
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  receiver.stderr?.on("data", (chunk: Buffer) => {
    receiverLog += chunk.toString();
  });
  cleanup.push(() => stopChild(receiver));
  const socket = join(state, "runtime/receiver.sock");
  await until(
    () =>
      access(socket).then(
        () => true,
        () => false,
      ),
    () => `receiver (exit ${receiver.exitCode}): ${receiverLog}`,
  );
  const tokenFile = join(root, "relay.token");
  await writeFile(tokenFile, token, { mode: 0o600 });
  const port = await freePort();
  const relay = spawn(
    process.execPath,
    [
      join(image, "control-relay.mjs"),
      "--socket",
      join(state, "runtime/control.sock"),
      "--token-file",
      tokenFile,
      "--bootstrap-socket",
      socket,
      "--port",
      String(port),
    ],
    { env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, stdio: ["ignore", "pipe", "ignore"] },
  );
  cleanup.push(() => stopChild(relay));
  let relayOutput = "";
  relay.stdout?.on("data", (chunk: Buffer) => {
    relayOutput += chunk.toString();
  });
  await until(
    async () => relayOutput.includes("Relay listening"),
    () => "relay",
  );
  // Boat's hosted edge is the only hop replaced: the real fetch, cookie and origin checks remain.
  const previous = getGlobalDispatcher();
  const dispatcher = new Agent({
    connect: (_options, callback) => {
      const connection = net.connect({ host: "127.0.0.1", port });
      connection.once("connect", () => callback(null, connection));
      connection.once("error", (error) => callback(error, null));
      return connection;
    },
  });
  setGlobalDispatcher(dispatcher);
  cleanup.push(async () => {
    setGlobalDispatcher(previous);
    await dispatcher.destroy();
  });
  const hosted = { origin, cookie: secret("contract-cookie-value") };
  const real = createBoatGuestTransport(
    {
      get: async () => {
        throw new Error("no provider call");
      },
      execute: async () => {
        throw new Error("no provider call");
      },
      hostControl: async () => {
        throw new Error("no provider call");
      },
    },
    {
      connect: () => Effect.die("no daemon connection"),
      openForwardConnection: () => Effect.die("no forward connection"),
    },
  );
  const exchangeId = "33333333-3333-4333-8333-333333333333";
  let record: BoatExecutionRecord = boatExecutionRecordSchema.parse({
    target,
    exchangeId,
    publicKey: "k".repeat(100),
    sealedExchange: null,
    sealedControl: JSON.stringify({
      context: { target, exchangeId, purpose: "control" },
      value: { origin, cookie: hosted.cookie.reveal(), bearer: token },
    }),
    phase: "control",
    admission: null,
  });
  const layer = boatExecutionLayerNoDeps.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(BoatExecutionRepo, {
          get: () => Effect.succeed(record),
          reserve: (next) => Effect.sync(() => (record = next)),
          abort: () => Effect.void,
          advance: (_previous, next) =>
            Effect.sync(() => (record = boatExecutionRecordSchema.parse(next))),
          isolate: (_previous, isolation) =>
            Effect.sync(() => (record = boatExecutionRecordSchema.parse({ ...record, isolation }))),
          forgetResume: () => Effect.void,
        }),
        Layer.succeed(CredentialCipher, {
          encrypt: (raw) => Effect.succeed({ sealed: raw, keyId: "contract" }),
          decrypt: (raw) => Effect.succeed(raw),
        }),
        Layer.succeed(BoatGuestTransportService, {
          ...real,
          bind: async () => {
            throw new Error("bind is a provider command");
          },
          host: async () => hosted,
          // sealantd is not part of this contract; guest_control's peer pinning has its own test.
          probe: async () => ({
            runtimeId: "rt_contract",
            healthy: true,
            supports: ["exec.user", "dotfiles.user", "restore.owner_map", "process.secret-env.v1"],
          }),
        }),
      ),
    ),
  );
  const run = <A>(step: (execution: BoatExecution["Service"]) => Effect.Effect<A, unknown>) =>
    Effect.runPromise(
      Effect.flatMap(BoatExecution, step).pipe(Effect.provide(layer), Effect.result),
    );
  const dispatched = async () =>
    (await readFile(join(state, "dispatched.jsonl"), "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .map((line) => z.object({ route: z.string() }).parse(JSON.parse(line)).route);
  const network = {
    network: {
      epoch: 1,
      operationId: randomUUID(),
      endpoint: "192.168.1.10",
      subnet: "10.98.0.0/27",
    },
    privateKey: Redacted.make(privateKey),
    publicKey,
    gatewayKey: randomBytes(32).toString("base64"),
    port: 40000,
  };
  const launch = {
    files: [
      {
        name: "launch",
        bytes: Buffer.from(
          JSON.stringify({ format: "sealant-daemon-launch-v1", boot_env: { SEALANT_X: "1" } }),
        ),
      },
    ],
    pins: { credentialVersions: [], dotfiles: [] },
  };
  const prepare = async () => {
    expect(
      await run((execution) => execution.stage(target.runtimeInstanceId, Redacted.make(launch))),
    ).toMatchObject({ _tag: "Success" });
    const isolated = await run((execution) =>
      execution.isolate(target, {
        ...network,
        network: { ...network.network, operationId: record.admission?.operationId ?? "" },
      }),
    );
    if (Result.isFailure(isolated)) throw isolated.failure;
    return isolated.success;
  };
  return { run, prepare, dispatched, log: () => receiverLog, hosted, real, layer, launch, target };
};

describe("Boat guest wire contract: Core, relay and receiver", () => {
  it("walks every route in the shared list through Core's builders, the relay and the receiver entry", async () => {
    const g = await guest({});
    const isolated = await g.prepare();
    const permitted = await g.run((execution) =>
      execution.permit(contractTarget, {
        resourceReceipt: isolated.receipt,
        tunnelReceipt: "c".repeat(64),
      }),
    );
    expect(Result.isSuccess(permitted)).toBe(true);
    expect(
      await g.run((execution) => execution.start(contractTarget.runtimeInstanceId)),
    ).toMatchObject({
      _tag: "Success",
      success: "running",
    });
    expect(Result.isSuccess(await g.run((execution) => execution.readiness(contractTarget)))).toBe(
      true,
    );
    expect(Result.isSuccess(await g.run((execution) => execution.hold(contractTarget)))).toBe(true);
    // Before this contract, the relay answered 404 here and FINAL close never reached the guest.
    expect(await g.run((execution) => execution.recover(contractTarget))).toMatchObject({
      _tag: "Success",
      success: "running",
    });
    const parked = await g.run((execution) => execution.park(contractTarget, randomUUID()));
    // The real parking handler ran and refused this unprivileged test process as its writer.
    expect(parked).toMatchObject({
      _tag: "Failure",
      failure: {
        code: "receiver-refused",
        diagnostic: {
          provider: { operation: "receiver-park", status: 409 },
          receiver: {
            pathClass: "/sealant/bootstrap/park",
            reason: "parking-source-outside-slice",
          },
        },
      },
    });
    const names = receiverRoutes.routes.map((route) => route.name);
    expect([...new Set(await g.dispatched())].toSorted()).toEqual(names.toSorted());
    expect([...boatReceiverRoutes.keys()].toSorted()).toEqual(names.toSorted());
  }, 30_000);

  it("delivers a guest policy refusal to Core as a classified, non-retryable reason", async () => {
    // The real limits() reads systemd's slice properties, finds none here and refuses.
    const g = await guest({ kernelLimits: true });
    const isolated = await g.prepare();
    const refused = await g.run((execution) =>
      execution.permit(contractTarget, {
        resourceReceipt: isolated.receipt,
        tunnelReceipt: "c".repeat(64),
      }),
    );
    if (Result.isSuccess(refused)) throw new Error("permit unexpectedly passed");
    expect(refused.failure).toBeInstanceOf(BoatExecutionError);
    expect(refused.failure).toMatchObject({
      code: "receiver-refused",
      diagnostic: {
        code: "receiver-refused",
        provider: { operation: "receiver-permit", status: 409 },
        receiver: {
          pathClass: "/sealant/bootstrap/permit",
          reason: "workspace-limits-unavailable",
        },
      },
    });
    // The worker retries only transport loss.
    expect(refused.failure).not.toMatchObject({ code: "transport-unavailable" });
    // The guest journal keeps it too.
    expect(g.log()).toContain('"error": "workspace-limits-unavailable"');
    // The runtime row's errorMessage is the adapter summary of the readiness failure.
    const row = new BoatAdapterError(
      "launch-held",
      boatLaunchDiagnostic(
        new BoatReadinessError("unavailable", boatLaunchDiagnostic(refused.failure, "readiness")),
        "readiness",
      ),
    ).message;
    expect(row).toContain('"reason":"workspace-limits-unavailable"');
    expect(row).toContain('"code":"receiver-refused"');
  }, 30_000);

  it("waits out a receiver operation longer than the relay's idle cutoff", async () => {
    const g = await guest({ delays: { permit: 7 } });
    const isolated = await g.prepare();
    const began = Date.now();
    const permitted = await g.run((execution) =>
      execution.permit(contractTarget, {
        resourceReceipt: isolated.receipt,
        tunnelReceipt: "c".repeat(64),
      }),
    );
    expect(Date.now() - began).toBeGreaterThan(6_500);
    expect(Result.isSuccess(permitted)).toBe(true);
  }, 30_000);

  it("classifies the relay's authentication refusal as permanent", async () => {
    const g = await guest({});
    await expect(g.real.call(g.hosted, secret("b".repeat(64)), "status")).rejects.toMatchObject({
      code: "receiver-unauthorized",
      diagnostic: { provider: { operation: "receiver-status", status: 401 } },
    });
  }, 30_000);
  it("retries a lost DNS answer through the real peer, transport and worker readiness loop", async () => {
    // The reviewer's repro: one UDP answer goes missing while the worker observes readiness.
    // Query 1 belongs to permit; query 2 is readiness's first attempt.
    const dns = await resolver([2]);
    const consumer = randomUUID();
    const publicationId = randomUUID();
    const workerTarget: BoatExecutionTarget = {
      deploymentId: "contract",
      workspaceId: "workspace",
      runId: consumer,
      runtimeInstanceId: consumer,
      launchAttemptId: randomUUID(),
      sourceId: publicationId,
      sandboxId: "bx_3456789a",
      diskLineage: randomUUID(),
      bootId: contractTarget.bootId,
      manifestDigest: "a".repeat(64),
    };
    const hash = "a".repeat(64);
    const runtime = {
      source: `ghcr.io/sealant-sh/sealantd-next:test@sha256:${hash}`,
      platform: "linux/amd64",
      manifest: hash,
      sealantd: hash,
      socat: hash,
      relay: hash,
    };
    const allocation = boatAllocationRecordSchema.parse({
      input: {
        deploymentId: workerTarget.deploymentId,
        workspaceId: workerTarget.workspaceId,
        consumer: { runId: consumer, runtimeInstanceId: consumer },
        launchAttemptId: workerTarget.launchAttemptId,
        publication: nativePublicationSchema.parse({
          kind: "boat-native",
          publicationId,
          snapshot: {
            kind: "boat-saved-snapshot",
            owner: publicationId,
            build: randomUUID(),
            recipeHash: hash,
            receiptHash: hash,
            runtime,
            identity: {
              name: `contract-${publicationId}`,
              sourceSandboxId: "bx_23456789",
              createdAt: "2026-11-09T00:00:00Z",
              snapshotId: "contract-image",
            },
          },
          evidence: {
            imageProbe: {
              version: 1,
              tools: {
                sudo: true,
                sudoSetuid: true,
                useradd: true,
                groupadd: true,
                setfacl: true,
                getfacl: true,
                setpriv: true,
              },
              sudoersMend: true,
              sudoersIncludesDir: true,
              noNewPrivileges: false,
              passwdWritable: true,
              mendGroup: "present",
              reservedIdsInUse: [],
              personEnv: true,
              sharedDirs: [],
              sealantd: null,
            },
            receiptHash: hash,
            receipt: "synthetic",
            runtime,
            assetsHash: hash,
            recipeHash: hash,
            daemonRecovery: "unknown",
            executorRecovery: "unverified",
          },
        }),
        scope: { kind: "owner", ownerUserId: "usr_contract" },
        sourceKind: "capture",
      },
      idempotencyKey: randomUUID(),
      diskLineage: workerTarget.diskLineage,
      manifestDigest: workerTarget.manifestDigest,
      phase: "bound",
      sandboxId: workerTarget.sandboxId,
      conflictingSandboxes: [],
      target: workerTarget,
      reason: null,
    });
    const g = await guest({ dnsPort: dns.port, target: workerTarget });
    const guestReceipt = await g.prepare();
    // Only the stores and the host gateway are fixtures; the worker's own launch and retry run.
    const readiness = boatReadinessLayerNoDeps.pipe(
      Layer.provide(
        Layer.mergeAll(
          g.layer,
          Layer.mock(BoatAllocationRepo)({
            get: () => Effect.succeed(allocation),
            isActive: () => Effect.succeed(true),
          }),
          Layer.mock(WorkspaceCaptureDrainRepo)({ getByRunId: () => Effect.succeed(undefined) }),
          Layer.mock(BoatResources)({
            prepare: () =>
              Effect.succeed({
                guest: guestReceipt,
                gateway: {
                  container: "gateway",
                  containerId: "gateway-id",
                  gatewayEpoch: "1",
                  binding: hash,
                  publicKey: "gateway",
                  peerKey: "peer",
                  listenPort: 40000,
                  reachSubnet: "10.98.0.0/27",
                  gateway: "100.127.255.253",
                  client: "100.127.255.254",
                  receipt: "c".repeat(64),
                  peerHandshake: "unverified",
                },
              }),
          }),
        ),
      ),
    );
    const launched = await Effect.runPromise(
      Effect.flatMap(BoatReadiness, (worker) =>
        worker.launch(workerTarget, Redacted.make(g.launch)),
      ).pipe(Effect.provide(readiness), Effect.result),
    );
    if (Result.isFailure(launched)) throw launched.failure;
    // One lost attempt, then the successful pair that brackets Core's daemon probe.
    expect((await g.dispatched()).filter((route) => route === "readiness")).toHaveLength(3);
    expect(g.log().match(/"error": "tunnel-dns-unavailable"/g)).toHaveLength(1);
    expect(dns.queries()).toBeGreaterThanOrEqual(3);
    expect(g.log()).toContain('"error": "tunnel-dns-unavailable"');
  }, 60_000);
});
