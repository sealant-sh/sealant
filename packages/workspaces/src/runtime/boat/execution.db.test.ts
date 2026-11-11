import { randomUUID } from "node:crypto";

import { CredentialCipher, credentialCipherLayer } from "@sealant/credentials";
import {
  BoatExecutionRepo,
  BoatExecutionRepoLive,
  makeSealantDBLayer,
  SealantDB,
  user,
  workspaceAttempts,
} from "@sealant/db";
import { corruptBoatExecution } from "@sealant/db/testing/boat-executions";
import { withWorkspaceJobTestDatabase } from "@sealant/db/testing/workspace-publications";
import { boatExecutionTargetSchema, type BoatExecutionTarget } from "@sealant/validators";
import { Effect, Layer, Redacted } from "effect";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { GuestFixture } from "./allocation.fixture.js";
import {
  BoatExecution,
  BoatExecutionError,
  BoatGuestTransportService,
  boatExecutionLayer,
  boatExecutionRetryable,
  type BoatLaunchMaterial,
} from "./execution.js";
import { boatLaunchDiagnostic, boatLaunchSummary } from "./launch-diagnostics.js";

const databaseUrl = process.env.SEALANT_TEST_DATABASE_URL;
/** What the recovery sweep hands a recovery: the capture token the launch carried. */
const recoveryEnv = Redacted.make({ SEALANT_CAPTURE_TOKEN: "capture-version-one" });
const material = (version = "version-one"): Redacted.Redacted<BoatLaunchMaterial> =>
  Redacted.make({
    bootEnv: { SEALANT_WORKSPACE_SOURCE: "capture", TOKEN_VERSION: version },
    secretEnv: { SEALANT_CAPTURE_TOKEN: `capture-${version}` },
    pins: { credentialVersions: [{ id: "credential", version }], dotfiles: [] },
    docker: false,
  });
const receipts = { resourceReceipt: "e".repeat(64), tunnelReceipt: "f".repeat(64) };
const test = async (
  run: (context: {
    executor: BoatExecution["Service"];
    repo: BoatExecutionRepo["Service"];
    cipher: CredentialCipher["Service"];
    db: SealantDB["Service"];
    target: BoatExecutionTarget;
    guest: GuestFixture;
  }) => Promise<void>,
) => {
  if (databaseUrl === undefined) throw new Error("SEALANT_TEST_DATABASE_URL required");
  await withWorkspaceJobTestDatabase(databaseUrl, async (url) => {
    const guest = new GuestFixture();
    const Infra = Layer.mergeAll(
      makeSealantDBLayer(url),
      credentialCipherLayer({ key: Buffer.alloc(32, 7).toString("base64") }),
      Layer.succeed(BoatGuestTransportService, guest),
    );
    const Test = boatExecutionLayer.pipe(
      Layer.provideMerge(BoatExecutionRepoLive),
      Layer.provideMerge(Infra),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const executor = yield* BoatExecution;
        const repo = yield* BoatExecutionRepo;
        const cipher = yield* CredentialCipher;
        const db = yield* SealantDB;
        const runId = randomUUID();
        const owner = `usr_${randomUUID()}`;
        yield* db
          .insert(user)
          .values({ id: owner, name: "boat test", email: `${owner}@example.invalid` });
        yield* db.insert(workspaceAttempts).values({ id: runId, ownerUserId: owner });
        const target = boatExecutionTargetSchema.parse({
          deploymentId: "test",
          workspaceId: "workspace",
          runId,
          runtimeInstanceId: runId,
          launchAttemptId: "attempt",
          sourceId: "publication",
          sandboxId: "bx_23456789",
          diskLineage: "disk",
          bootId: randomUUID(),
          manifestDigest: "b".repeat(64),
        });
        yield* Effect.promise(() => run({ executor, repo, cipher, db, target, guest }));
      }).pipe(Effect.provide(Test)),
    );
  });
};
const execute = Effect.runPromise;
/** The agent's health, or the tunnel's status, as a readiness observation answers it. */
const health = (body: unknown) => (route: string) =>
  route === "health" ? { status: 503, body } : undefined;
const tunnel = (body: unknown) => (route: string) =>
  route === "network-status" ? { status: 200, body } : undefined;
const refusalReason = async (effect: Effect.Effect<unknown, unknown>) => {
  const failure = await execute(Effect.flip(effect));
  expect(failure).toBeInstanceOf(BoatExecutionError);
  const diagnostic = boatLaunchDiagnostic(failure, "readiness");
  expect(diagnostic.code).toBe("agent-refused");
  return diagnostic.agent?.reason;
};

describe.runIf(databaseUrl !== undefined)("durable Boat worker ownership", () => {
  it("pushes the sealed launch once as the agent contract names it, and adopts a lost reply", () =>
    test(async (context) => {
      const { executor, repo, target, guest } = context;
      await execute(executor.exchange(target));
      await execute(executor.stage(target.runId, material()));
      // No isolation receipts yet: nothing is pushed.
      await expect(execute(executor.launch(target.runId))).rejects.toThrow("invocation-held");
      expect((await execute(repo.get(target.runId)))?.phase).toBe("installed");
      await execute(executor.recordIsolation(target, receipts));
      guest.lostLaunchReply = true;
      await expect(execute(executor.launch(target.runId))).rejects.toThrow("transport-unavailable");
      expect((await execute(repo.get(target.runId)))?.phase).toBe("issued");
      // The agent accepted the first push (its launch record is durable): the retry adopts it.
      expect(await execute(executor.launch(target.runId))).toBe("running");
      expect(guest.starts).toBe(1);
      expect(guest.launches).toHaveLength(1);
      expect(guest.launches[0]).toEqual({
        version: 1,
        runId: target.runId,
        controlToken: "a".repeat(64),
        bootEnv: { SEALANT_WORKSPACE_SOURCE: "capture", TOKEN_VERSION: "version-one" },
        secretEnvJson: JSON.stringify({ SEALANT_CAPTURE_TOKEN: "capture-version-one" }),
      });
      const settled = await execute(repo.get(target.runId));
      expect(settled?.phase).toBe("running");
      expect(settled?.admission?.sealedEnvelope).toBeNull();
      expect(settled?.admission?.sealedResumeEnvelope).not.toBeUndefined();
      // Running: nothing is pushed again.
      expect(await execute(executor.launch(target.runId))).toBe("running");
      expect(guest.actions.filter((action) => action === "launch")).toHaveLength(2);
    }));
  it("asks for the Docker service only when the sealed material does", () =>
    test(async ({ executor, target, guest }) => {
      await execute(executor.exchange(target));
      await execute(
        executor.stage(
          target.runId,
          Redacted.make({ ...Redacted.value(material()), docker: true }),
        ),
      );
      await execute(executor.recordIsolation(target, receipts));
      await execute(executor.launch(target.runId));
      expect(guest.launches[0]).toMatchObject({ version: 2, services: { docker: "required" } });
      // Today's agent says nothing of a containers' network policy: a Docker image is ready on
      // its health and its tunnel alone.
      expect(guest.networkStatus).not.toHaveProperty("docker_policy");
      expect(await execute(executor.readiness(target))).toMatchObject({ handshake: "verified" });
      // An agent built before the policy was removed (a session started before the upgrade) still
      // reports one. Its status parses, and whatever it says is neither waited for nor a failure.
      const current = guest.networkStatus;
      for (const policy of ["absent", "pending", "applied", "failed"]) {
        guest.networkStatus = { ...current, docker_policy: policy };
        expect(await execute(executor.readiness(target)), policy).toMatchObject({
          handshake: "verified",
          dns: "udp-and-tcp",
        });
      }
      guest.networkStatus = current;
      const original = guest.request.bind(guest);
      // The engine answered but could not run a container (VM 131 run 7): what it is made of and
      // the run's error come with the diagnostic, redacted, so the failure says why.
      guest.request = async (...args) =>
        args[2] === "health"
          ? {
              status: 503,
              body: {
                version: 2,
                booted: true,
                controlSocket: true,
                services: {
                  docker: {
                    status: "failed",
                    reason: "container-probe-failed",
                    code: null,
                    signal: null,
                    output:
                      "containerd: /usr/local/bin/containerd containerd v2.1.4 on /run/sealant/docker-exec/containerd/containerd.sock\nsystem containerd socket: present\ncontainer probe: docker run failed:\nfailed to create TTRPC connection: unsupported protocol: Yunix",
                  },
                },
              },
            }
          : original(...args);
      const probe = await execute(Effect.flip(executor.readiness(target)));
      expect(boatLaunchDiagnostic(probe, "readiness")).toMatchObject({
        code: "guest-failed",
        check: "docker",
        guest: {
          service: "docker",
          reason: "container-probe-failed",
          outputTail: expect.stringContaining("unsupported protocol: Yunix"),
        },
      });
      expect(boatLaunchDiagnostic(probe, "readiness").guest?.outputTail).toContain(
        "system containerd socket: present",
      );
      expect(boatExecutionRetryable(probe)).toBe(false);
    }));
  it("observes readiness from the agent's health, the tunnel's handshake and the daemon", () =>
    test(async (context) => {
      const { executor, repo, target, guest } = context;
      await execute(context.executor.exchange(target));
      await execute(executor.stage(target.runId, material()));
      await execute(executor.recordIsolation(target, receipts));
      await expect(execute(executor.readiness(target))).rejects.toThrow("invocation-held");
      await execute(executor.launch(target.runId));
      const record = await execute(repo.get(target.runId));
      expect(await execute(executor.readiness(target))).toEqual({
        runtimeId: "rt_fixture",
        bootId: target.bootId,
        isolationReceipt: expect.stringMatching(/^[a-f0-9]{64}$/),
        handshake: "verified",
        dns: "udp-and-tcp",
        admission: "held",
      });
      expect(guest.actions.slice(-2)).toEqual(["health", "network-status"]);
      // A daemon exit reported by the agent fails the launch for good; a tunnel without its
      // handshake is not ready yet.
      const original = guest.request.bind(guest);
      guest.request = async (...args) =>
        args[2] === "health"
          ? {
              status: 503,
              body: {
                booted: true,
                controlSocket: false,
                daemonExit: {
                  code: 1,
                  signal: null,
                  // An older agent's output is not redacted: Core removes the launch's secrets too.
                  output: "sealantd boot: capture token capture-version-one refused\nexiting",
                },
              },
            }
          : original(...args);
      const exited = await execute(Effect.flip(executor.readiness(target)));
      expect(exited).toBeInstanceOf(BoatExecutionError);
      expect(boatLaunchDiagnostic(exited, "readiness")).toMatchObject({
        code: "guest-failed",
        guest: {
          service: "sealantd",
          exitCode: 1,
          outputTail: "sealantd boot: capture token [REDACTED] refused\nexiting",
        },
      });
      // Each not-ready answer names the check that did not pass, in the order they run: the
      // agent's health first (what is booted, its control socket), then the tunnel.
      const notReady = async (
        reply: (route: string) => { status: number; body: unknown } | undefined,
        check: string,
      ) => {
        guest.request = async (...args) => reply(args[2]) ?? original(...args);
        const failure = await execute(Effect.flip(executor.readiness(target)));
        expect(boatLaunchDiagnostic(failure, "readiness")).toMatchObject({
          code: "agent-not-ready",
          check,
        });
        expect(boatExecutionRetryable(failure)).toBe(true);
      };
      await notReady(health({ booted: false, controlSocket: false }), "booted");
      await notReady(health({ booted: true, controlSocket: false }), "control-socket");
      await notReady(
        tunnel({
          configured: false,
          handshake: "unverified",
          dns: "unavailable",
        }),
        "network",
      );
      await notReady(
        tunnel({
          configured: true,
          handshake: "unverified",
          dns: "unavailable",
        }),
        "handshake",
      );
      // The tunnel's counters come with a handshake that never came: sent and never answered is
      // the gateway's side (nothing reaches it). An older agent sends none, and still decodes.
      guest.request = async (...args) =>
        tunnel({
          configured: true,
          handshake: "unverified",
          dns: "unavailable",
          transfer: { sent: 444, received: 0 },
        })(args[2]) ?? original(...args);
      const silent = boatLaunchDiagnostic(
        await execute(Effect.flip(executor.readiness(target))),
        "readiness",
      );
      expect(silent).toMatchObject({
        code: "agent-not-ready",
        check: "handshake",
        tunnel: { sentBytes: 444, receivedBytes: 0 },
      });
      expect(boatLaunchSummary(silent)).toContain('"tunnel":{"sentBytes":444,"receivedBytes":0}');
      // The diagnostic also says whether Core's end of the carrier was attached.
      guest.request = async (...args) =>
        tunnel({
          configured: true,
          handshake: "unverified",
          dns: "unavailable",
          carriers: ["websocket"],
          carrier_attached: false,
        })(args[2]) ?? original(...args);
      expect(
        boatLaunchDiagnostic(await execute(Effect.flip(executor.readiness(target))), "readiness"),
      ).toMatchObject({ check: "handshake", tunnel: { carrierAttached: false } });
      guest.request = async (...args) =>
        tunnel({
          configured: true,
          handshake: "unverified",
          dns: "unavailable",
        })(args[2]) ?? original(...args);
      expect(
        boatLaunchDiagnostic(await execute(Effect.flip(executor.readiness(target))), "readiness"),
      ).not.toHaveProperty("tunnel");
      await notReady(
        tunnel({
          configured: true,
          handshake: "verified",
          dns: "unavailable",
        }),
        "dns",
      );
      // An older agent's word on a containers' policy changes nothing, on an image without Docker
      // either: with the handshake and DNS it is ready.
      for (const policy of ["absent", "pending", "applied", "failed"]) {
        guest.request = async (...args) =>
          tunnel({
            configured: true,
            handshake: "verified",
            dns: "udp-and-tcp",
            docker_policy: policy,
          })(args[2]) ?? original(...args);
        expect(await execute(executor.readiness(target)), policy).toMatchObject({
          runtimeId: "rt_fixture",
        });
      }
      // The hosted proxy's own 503 on the health route (its VM not ready) is no check's answer.
      guest.request = async (...args) =>
        args[2] === "health"
          ? { status: 503, body: { error: "port 8080 is not open" } }
          : original(...args);
      const proxied = await execute(Effect.flip(executor.readiness(target)));
      expect(boatLaunchDiagnostic(proxied, "readiness")).toMatchObject({
        code: "agent-not-ready",
        agent: { pathClass: "/sealant/health" },
      });
      expect(boatLaunchDiagnostic(proxied, "readiness").check).toBeUndefined();
      expect(boatExecutionRetryable(proxied)).toBe(true);
      guest.request = original;
      // The daemon's own health decides, as on a MicroVM: no capability list is asked of it.
      expect(await guest.probe()).toEqual({ runtimeId: "rt_fixture", healthy: true });
      expect(await execute(executor.readiness(target))).toMatchObject({ runtimeId: "rt_fixture" });
      guest.probe = async () => ({ runtimeId: "rt_fixture", healthy: false });
      await expect(execute(executor.readiness(target))).rejects.toThrow("invalid-reply");
      expect(await execute(repo.get(target.runId))).toEqual(record);
      await expect(
        execute(executor.readiness({ ...target, bootId: randomUUID() })),
      ).rejects.toThrow("target-mismatch");
    }));
  it("maps every recovery answer: running, restarted, nothing-to-save and the typed refusals", () =>
    test(async (context) => {
      const { executor, repo, target, guest, db } = context;
      await execute(executor.exchange(target));
      await expect(execute(executor.recover(target, recoveryEnv))).rejects.toThrow(
        "invocation-held",
      );
      await execute(executor.stage(target.runId, material()));
      await execute(executor.recordIsolation(target, receipts));
      await execute(executor.launch(target.runId));
      await expect(execute(executor.recover(target, recoveryEnv))).rejects.toThrow(
        "invocation-held",
      );
      await execute(executor.hold(target));
      const held = await execute(repo.get(target.runId));
      expect(await execute(executor.recover(target, recoveryEnv))).toBe("running");
      guest.recovery = "restarted";
      expect(await execute(executor.recover(target, recoveryEnv))).toBe("restarted");
      guest.recovery = "nothing-to-save";
      expect(await execute(executor.recover(target, recoveryEnv))).toEqual({
        outcome: "nothing-to-save",
        basis: "daemon",
        detail: "sealant boot: nothing to save: never materialized (/workspace/repo)",
      });
      for (const reason of [
        "recover-new-boot",
        "recover-binding-conflict",
        "recover-state-unknown",
      ] as const) {
        guest.recovery = reason;
        expect(await refusalReason(executor.recover(target, recoveryEnv))).toBe(reason);
      }
      guest.recovery = "running";
      guest.malformedRecovery = true;
      await expect(execute(executor.recover(target, recoveryEnv))).rejects.toThrow("invalid-reply");
      guest.malformedRecovery = false;
      await expect(
        execute(executor.recover({ ...target, bootId: randomUUID() }, recoveryEnv)),
      ).rejects.toThrow("target-mismatch");
      expect(await execute(repo.get(target.runId))).toEqual(held);
      // A held execution is fenced: the launch is never pushed again.
      await expect(execute(executor.launch(target.runId))).rejects.toThrow("invocation-held");
      expect(guest.starts).toBe(1);
      // The capture token is the caller's to hand over: without it nothing is asked of the agent.
      const asked = guest.actions.length;
      await expect(execute(executor.recover(target, Redacted.make({})))).rejects.toThrow(
        "invalid-input",
      );
      expect(guest.actions).toHaveLength(asked);
      // It no longer comes from the sealed resume envelope: one erased (Boat reported the VM
      // absent) changes nothing, and what the caller hands over is what the agent is sent.
      if (held?.admission == null) throw new Error("held admission");
      const { sealedResumeEnvelope: _erased, ...admission } = held.admission;
      await execute(corruptBoatExecution(db, target.runId, { ...held, admission }));
      expect(await execute(executor.recover(target, recoveryEnv))).toBe("running");
    }));
  it("delivers the same authenticated network intent after reply loss and refuses stale epochs, boots and replies", () =>
    test(async ({ executor, repo, target, guest }) => {
      await execute(executor.exchange(target));
      const input = {
        network: { epoch: 1, operationId: String(randomUUID()), subnet: "10.98.0.32/27" },
        privateKey: Redacted.make(Buffer.alloc(32, 4).toString("base64")),
        publicKey: Buffer.alloc(32, 5).toString("base64"),
        gatewayKey: Buffer.alloc(32, 6).toString("base64"),
      };
      await expect(execute(executor.isolate(target, input))).rejects.toThrow("invocation-held");
      await execute(executor.stage(target.runId, material()));
      const installed = await execute(repo.get(target.runId));
      if (installed?.admission === null || installed === undefined) throw new Error("no admission");
      input.network.operationId = installed.admission.operationId;
      guest.lostIsolation = true;
      await expect(execute(executor.isolate(target, input))).rejects.toThrow(
        "transport-unavailable",
      );
      expect(await execute(executor.isolate(target, input))).toEqual({
        receipt: "e".repeat(64),
        handshake: "unverified",
        admission: "held",
      });
      expect(new Set(guest.networkBodies).size).toBe(1);
      expect(await execute(repo.get(target.runId))).toEqual(installed);
      for (const changed of [{ epoch: 2 }, { operationId: randomUUID() }])
        await expect(
          execute(
            executor.isolate(target, { ...input, network: { ...input.network, ...changed } }),
          ),
        ).rejects.toThrow("target-mismatch");
      await expect(
        execute(executor.isolate({ ...target, bootId: randomUUID() }, input)),
      ).rejects.toThrow("target-mismatch");
      const original = guest.request.bind(guest);
      guest.request = async (...args) => {
        const reply = await original(...args);
        return args[2] === "network"
          ? { status: 200, body: { ...z.object({}).passthrough().parse(reply.body), binding: {} } }
          : reply;
      };
      await expect(execute(executor.isolate(target, input))).rejects.toThrow("invalid-reply");
      expect(guest.starts).toBe(0);
      expect(JSON.stringify(installed)).not.toContain(Redacted.value(input.privateKey));
    }));
  it("carries the tunnel over the agent's WebSocket, and refuses by name an agent that cannot", () =>
    test(async ({ executor, repo, target, guest }) => {
      await execute(executor.exchange(target));
      await execute(executor.stage(target.runId, material()));
      const installed = await execute(repo.get(target.runId));
      if (installed?.admission === null || installed === undefined) throw new Error("no admission");
      const input = {
        network: {
          epoch: 1,
          operationId: installed.admission.operationId,
          subnet: "10.98.0.32/27",
        },
        privateKey: Redacted.make(Buffer.alloc(32, 4).toString("base64")),
        publicKey: Buffer.alloc(32, 5).toString("base64"),
        gatewayKey: Buffer.alloc(32, 6).toString("base64"),
      };
      const bodies = () =>
        guest.networkBodies.map((raw) => z.record(z.string(), z.unknown()).parse(JSON.parse(raw)));
      // The one body there is: the keys, the subnet and the carrier. No address or port to dial.
      await execute(executor.isolate(target, input));
      expect(Object.keys(bodies()[0] ?? {}).toSorted()).toEqual([
        "binding",
        "carrier",
        "format",
        "gateway_key",
        "private_key",
        "public_key",
        "subnet",
      ]);
      expect(bodies()[0]).toMatchObject({ carrier: "websocket", subnet: "10.98.0.32/27" });
      // An agent from when a VM could also dial the gateway lists both: it is carried all the same.
      const current = guest.networkStatus;
      guest.networkStatus = { ...current, carriers: ["udp", "websocket"], docker_policy: "absent" };
      await execute(executor.isolate(target, input));
      expect(bodies()[1]).toEqual(bodies()[0]);
      // An agent that cannot carry the tunnel (it lists no carrier, or only the dialled one) is
      // refused by name, and nothing is sent to it: there is no other transport to fall back to.
      for (const carriers of [undefined, [], ["udp"]]) {
        const { carriers: _listed, ...older } = current;
        guest.networkStatus = carriers === undefined ? older : { ...older, carriers };
        const before = guest.networkBodies.length;
        const refused = await execute(Effect.flip(executor.isolate(target, input)));
        expect(refused).toBeInstanceOf(BoatExecutionError);
        expect(boatLaunchDiagnostic(refused, "readiness")).toMatchObject({
          code: "carrier-unavailable",
          resourceOperation: "isolate-guest",
        });
        expect(boatExecutionRetryable(refused)).toBe(false);
        expect(guest.networkBodies).toHaveLength(before);
      }
      guest.networkStatus = current;
      // Core's end connects to the agent's carrier route with the control token and hosted cookie.
      const connection = Redacted.value(await execute(executor.tunnel(target)));
      expect(connection.url).toMatch(/^wss:\/\/.+\/sealant\/tunnel$/);
      expect(connection.headers["Authorization"]).toMatch(/^Bearer [a-f0-9]{64}$/);
      expect(connection.headers["Cookie"]).toMatch(/^_port_auth=/);
    }));
  it("refuses another run claiming either the owned sandbox or disk before provider delivery", () =>
    test(async ({ executor, target, db, guest }) => {
      await execute(executor.exchange(target));
      for (const changed of [
        { sandboxId: "bx_3456789a", diskLineage: target.diskLineage },
        { sandboxId: target.sandboxId, diskLineage: "another-disk" },
      ]) {
        const runId = randomUUID();
        const owner = `usr_${randomUUID()}`;
        await execute(
          db
            .insert(user)
            .values({ id: owner, name: "collision", email: `${owner}@example.invalid` }),
        );
        await execute(db.insert(workspaceAttempts).values({ id: runId, ownerUserId: owner }));
        const next = boatExecutionTargetSchema.parse({
          ...target,
          ...changed,
          runId,
          runtimeInstanceId: runId,
        });
        await expect(execute(executor.exchange(next))).rejects.toThrow("target-conflict");
      }
      expect(guest.targets).toHaveLength(1);
    }));
  it("refuses duplicate pins before sealing anything", () =>
    test(async ({ executor, repo, target, guest }) => {
      await execute(executor.exchange(target));
      const original = Redacted.value(material());
      await expect(
        execute(
          executor.stage(
            target.runId,
            Redacted.make({
              ...original,
              pins: {
                ...original.pins,
                dotfiles: [
                  { name: "dotfiles", sha256: "f".repeat(64) },
                  { name: "dotfiles", sha256: "e".repeat(64) },
                ],
              },
            }),
          ),
        ),
      ).rejects.toThrow("invalid-input");
      expect(guest.actions).toEqual(["health"]);
      expect((await execute(repo.get(target.runId)))?.phase).toBe("control");
    }));
  it("seals before delivery, replays the same public exchange after reply loss, then erases its key", () =>
    test(async ({ executor, repo, target, guest, cipher }) => {
      const requests: string[] = [];
      const originalBind = guest.bind.bind(guest);
      let lost = true;
      guest.bind = async (bindTarget, raw) => {
        const record = await execute(repo.get(target.runId));
        expect(record?.sealedExchange).not.toBeNull();
        expect(record?.sealedControl).toBeNull();
        requests.push(JSON.stringify(raw));
        const reply = await originalBind(bindTarget, raw);
        if (lost) {
          lost = false;
          throw new Error("lost");
        }
        return reply;
      };
      await expect(execute(executor.exchange(target))).rejects.toThrow("transport-unavailable");
      const receipt = await execute(executor.exchange(target));
      expect(receipt).toMatch(/^[a-f0-9]{64}$/);
      // The exchange is proven with the bearer before it is sealed: health answered it.
      expect(guest.actions).toEqual(["health"]);
      const record = await execute(repo.get(target.runId));
      expect(record?.phase).toBe("control");
      expect(record?.sealedExchange).toBeNull();
      expect(requests).toHaveLength(2);
      expect(requests[0]).toBe(requests[1]);
      expect(JSON.stringify(record)).not.toContain("a".repeat(64));
      expect(requests.join("")).not.toContain("a".repeat(64));
      if (!record?.sealedControl) throw new Error("missing control");
      const opened = await execute(cipher.decrypt(record.sealedControl));
      expect(opened).toContain("a".repeat(64));
      // A replay after the commit is a no-op that answers the same binding receipt.
      expect(await execute(executor.exchange(target))).toBe(receipt);
      expect(requests).toHaveLength(2);
    }));
  it("retries the bind proof while the hosted proxy answers for an agent not listening yet", () =>
    test(async ({ executor, repo, target, guest }) => {
      // A fresh VM: the agent's unit starts after the network is online, so the proxy answers
      // its first health requests with a 503 of its own (never the agent's health body).
      const original = guest.request.bind(guest);
      let proxied = 2;
      guest.request = async (...args) => {
        if (args[2] === "health" && proxied > 0) {
          proxied -= 1;
          guest.actions.push("health");
          return { status: 503, body: { error: "port 8080 is not open" } };
        }
        return original(...args);
      };
      const receipt = await execute(executor.exchange(target));
      expect(receipt).toMatch(/^[a-f0-9]{64}$/);
      expect(guest.actions).toEqual(["health", "health", "health"]);
      expect((await execute(repo.get(target.runId)))?.phase).toBe("control");
    }));
  it("refuses a mismatched bind reply, and a bind refusal is typed, before committing control", () =>
    test(async ({ executor, repo, target, guest }) => {
      const originalBind = guest.bind.bind(guest);
      guest.bind = async (bindTarget, raw) => {
        const reply = await originalBind(bindTarget, raw);
        return {
          ...reply,
          identity: {
            ...z.object({}).passthrough().parse(reply.identity),
            instance_id: "bx_other",
          },
        };
      };
      await expect(execute(executor.exchange(target))).rejects.toThrow("invalid-reply");
      expect((await execute(repo.get(target.runId)))?.phase).toBe("exchange");
      guest.bind = async () => {
        throw new BoatExecutionError("agent-refused", {
          step: "bind-exchange",
          errorClass: "BoatExecutionError",
          code: "agent-refused",
          command: { exitCode: 1, timedOut: false, stderrTail: "bind-manifest-mismatch" },
        });
      };
      await expect(execute(executor.exchange(target))).rejects.toThrow("agent-refused");
      expect((await execute(repo.get(target.runId)))?.phase).toBe("exchange");
    }));
  it("freezes the first sealed material; later callers with newer material change nothing", () =>
    test(async ({ executor, repo, target, guest }) => {
      await execute(executor.exchange(target));
      const results = await Promise.allSettled([
        execute(executor.stage(target.runId, material("one"))),
        execute(executor.stage(target.runId, material("two"))),
      ]);
      expect(results.some((result) => result.status === "fulfilled")).toBe(true);
      for (const result of results)
        if (result.status === "rejected")
          expect(String(result.reason)).toContain("stale-transition");
      const installed = await execute(repo.get(target.runId));
      expect(installed?.phase).toBe("installed");
      expect(JSON.stringify(installed)).not.toContain("version-");
      await execute(executor.stage(target.runId, material("three")));
      expect(await execute(repo.get(target.runId))).toEqual(installed);
      await execute(executor.recordIsolation(target, receipts));
      await execute(executor.launch(target.runId));
      // What the agent received is the first sealed material, whichever caller won.
      expect(["one", "two"]).toContain(guest.launches[0]?.bootEnv["TOKEN_VERSION"]);
    }));
  it("freezes isolation receipts once and refuses a changed set", () =>
    test(async ({ executor, repo, target }) => {
      await execute(executor.exchange(target));
      await execute(executor.stage(target.runId, material()));
      await execute(executor.recordIsolation(target, receipts));
      expect((await execute(repo.get(target.runId)))?.isolation).toEqual(receipts);
      await execute(executor.recordIsolation(target, receipts));
      await expect(
        execute(executor.recordIsolation(target, { ...receipts, tunnelReceipt: "a".repeat(64) })),
      ).rejects.toThrow("stale-transition");
    }));
  it("never adopts a refused launch as accepted, and refuses fresh target identities on the same disk", () =>
    test(async (context) => {
      const { executor, repo, target, guest } = context;
      await execute(executor.exchange(target));
      await execute(executor.stage(target.runId, material()));
      await execute(executor.recordIsolation(target, receipts));
      // "Already booted" (a `message`) is the only 409 that adopts a launch. A `{reason}`, which
      // an agent from before the park route was removed could answer, is no acceptance.
      guest.request = async () => ({ status: 409, body: { reason: "parked" } });
      await expect(execute(executor.launch(target.runId))).rejects.toThrow("invalid-reply");
      expect((await execute(repo.get(target.runId)))?.phase).toBe("issued");
      expect(guest.starts).toBe(0);
      for (const changed of [
        { bootId: randomUUID() },
        { diskLineage: "another" },
        { launchAttemptId: "fresh" },
      ])
        await expect(execute(executor.exchange({ ...target, ...changed }))).rejects.toThrow(
          "target-mismatch",
        );
      await execute(executor.hold(target));
      await expect(execute(executor.launch(target.runId))).rejects.toThrow("invocation-held");
    }));
  it("rejects swapped encrypted purposes and malformed persisted state", () =>
    test(async ({ executor, repo, target, db }) => {
      await execute(executor.exchange(target));
      await execute(executor.stage(target.runId, material()));
      const record = await execute(repo.get(target.runId));
      if (record?.admission === null || record === undefined) throw new Error("no admission");
      await execute(
        corruptBoatExecution(db, target.runId, {
          ...record,
          admission: { ...record.admission, sealedEnvelope: record.sealedControl },
        }),
      );
      await execute(executor.recordIsolation(target, receipts));
      await expect(execute(executor.launch(target.runId))).rejects.toThrow("seal-context-mismatch");
      await execute(corruptBoatExecution(db, target.runId, { ...record, phase: "nonsense" }));
      await expect(execute(repo.get(target.runId))).rejects.toThrow("invalid-record");
    }));
});
