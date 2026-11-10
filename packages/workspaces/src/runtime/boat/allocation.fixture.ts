import {
  constants,
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
import type { BoatAgentReply, BoatAgentRoute, BoatGuestTransport } from "./execution.js";
const secret = (value: string) => {
  const result = BoatSecret.parse(value);
  if (!result.ok) throw result.error;
  return result.value;
};
export class ProviderFixture {
  state: BoatSandbox["state"] = "running";
  hydrated = true;
  bootId = randomUUID();
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
              : [this.sandbox()],
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
      reply({
        ok: true,
        exitCode: 0,
        timedOut: false,
        stdout: this.bootId + "\n",
        stderr: "",
      });
      return;
    }
    send({ code: "not_found" }, 404);
  }
}
/** What the fake agent answers a recovery with: a typed outcome, or a refusal reason (409). */
export type GuestRecoveryAnswer =
  | "running"
  | "restarted"
  | "nothing-to-save"
  | "recover-new-boot"
  | "recover-binding-conflict"
  | "recover-state-unknown"
  | "parked";
/**
 * A fake of the agent as Core's transport sees it: the bind exchange answers the bootstrap wire
 * with a fixed bearer, and each agent route answers the way `agent-contract.ts` says, with
 * switches named for the fault they inject. It records what Core sent, so tests can read the
 * launch body, the network intent and the order of calls.
 */
export class GuestFixture implements BoatGuestTransport {
  capsule = Buffer.from("faithful immutable capsule HTTP boundary");
  recovery: GuestRecoveryAnswer = "running";
  /** Answer recovery with a body that matches no contract shape. */
  malformedRecovery = false;
  /** How many launches the agent accepted (its launch record is per boot: at most one). */
  starts = 0;
  readonly actions: string[] = [];
  /** Runs before the health observation readiness starts with. */
  beforeReady: () => Promise<void> = async () => {};
  /** The agent's health answer in place of the one its launch record gives, when it returns one. */
  health: () => BoatAgentReply | undefined = () => undefined;
  /** Runs before each launch push is answered. */
  beforeLaunch: () => Promise<void> = async () => {};
  async probe() {
    return {
      runtimeId: "rt_fixture",
      healthy: true,
      supports: ["exec.user", "dotfiles.user", "restore.owner_map", "process.secret-env.v1"],
    };
  }
  /** Every launch body the agent was pushed, parsed. */
  readonly launches: Array<{
    version: number;
    runId: string;
    controlToken: string;
    bootEnv: Record<string, string>;
    secretEnvJson?: string | undefined;
    services?: unknown;
  }> = [];
  readonly targets: BoatExecutionTarget[] = [];
  fail = false;
  /** The next launch push is accepted by the agent, but its reply never reaches Core. */
  lostLaunchReply = false;
  target: BoatExecutionTarget | undefined;
  readonly networkBodies: string[] = [];
  lostIsolation = false;
  beforeIsolate: () => Promise<void> = async () => {};
  /** Runs before each bind is answered; a slow guest boot holds it. */
  beforeBind: () => Promise<void> = async () => {};
  async bind(target: BoatExecutionTarget, raw: unknown) {
    await this.beforeBind();
    if (this.fail) throw new Error("lost bind");
    this.targets.push(target);
    this.target = target;
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
  async request(
    _host: unknown,
    bearer: BoatSecret,
    route: BoatAgentRoute,
    body?: Redacted.Redacted<string>,
  ): Promise<BoatAgentReply> {
    this.actions.push(route);
    expect(bearer.reveal()).toBe("a".repeat(64));
    const raw = body === undefined ? "" : Redacted.value(body);
    if (route === "health") {
      await this.beforeReady();
      const answer = this.health();
      if (answer !== undefined) return answer;
      // Not booted until a launch was accepted: 503 with the agent's health body, as the agent.
      // A Docker launch answers the version 2 body with its service ready.
      const docker = this.launches.some((launch) => launch.version === 2);
      const common = { booted: this.starts > 0, controlSocket: this.starts > 0 };
      const health = docker
        ? {
            version: 2,
            ...common,
            services: { docker: { status: "ready", socket: "/run/docker/docker.sock" } },
          }
        : common;
      return { status: this.starts > 0 ? 200 : 503, body: health };
    }
    if (route === "network-status")
      return {
        status: 200,
        body: {
          configured: true,
          handshake: "verified",
          dns: "udp-and-tcp",
          // Where the containers' policy stands: applied once a Docker launch was accepted.
          docker_policy: this.launches.some((launch) => launch.version === 2)
            ? "applied"
            : "absent",
        },
      };
    if (route === "launch") {
      await this.beforeLaunch();
      const launch = z
        .object({
          version: z.number(),
          runId: z.string(),
          controlToken: z.string(),
          bootEnv: z.record(z.string(), z.string()),
          secretEnvJson: z.string().optional(),
          services: z.unknown().optional(),
        })
        .parse(JSON.parse(raw));
      expect(launch.controlToken).toBe(bearer.reveal());
      if (this.starts > 0) return { status: 409, body: { message: "already booted" } };
      this.starts = 1;
      this.launches.push(launch);
      if (this.lostLaunchReply) {
        this.lostLaunchReply = false;
        throw new Error("lost hosted launch reply");
      }
      return { status: 200, body: { outcome: "booting" } };
    }
    if (route === "network") {
      await this.beforeIsolate();
      this.networkBodies.push(raw);
      if (this.lostIsolation) {
        this.lostIsolation = false;
        throw new Error("lost");
      }
      return {
        status: 200,
        body: {
          format: "sealant-guest-network-status-v1",
          binding: z.object({ binding: z.unknown() }).parse(JSON.parse(raw)).binding,
          receipt: "e".repeat(64),
          configured: true,
          handshake: "unverified",
        },
      };
    }
    if (route === "recover") {
      if (this.malformedRecovery) return { status: 200, body: { outcome: "whatever" } };
      if (this.recovery === "running" || this.recovery === "restarted")
        return { status: 200, body: { outcome: this.recovery } };
      if (this.recovery === "nothing-to-save")
        return {
          status: 200,
          body: {
            outcome: "nothing-to-save",
            basis: "daemon",
            detail: "sealant boot: nothing to save: never materialized (/workspace/repo)",
          },
        };
      return { status: 409, body: { reason: this.recovery } };
    }
    return { status: 404, body: { message: "unknown route" } };
  }
}
export class GatewayFixture {
  subnetUnavailable = false;
  beforeSubnet: () => Promise<void> = async () => {};
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
      if (!this.allowRemoval) return Effect.die("reconciliation must not remove the gateway");
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
