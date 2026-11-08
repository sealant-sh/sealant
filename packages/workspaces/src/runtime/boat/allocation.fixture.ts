import {
  constants,
  createHash,
  createPrivateKey,
  createPublicKey,
  publicEncrypt,
  randomUUID,
} from "node:crypto";
import http from "node:http";

import type { BoatAllocationInput, BoatExecutionTarget } from "@sealant/validators";
import { Effect, Redacted } from "effect";
import { expect } from "vitest";
import { z } from "zod";

import {
  BoatTunnelError,
  boatTunnelName,
  type BoatTunnelInput,
  type BoatTunnelEndpoint,
} from "../../resources/boat-tunnel.js";
import type { BoatSandbox } from "./api.js";
import { BoatSecret } from "./config.js";
import type { BoatGuestTransport } from "./execution.js";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const secret = (value: string) => {
  const result = BoatSecret.parse(value);
  if (!result.ok) throw result.error;
  return result.value;
};
export class ProviderFixture {
  state: BoatSandbox["state"] = "running";
  hydrated = true;
  bootId = randomUUID();
  childBootId = randomUUID();
  parking = false;
  saveLost = false;
  recoveryCreateLost = false;
  corruptCapsule = false;
  stopped = false;
  saved:
    | {
        name: string;
        sourceSandboxId: string;
        snapshotId: string;
        status: "ready";
        createdAt: string;
      }
    | undefined;
  readonly savedRecords = new Map<string, NonNullable<ProviderFixture["saved"]>>();
  capsule = Buffer.from("faithful immutable capsule HTTP boundary");
  saves = 0;
  retirements = 0;
  retirementLost = false;
  rebinds = 0;
  childLabels: Record<string, string> | undefined;
  sandboxMissing = false;
  beforeSandboxRead: () => Promise<void> = async () => {};
  deleteCalls = 0;
  deletionReads = 0;
  deletionCompleted = true;
  deletionForeign = false;
  deletionWrongId = false;
  deleteLost = false;
  deletionUnavailable = false;
  readonly deletionId = `bdop_${randomUUID().replaceAll("-", "")}`;
  beforeDeletion: () => Promise<void> = async () => {};
  deletion(targetId = "bx_23456789") {
    return {
      id: this.deletionWrongId
        ? "bdop_00000000000000000000000000000000"
        : targetId === "bx_23456789"
          ? this.deletionId
          : "bdop_11111111111111111111111111111111",
      kind: "sandbox",
      targetId: this.deletionForeign ? "bx_3456789a" : targetId,
      status: this.deletionCompleted ? "completed" : "processing",
    };
  }

  readonly creates: Array<{ key: string | undefined; body: Record<string, unknown> }> = [];
  readonly commands: string[] = [];
  readonly commandResults = new Map<number, { exitCode: number; stdout: string; stderr: string }>();
  readonly reads: string[] = [];
  labels: Record<string, string> | undefined;
  lostCreate = false;
  noAllocation = false;
  conflict = false;
  scheduled = false;
  foreign = false;
  inventoryUnavailable = false;
  snapshotMismatch = false;
  bootReadUnavailable = false;
  beforeCreateReply: () => Promise<void> = async () => {};
  constructor(readonly input: BoatAllocationInput) {}
  sandbox(id = "bx_23456789") {
    return {
      id,
      state: this.state,
      labels: this.foreign ? { ...this.labels, "sealant-run": "foreign" } : this.labels,
      archiveAfter: this.scheduled ? "2026-11-07T00:00:00Z" : null,
      ttlSeconds: this.scheduled ? 900 : null,
      snapshots: true,
      monitoring: false,
      hydrated: this.hydrated,
      ...(this.stopped ? { stop: { status: "completed" } } : {}),
      ...(id === "bx_3456789a" ? { labels: this.childLabels } : {}),
    };
  }
  async serve(request: http.IncomingMessage, response: http.ServerResponse) {
    const url = new URL(request.url ?? "/", "http://fixture");
    const send = (value: unknown, status = 200) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(value));
    };
    let raw = "";
    for await (const part of request) raw += String(part);
    if (request.method === "POST" && url.pathname === "/api/v1/sandboxes") {
      const body = z.record(z.string(), z.unknown()).parse(JSON.parse(raw));
      const header = request.headers["idempotency-key"];
      this.creates.push({ key: typeof header === "string" ? header : undefined, body });
      if (this.parking && this.creates.length > 1) {
        this.childLabels = z.record(z.string(), z.string()).parse(body.labels);
        if (this.recoveryCreateLost) {
          response.destroy();
          return;
        }
        send({ ok: true, sandbox: this.sandbox("bx_3456789a") });
        return;
      }
      if (!this.noAllocation) this.labels = z.record(z.string(), z.string()).parse(body.labels);
      await this.beforeCreateReply();
      if (this.lostCreate) {
        response.destroy();
        return;
      }
      send({ ok: true, sandbox: this.sandbox() });
      return;
    }
    this.reads.push(url.pathname);
    const processId = Number(url.pathname.match(/\/commands\/(\d+)$/)?.[1]);
    if (request.method === "GET" && this.commandResults.has(processId)) {
      send({
        ok: true,
        processId,
        status: "exited",
        running: false,
        ...this.commandResults.get(processId),
      });
      return;
    }
    if (this.parking) {
      if (url.pathname === "/api/v1/saved-snapshots") {
        if (request.method === "POST") {
          const body = z.object({ name: z.string(), sandboxId: z.string() }).parse(JSON.parse(raw));
          this.saves++;
          this.saved = {
            name: body.name,
            sourceSandboxId: body.sandboxId,
            snapshotId: "immutable-parking-file-" + this.saves,
            status: "ready",
            createdAt: "2026-11-08T00:00:00Z",
          };
          this.savedRecords.set(this.saved.name, this.saved);
          if (this.saveLost) {
            response.destroy();
            return;
          }
          send({ ok: true, snapshot: this.saved });
        } else
          send({
            ok: true,
            snapshots: [...this.savedRecords.values()],
            allowance: {
              org: null,
              included: 10,
              used: this.savedRecords.size,
              extra: 0,
              extraDailyDollars: 0,
            },
          });
        return;
      }
      if (/^\/api\/v1\/snapshots\/immutable-parking-file-\d+\/files$/.test(url.pathname)) {
        response.writeHead(200, { "Content-Type": "application/octet-stream" });
        response.end(this.corruptCapsule ? Buffer.from("wrong preserved bytes") : this.capsule);
        return;
      }
      if (url.pathname.endsWith("/stop")) {
        this.stopped = true;
        send({ ok: true });
        return;
      }
      const savedRecord = this.savedRecords.get(
        decodeURIComponent(url.pathname.split("/").at(-1) ?? ""),
      );
      if (savedRecord !== undefined) {
        if (request.method === "DELETE") {
          this.retirements++;
          const name = savedRecord.name;
          this.savedRecords.delete(name);
          this.saved = undefined;
          if (this.retirementLost) {
            response.destroy();
            return;
          }
          send({ ok: true, name, status: "deleted" });
          return;
        }
        send({ ok: true, snapshot: savedRecord });
        return;
      }
      if (url.pathname === "/api/v1/sandboxes/bx_3456789a" && request.method === "DELETE") {
        this.deleteCalls++;
        send({ ok: true, operation: this.deletion("bx_3456789a") });
        return;
      }
      if (url.pathname === "/api/v1/sandboxes/bx_3456789a") {
        send({ ok: true, sandbox: this.sandbox("bx_3456789a") });
        return;
      }
    }

    if (url.pathname.startsWith("/api/v1/saved-snapshots/")) {
      send({
        ok: true,
        snapshot: {
          ...this.input.publication.snapshot.identity,
          status: "ready",
          ...(this.snapshotMismatch ? { sourceSandboxId: "bx_456789ab" } : {}),
        },
      });
      return;
    }
    if (url.pathname === "/api/v1/sandboxes") {
      if (this.inventoryUnavailable) {
        send({ code: "rate_limited" }, 429);
        return;
      }
      // The exact match appears only on the second page, alongside an irrelevant first page.
      const second = url.searchParams.get("cursor") === "next";
      send({
        ok: true,
        sandboxes: !second
          ? [{ ...this.sandbox("bx_56789abc"), labels: { "sealant-run": "foreign" } }]
          : this.labels === undefined
            ? []
            : this.conflict
              ? [this.sandbox(), this.sandbox("bx_6789abcd")]
              : [
                  this.sandbox(),
                  ...(this.childLabels === undefined ? [] : [this.sandbox("bx_3456789a")]),
                ],
        pageInfo: { hasMore: !second, nextCursor: second ? null : "next", limit: 200 },
      });
      return;
    }
    if (request.method === "DELETE" && url.pathname === "/api/v1/sandboxes/bx_23456789") {
      this.deleteCalls++;
      await this.beforeDeletion();
      if (this.deleteLost) {
        response.destroy();
        return;
      }
      send({ ok: true, operation: this.deletion() });
      return;
    }
    if (url.pathname.startsWith("/api/v1/deletion-operations/")) {
      this.deletionReads++;
      if (this.deletionUnavailable) {
        send({ code: "unavailable" }, 503);
        return;
      }
      send({ ok: true, operation: this.deletion() });
      return;
    }
    if (url.pathname === "/api/v1/sandboxes/bx_23456789") {
      await this.beforeSandboxRead();
      if (this.sandboxMissing) {
        send({ code: "not_found" }, 404);
        return;
      }
      send({ ok: true, sandbox: this.sandbox() });
      return;
    }
    if (url.pathname.endsWith("/commands")) {
      if (this.bootReadUnavailable) {
        send({ code: "unavailable" }, 503);
        return;
      }
      const { command, detached } = z
        .object({ command: z.string(), detached: z.boolean().optional() })
        .parse(JSON.parse(raw));
      const reply = (result: {
        ok: boolean;
        exitCode: number;
        timedOut: boolean;
        stdout: string;
        stderr: string;
      }) => {
        if (detached) {
          const startedPid = 1234 + this.commandResults.size;
          this.commandResults.set(startedPid, result);
          send({ ok: true, processId: startedPid });
        } else send(result);
      };
      this.commands.push(command);
      if (command.includes("guest_boot.py resume ")) {
        this.rebinds++;
        const reboundRequest = z
          .object({
            boot_id: z.string(),
            identity: z.unknown(),
            operation_id: z.string(),
            capsule: z.unknown(),
          })
          .parse(JSON.parse(command.slice(command.indexOf(" resume '") + 9, -1)));
        reply({
          ok: true,
          exitCode: 0,
          timedOut: false,
          stderr: "",
          stdout: JSON.stringify({
            format: "sealant-parking-rebound-v1",
            boot_id: reboundRequest.boot_id,
            identity: reboundRequest.identity,
            operation_id: reboundRequest.operation_id,
            capsule: reboundRequest.capsule,
            admission: "held",
          }),
        });
        return;
      }
      reply({
        ok: true,
        exitCode: 0,
        timedOut: false,
        stdout: (url.pathname.includes("bx_3456789a") ? this.childBootId : this.bootId) + "\n",
        stderr: "",
      });
      return;
    }
    send({ code: "not_found" }, 404);
  }
}
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([key, v]) => JSON.stringify(key) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value) ?? "null";
};
export class GuestFixture implements BoatGuestTransport {
  capsule = Buffer.from("faithful immutable capsule HTTP boundary");
  recovery: "running" | "issued" | "ended" | "unresolved" = "running";
  wrongRecoveryBinding = false;
  starts = 0;
  permitCount = 0;
  readonly actions: string[] = [];
  beforePermit: () => Promise<void> = async () => {};
  beforeReady: () => Promise<void> = async () => {};

  async probe() {
    return {
      runtimeId: "rt_fixture",
      healthy: true,
      supports: ["exec.user", "dotfiles.user", "restore.owner_map", "process.secret-env.v1"],
    };
  }
  readonly stageBodies: string[] = [];
  readonly targets: BoatExecutionTarget[] = [];
  fail = false;
  target: BoatExecutionTarget | undefined;
  admission: { epoch: number; operation_id: string } | undefined;
  readonly networkBodies: string[] = [];
  lostIsolation = false;
  beforeIsolate: () => Promise<void> = async () => {};
  async bind(target: BoatExecutionTarget, raw: unknown) {
    if (this.fail) throw new Error("lost bind");
    this.targets.push(target);
    this.target = target;
    this.admission = undefined;
    this.starts = 0;
    const request = z
      .object({
        format: z.string(),
        identity: z.unknown(),
        boot_id: z.string(),
        operation_id: z.string(),
        public_key: z.string(),
        manifest_digest: z.string(),
      })
      .parse(raw);
    const label = JSON.stringify([
      request.format,
      target.deploymentId,
      target.sandboxId,
      target.diskLineage,
      target.bootId,
      request.operation_id,
      target.manifestDigest,
    ]);
    return {
      format: "sealant-bootstrap-reply-v1",
      identity: request.identity,
      boot_id: target.bootId,
      operation_id: request.operation_id,
      admission: "held",
      boot: { status: "compatible" },
      ciphertext: publicEncrypt(
        {
          key: request.public_key,
          padding: constants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: "sha256",
          oaepLabel: Buffer.from(label),
        },
        Buffer.from("a".repeat(64)),
      ).toString("base64"),
    };
  }
  beforeHost: () => Promise<void> = async () => {};
  async host() {
    await this.beforeHost();
    return { origin: "https://fixture-8080.on.boat.dev", cookie: secret("test-cookie-local-only") };
  }
  async call(_host: unknown, bearer: BoatSecret, route: string, body?: Redacted.Redacted<string>) {
    this.actions.push(route);
    if (route === "park") {
      const request: unknown = JSON.parse(Redacted.value(body ?? Redacted.make("")));
      return {
        format: "sealant-parking-status-v1",
        request,
        phase: "closed",
        writers: "closed",
        capsule: {
          sha256: "a".repeat(64),
          archive_sha256: createHash("sha256").update(this.capsule).digest("hex"),
          bytes: 3,
          stored_bytes: this.capsule.length,
          entries: 1,
        },
      };
    }
    if (route === "recover") {
      const request = z
        .object({ binding: z.unknown() })
        .parse(JSON.parse(Redacted.value(body ?? Redacted.make(""))));
      return {
        format: "sealant-capture-recovery-status-v1",
        binding: request.binding,
        execution: this.recovery,
        mode: this.recovery === "running" ? "original" : "recovery",
        ...(this.wrongRecoveryBinding ? { binding: {} } : {}),
      };
    }
    if (route === "stage") {
      this.stageBodies.push(Redacted.value(body ?? Redacted.make("")));
      this.admission = z
        .object({ epoch: z.number(), operation_id: z.string() })
        .parse(JSON.parse(Redacted.value(body ?? Redacted.make(""))));
    }
    if (route === "isolate") {
      await this.beforeIsolate();
      const raw = Redacted.value(body ?? Redacted.make(""));
      this.networkBodies.push(raw);
      if (this.lostIsolation) {
        this.lostIsolation = false;
        throw new Error("lost");
      }
      return {
        format: "sealant-guest-network-status-v1",
        binding: z.object({ binding: z.unknown() }).parse(JSON.parse(raw)).binding,
        receipt: "e".repeat(64),
        configured: true,
        handshake: "unverified",
        admission: "held",
      };
    }
    if (route === "permit" || route === "readiness") {
      const raw = Redacted.value(body ?? Redacted.make(""));
      const value = z
        .object({ binding: z.unknown(), permit_receipt: z.string().optional() })
        .parse(JSON.parse(raw));
      if (route === "permit") {
        this.permitCount++;
        await this.beforePermit();
        return {
          format: "sealant-execution-permitted-v1",
          binding: value.binding,
          receipt: hash(canonical(JSON.parse(raw))),
          handshake: "verified",
          dns: "udp-and-tcp",
          admission: "held",
        };
      }
      await this.beforeReady();
      return {
        format: "sealant-readiness-status-v1",
        binding: value.binding,
        permit_receipt: value.permit_receipt,
        invocation: "d".repeat(32),
        limits: { memory_bytes: 2147483648, cpu_millicores: 1000, tasks: 512 },
        handshake: "verified",
        dns: "udp-and-tcp",
        admission: "held",
      };
    }
    if (route === "start") this.starts = 1;
    expect(["status", "stage", "start"]).toContain(route);
    expect(bearer.reveal()).toBe("a".repeat(64));
    if (this.target === undefined) throw new Error("missing target");
    return {
      format: "sealant-receiver-status-v1",
      identity: {
        deployment_id: this.target.deploymentId,
        instance_id: this.target.sandboxId,
        disk_lineage: this.target.diskLineage,
      },
      boot_id: this.target.bootId,
      admission: "held",
      execution: this.starts > 0 ? "running" : "unavailable",
      epoch: this.admission?.epoch ?? null,
      operation_id: this.admission?.operation_id ?? null,
      stage: this.admission === undefined ? "empty" : "installed",
    };
  }
}
export class GatewayFixture {
  allowRemoval = false;
  removalUnavailable = false;
  removeCalls = 0;
  beforeRemove: () => Promise<void> = async () => {};
  receipt = "c".repeat(64);
  readonly requests: BoatTunnelInput[] = [];
  unavailable = false;
  beforeReply: () => Promise<void> = async () => {};
  async ensure(input: BoatTunnelInput): Promise<BoatTunnelEndpoint> {
    this.requests.push(input);
    await this.beforeReply();
    if (this.unavailable) throw new Error("unknown gateway outcome");
    const publicKey = createPublicKey(
      createPrivateKey({
        key: Buffer.concat([
          Buffer.from("302e020100300506032b656e04220420", "hex"),
          Buffer.from(Redacted.value(input.privateKey), "base64"),
        ]),
        type: "pkcs8",
        format: "der",
      }),
    )
      .export({ type: "spki", format: "der" })
      .subarray(-32)
      .toString("base64");
    return {
      container: boatTunnelName(input.target),
      containerId: "a".repeat(64),
      gatewayEpoch: "epoch",
      binding: "b".repeat(64),
      publicKey,
      peerKey: input.peerKey,
      listenPort: input.listenPort,
      reachSubnet: "10.98.0.32/27",
      gateway: "100.127.255.253",
      client: "100.127.255.254",
      receipt: this.receipt,
      peerHandshake: "unverified",
    };
  }
  remove() {
    return Effect.suspend(() => {
      if (!this.allowRemoval) return Effect.die("reconciliation must not remove custody");
      this.removeCalls++;
      return Effect.promise(() => this.beforeRemove()).pipe(
        Effect.andThen(() =>
          this.removalUnavailable
            ? Effect.fail(new BoatTunnelError("gateway-unavailable"))
            : Effect.void,
        ),
      );
    });
  }
}
