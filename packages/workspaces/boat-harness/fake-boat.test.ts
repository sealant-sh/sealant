import { afterEach, describe, expect, it } from "vitest";

import type { DockerResult } from "./docker.js";
import { FakeBoat } from "./fake-boat.js";

const ok = (stdout = ""): DockerResult => ({ code: 0, stdout, stderr: "", timedOut: false });
const credential = "test-only-credential";
const input = {
  type: "small",
  ttlSeconds: null,
  noEnv: true,
  monitoring: false,
  snapshots: true,
  labels: { "sealant-run": "unit" },
};

let boat: FakeBoat | undefined;
afterEach(async () => {
  await boat?.stop();
  boat = undefined;
});

/** A fake Boat whose guests are answered by a scripted docker CLI. */
const start = async (
  options: { clock?: () => number; trialAccount?: boolean; deletionWithdrawnMs?: number } = {},
) => {
  const commands: string[][] = [];
  boat = new FakeBoat({
    runId: "abc12345",
    credential,
    network: "unit",
    baseImage: "unit-base",
    docker: async (args) => {
      commands.push([...args]);
      if (args.includes("is-system-running")) return ok("running\n");
      if (args[0] === "inspect") return ok("192.0.10.5\n");
      return ok();
    },
    ...options,
  });
  await boat.start();
  const url = boat.baseUrl;
  const call = async (
    path: string,
    method = "GET",
    body?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const response = await fetch(url + path, {
      method,
      headers: {
        Authorization: `Bearer ${credential}`,
        "Content-Type": "application/json",
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  return { call, commands };
};

const idle = async (call: Awaited<ReturnType<typeof start>>["call"], id: string) => {
  for (let tries = 0; tries < 50; tries++) {
    if ((await call(`/sandboxes/${id}`)).body.sandbox.state === "idle") return;
    await new Promise((done) => setTimeout(done, 20));
  }
  throw new Error("never idle");
};

describe("fake Boat API", () => {
  it("replays an idempotency key for 24 hours, then forgets it", async () => {
    let now = 1_000_000;
    const { call } = await start({ clock: () => now });
    const first = await call("/sandboxes", "POST", input, { "Idempotency-Key": "same" });
    expect(first.status).toBe(202);
    expect(first.body.sandbox.state).toBe("provisioned");
    now += 23 * 60 * 60_000;
    expect(
      (await call("/sandboxes", "POST", input, { "Idempotency-Key": "same" })).body.sandbox.id,
    ).toBe(first.body.sandbox.id);
    now += 2 * 60 * 60_000;
    const later = await call("/sandboxes", "POST", input, { "Idempotency-Key": "same" });
    expect(later.status).toBe(202);
    expect(later.body.sandbox.id).not.toBe(first.body.sandbox.id);
  });

  it("enforces Boat's label limits", async () => {
    const { call } = await start();
    const many = Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`key${index}`, "v"]));
    expect(
      (await call("/sandboxes", "POST", { ...input, labels: many }, { "Idempotency-Key": "a" }))
        .status,
    ).toBe(400);
    const long = { key: "x".repeat(257) };
    expect(
      (await call("/sandboxes", "POST", { ...input, labels: long }, { "Idempotency-Key": "b" }))
        .status,
    ).toBe(400);
  });

  it("needs the confirm header to delete, and accepts a deletion with 202 and an operation", async () => {
    const { call } = await start();
    const id = (await call("/sandboxes", "POST", input, { "Idempotency-Key": "d" })).body.sandbox
      .id;
    await idle(call, id);
    expect((await call(`/sandboxes/${id}`, "DELETE")).status).toBe(400);
    const deletion = await call(`/sandboxes/${id}`, "DELETE", undefined, {
      "X-Ascii-Confirm-Delete": id,
    });
    expect(deletion.status).toBe(202);
    expect(deletion.body.operation).toMatchObject({
      kind: "sandbox",
      targetId: id,
      status: "pending",
    });
  });

  it("withdraws a deleted VM from the API at once, and completes its operation later", async () => {
    const { call } = await start({ deletionWithdrawnMs: 400 });
    const id = (await call("/sandboxes", "POST", input, { "Idempotency-Key": "w" })).body.sandbox
      .id;
    await idle(call, id);
    const deletion = await call(`/sandboxes/${id}`, "DELETE", undefined, {
      "X-Ascii-Confirm-Delete": id,
    });
    const operation = `/deletion-operations/${deletion.body.operation.id}`;
    await new Promise((done) => setTimeout(done, 200));
    expect((await call(`/sandboxes/${id}`)).status).toBe(404);
    expect((await call("/sandboxes")).body.sandboxes).toEqual([]);
    expect(
      (await call(`/sandboxes/${id}/commands`, "POST", { command: "true", timeoutSeconds: 5 }))
        .status,
    ).toBe(404);
    expect(
      (await call(`/sandboxes/${id}`, "DELETE", undefined, { "X-Ascii-Confirm-Delete": id }))
        .status,
    ).toBe(404);
    expect((await call(operation)).body.operation.status).toBe("processing");
    expect(boat?.liveSandboxes().map((sandbox) => sandbox.id)).toEqual([id]);
    await new Promise((done) => setTimeout(done, 500));
    expect((await call(operation)).body.operation.status).toBe("completed");
    expect(boat?.liveSandboxes()).toEqual([]);
  });

  it("can accept a DELETE and drop its reply; a second DELETE answers the same operation", async () => {
    const { call } = await start();
    const id = (await call("/sandboxes", "POST", input, { "Idempotency-Key": "l" })).body.sandbox
      .id;
    await idle(call, id);
    const fake = boat;
    if (fake === undefined) throw new Error("no fake Boat");
    let lost = 0;
    fake.faults.deleteReply = () => (lost++ === 0 ? "lose" : undefined);
    // Never withdrawn: the second DELETE reaches the VM whatever the timing.
    fake.faults.deletion = () => "stuck";
    await expect(
      call(`/sandboxes/${id}`, "DELETE", undefined, { "X-Ascii-Confirm-Delete": id }),
    ).rejects.toThrow();
    const [started] = fake.events.filter((event) => event.kind === "delete");
    expect(started).toMatchObject({ sandboxId: id });
    const again = await call(`/sandboxes/${id}`, "DELETE", undefined, {
      "X-Ascii-Confirm-Delete": id,
    });
    expect(again.status).toBe(202);
    expect(again.body.operation.id).toBe(started?.detail);
    expect(fake.events.filter((event) => event.kind === "delete")).toHaveLength(1);
  });

  it("requires resume's body fields", async () => {
    const { call } = await start();
    const id = (await call("/sandboxes", "POST", input, { "Idempotency-Key": "r" })).body.sandbox
      .id;
    await idle(call, id);
    expect((await call(`/sandboxes/${id}/resume`, "POST", {})).status).toBe(400);
    expect(
      (
        await call(`/sandboxes/${id}/resume`, "POST", {
          type: "small",
          ttlSeconds: null,
          noEnv: true,
        })
      ).status,
    ).toBe(202);
  });

  it("limits snapshot names to 63 characters and can refuse saved snapshots as a trial account", async () => {
    const full = await start();
    const id = (await full.call("/sandboxes", "POST", input, { "Idempotency-Key": "s" })).body
      .sandbox.id;
    await idle(full.call, id);
    expect(
      (await full.call("/saved-snapshots", "POST", { sandboxId: id, name: "a".repeat(64) })).status,
    ).toBe(400);
    expect(
      (await full.call("/saved-snapshots", "POST", { sandboxId: id, name: "a".repeat(63) })).status,
    ).toBe(202);
    await boat?.stop();
    const trial = await start({ trialAccount: true });
    const trialId = (await trial.call("/sandboxes", "POST", input, { "Idempotency-Key": "t" })).body
      .sandbox.id;
    await idle(trial.call, trialId);
    const refused = await trial.call("/saved-snapshots", "POST", {
      sandboxId: trialId,
      name: "kept",
    });
    expect(refused).toMatchObject({
      status: 403,
      body: {
        ok: false,
        code: "trial_saved_snapshots_not_allowed",
        error: { code: "trial_saved_snapshots_not_allowed", status: 403 },
        requestId: expect.stringMatching(/^req_/),
      },
    });
  });

  it("applies Boat's clone rewrites to a VM created from a saved snapshot, not to a fresh one", async () => {
    const { call, commands } = await start();
    const source = (await call("/sandboxes", "POST", input, { "Idempotency-Key": "c1" })).body
      .sandbox.id;
    await idle(call, source);
    expect(commands.some((args) => args.join(" ").includes("provider-systemd"))).toBe(false);
    await call("/saved-snapshots", "POST", { sandboxId: source, name: "saved" });
    for (
      let tries = 0;
      tries < 50 && (await call("/saved-snapshots/saved")).body.snapshot.status !== "ready";
      tries++
    )
      await new Promise((done) => setTimeout(done, 20));
    const clone = (
      await call("/sandboxes", "POST", { ...input, from: "saved" }, { "Idempotency-Key": "c2" })
    ).body.sandbox.id;
    await idle(call, clone);
    const rewrite = commands.find((args) => args.join(" ").includes("provider-systemd"));
    expect(rewrite?.join(" ")).toContain(
      "cp --remove-destination /var/lib/boat-twin/provider-systemd /usr/lib/systemd/systemd",
    );
    expect(rewrite?.join(" ")).toContain(`# boat-sandbox ${clone}`);
  });
});
