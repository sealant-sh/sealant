import { describe, expect, it } from "vitest";

import { desiredAttachments, idleVerdict, reaches } from "./reach.js";
import { instanceRecord, linkedExecutor, postgresSpec } from "./resource.fixture.js";

const project = instanceRecord();
const mailW1 = instanceRecord({
  uuid: "11111111-1111-4111-8111-111111111111",
  spec: postgresSpec({ alias: "mail", worktreeKey: "w1" }),
});
const stopped = instanceRecord({
  uuid: "22222222-2222-4222-8222-222222222222",
  spec: postgresSpec({ alias: "cache" }),
  desired: "stopped",
  stopReason: { kind: "idle" },
});

describe("reaches", () => {
  it("lets every linked workspace reach a project instance, and only its worktree's reach a worktree instance", () => {
    const w1 = linkedExecutor("sealant-a", "w1");
    const w2 = linkedExecutor("sealant-b", "w2");
    expect([reaches(w1, project), reaches(w2, project)]).toEqual([true, true]);
    expect([reaches(w1, mailW1), reaches(w2, mailW1)]).toEqual([true, false]);
  });

  it("reaches only the level a link's map names for each alias", () => {
    const mailProject = instanceRecord({
      uuid: "33333333-3333-4333-8333-333333333333",
      spec: postgresSpec({ alias: "mail" }),
    });
    const own = linkedExecutor("sealant-a", "w1", undefined, { mail: "worktree", db: "project" });
    const shared = linkedExecutor("sealant-b", "w1", undefined, { mail: "project" });
    expect([reaches(own, mailW1), reaches(own, mailProject), reaches(own, project)]).toEqual([
      true,
      false,
      true,
    ]);
    // `db` is left out of this map, so the workspace does not reach it.
    expect([
      reaches(shared, mailW1),
      reaches(shared, mailProject),
      reaches(shared, project),
    ]).toEqual([false, true, false]);
  });

  it("never reaches another worktree's instance, whatever the map says", () => {
    const w2 = linkedExecutor("sealant-c", "w2", undefined, { mail: "worktree" });
    expect(reaches(w2, mailW1)).toBe(false);
  });

  it("never reaches another domain's instance", () => {
    const other = linkedExecutor("sealant-c", "w1", "rdm:99999999-9999-4999-8999-999999999999");
    expect(reaches(other, project)).toBe(false);
  });
});

describe("desiredAttachments", () => {
  it("joins each running instance to the reach network of each executor that reaches it", () => {
    const attachments = desiredAttachments(
      [linkedExecutor("sealant-a", "w1"), linkedExecutor("sealant-b", "w2")],
      [project, mailW1, stopped],
    );
    expect(attachments.map((attachment) => `${attachment.network} ${attachment.alias}`)).toEqual([
      "sealant-a-reach db",
      "sealant-a-reach mail",
      "sealant-b-reach db",
    ]);
  });

  it("gives an executor replacement its own network, beside the one it replaces", () => {
    const attachments = desiredAttachments(
      [linkedExecutor("sealant-old", "w1"), linkedExecutor("sealant-new", "w1")],
      [project],
    );
    expect(attachments.map((attachment) => attachment.network)).toEqual([
      "sealant-old-reach",
      "sealant-new-reach",
    ]);
  });

  it("attaches one container under an alias when a project and a worktree instance share it", () => {
    const mailProject = instanceRecord({
      uuid: "33333333-3333-4333-8333-333333333333",
      spec: postgresSpec({ alias: "mail" }),
    });
    const attachments = desiredAttachments(
      [linkedExecutor("sealant-a", "w1", undefined, { mail: "worktree" })],
      [mailProject, mailW1],
    );
    expect(attachments.map((attachment) => attachment.instanceId)).toEqual([mailW1.id]);
  });

  it("holds nothing when no executor is live", () => {
    expect(desiredAttachments([], [project, mailW1])).toEqual([]);
  });
});

describe("idleVerdict", () => {
  const started = new Date("2026-10-31T12:00:00.000Z");
  const at = (seconds: number) => new Date(started.getTime() + seconds * 1000);
  const running = instanceRecord({ startedAt: started });

  it("touches an instance a live executor reaches", () => {
    expect(idleVerdict(running, true, at(10_000))).toEqual({ kind: "reached" });
  });

  it("stops an unreached instance idleStopAfterSeconds after its start", () => {
    expect(idleVerdict(running, false, at(1799))).toEqual({ kind: "waiting", stopsAt: at(1800) });
    expect(idleVerdict(running, false, at(1800))).toEqual({ kind: "stop" });
  });

  it("counts from the last reach when it is later than the start", () => {
    const reached = instanceRecord({ startedAt: started, lastReachedAt: at(600) });
    expect(idleVerdict(reached, false, at(1800))).toEqual({ kind: "waiting", stopsAt: at(2400) });
    expect(idleVerdict(reached, false, at(2400))).toEqual({ kind: "stop" });
  });

  it("never stops an instance that has not started", () => {
    expect(idleVerdict(instanceRecord(), false, at(99_999)).kind).toBe("waiting");
  });
});
