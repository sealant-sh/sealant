/**
 * Unit tests for the run-exec message codec — the three framings (`command` = harness, `commands` =
 * exec/check run, `dotfiles` = a person's dotfiles applied as their user) must round-trip and malformed messages must be rejected before they reach the
 * worker (a bad message dead-letters instead of poisoning the consumer).
 */
import { describe, expect, it } from "vitest";

import {
  parseRunExecAsUserRequestedMessage,
  parseRunExecRequestedMessage,
  runExecAsUserRequestedMessageKind,
  runExecQueueName,
  runExecRequestEnvelope,
  runExecRequestedMessageKind,
  sharedConcurrencyLimit,
} from "./run-exec-queue.js";

const base = { kind: runExecRequestedMessageKind, runId: "run_1" };

describe("parseRunExecRequestedMessage", () => {
  it("parses the harness framing (single command)", () => {
    const parsed = parseRunExecRequestedMessage({
      ...base,
      command: { executable: "opencode", args: ["run", "fix it"], cwd: "/workspace/repo" },
    });
    expect(parsed).toEqual({
      ...base,
      command: { executable: "opencode", args: ["run", "fix it"], cwd: "/workspace/repo" },
    });
    expect(parsed.commands).toBeUndefined();
  });

  it("parses the exec framing (ordered command list) and preserves order", () => {
    const parsed = parseRunExecRequestedMessage({
      ...base,
      commands: [
        { executable: "git", args: ["checkout", "base"] },
        { executable: "pnpm", args: ["test"], cwd: "/workspace/repo/pkg" },
      ],
    });
    expect(parsed.command).toBeUndefined();
    expect(parsed.commands).toEqual([
      { executable: "git", args: ["checkout", "base"] },
      { executable: "pnpm", args: ["test"], cwd: "/workspace/repo/pkg" },
    ]);
  });

  it("rejects a message with neither framing", () => {
    expect(() => parseRunExecRequestedMessage(base)).toThrow(/missing\/invalid command/);
  });

  it("rejects an empty commands list", () => {
    expect(() => parseRunExecRequestedMessage({ ...base, commands: [] })).toThrow(
      /non-empty array/,
    );
  });

  it("rejects a malformed entry inside the commands list, naming its index", () => {
    expect(() =>
      parseRunExecRequestedMessage({
        ...base,
        commands: [
          { executable: "git", args: ["status"] },
          { executable: "", args: [] },
        ],
      }),
    ).toThrow(/commands\[1\]/);
  });

  it("rejects a wrong kind or missing runId", () => {
    expect(() =>
      parseRunExecRequestedMessage({ kind: "other", runId: "run_1", command: {} }),
    ).toThrow(/unexpected kind/);
    expect(() =>
      parseRunExecRequestedMessage({
        kind: runExecRequestedMessageKind,
        command: { executable: "x", args: [] },
      }),
    ).toThrow(/missing runId/);
  });

  it("parses the dotfiles framing: a user, a home, a staged directory and a repository", () => {
    const parsed = parseRunExecRequestedMessage({
      ...base,
      dotfiles: {
        user: "m4lice000",
        home: "/home/m4lice000",
        archiveDir: "/run/sealant-dotfiles/run_1",
        repository: { url: "https://github.com/acme/dots.git", manager: "stow" },
      },
    });
    expect(parsed.command).toBeUndefined();
    expect(parsed.commands).toBeUndefined();
    expect(parsed.dotfiles).toEqual({
      user: "m4lice000",
      home: "/home/m4lice000",
      archiveDir: "/run/sealant-dotfiles/run_1",
      // A bootstrap runs unless the repository says not to, as at create.
      repository: { url: "https://github.com/acme/dots.git", manager: "stow", bootstrap: true },
    });
  });

  it("rejects a dotfiles framing with nothing to apply, no user, or an unknown manager", () => {
    expect(() =>
      parseRunExecRequestedMessage({ ...base, dotfiles: { user: "m", home: "/home/m" } }),
    ).toThrow(/repository or an archive directory/);
    expect(() =>
      parseRunExecRequestedMessage({ ...base, dotfiles: { home: "/home/m", archiveDir: "/x" } }),
    ).toThrow(/user/);
    expect(() =>
      parseRunExecRequestedMessage({
        ...base,
        dotfiles: { user: "m", home: "/home/m", repository: { url: "u", manager: "yadm" } },
      }),
    ).toThrow(/manager is unknown/);
  });

  it("refuses any message on the legacy queue that names a user", () => {
    const commands = [{ executable: "id", args: [] }];
    for (const extra of [
      { user: "m4lice000" },
      { user: "m4lice000", checkedExecutorRunId: "run_1" },
      { checkedExecutorRunId: "run_1" },
    ]) {
      expect(() => parseRunExecRequestedMessage({ ...base, commands, ...extra })).toThrow(
        /workspace-run-exec-as-user/,
      );
    }
    expect(() =>
      parseRunExecRequestedMessage({
        ...base,
        command: { executable: "opencode", args: [] },
        user: "m4lice000",
      }),
    ).toThrow(/never here/);
  });
});

describe("a run as a user (the as-user queue)", () => {
  const commands = [{ executable: "id", args: [] }];
  const asUser = {
    kind: runExecAsUserRequestedMessageKind,
    runId: "run_1",
    commands,
    user: "m4lice000",
    checkedExecutorRunId: "run_launch",
  };

  it("goes on its own queue, with its own kind; every other run as before", () => {
    const envelope = runExecRequestEnvelope({
      runId: "run_1",
      commands,
      user: "m4lice000",
      checkedExecutorRunId: "run_launch",
    });
    expect(envelope.queue.name).toBe("workspace-run-exec-as-user");
    expect(envelope.queue.name).not.toBe(runExecQueueName);
    expect(envelope.message).toEqual(asUser);
    const plain = runExecRequestEnvelope({ runId: "run_1", commands });
    expect(plain.queue.name).toBe(runExecQueueName);
    expect(plain.message).toEqual({ kind: runExecRequestedMessageKind, runId: "run_1", commands });
    expect(() => runExecRequestEnvelope({ runId: "run_1", commands, user: "m4lice000" })).toThrow(
      /checked executor/,
    );
  });

  it("is refused by a worker from before it: the legacy parser rejects its kind", () => {
    // A worker that predates `user` consumes only `workspace-run-exec`, and its parser (this one,
    // whose kind check is unchanged) refuses the kind: the run is never started as root.
    expect(() => parseRunExecRequestedMessage(asUser)).toThrow(/unexpected kind/);
  });

  it("parses with a user in range and the executor checked, and refuses anything else", () => {
    expect(parseRunExecAsUserRequestedMessage(asUser)).toEqual(asUser);
    for (const bad of [
      { ...asUser, user: "root" },
      { ...asUser, user: "0" },
      { ...asUser, user: "1000" },
      { ...asUser, user: undefined },
      { ...asUser, checkedExecutorRunId: undefined },
      { ...asUser, commands: [] },
      { ...asUser, kind: runExecRequestedMessageKind },
      { ...asUser, command: { executable: "opencode", args: [] } },
    ]) {
      expect(() => parseRunExecAsUserRequestedMessage(bad)).toThrow();
    }
  });
});

describe("sharedConcurrencyLimit (both run-exec queues)", () => {
  it("runs at most its permits at once across every caller, the rest in order", async () => {
    const limit = sharedConcurrencyLimit(2);
    let running = 0;
    let most = 0;
    const order: number[] = [];
    const releases: Array<() => void> = [];
    const task = (id: number) =>
      limit(async () => {
        running += 1;
        most = Math.max(most, running);
        order.push(id);
        await new Promise<void>((resolve) => releases.push(resolve));
        running -= 1;
      });
    // As if the legacy queue and the as-user queue each took two jobs.
    const all = Promise.all([task(1), task(2), task(3), task(4)]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual([1, 2]);
    while (releases.length > 0 || order.length < 4) {
      releases.shift()?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await all;
    expect(most).toBe(2);
    expect(order).toEqual([1, 2, 3, 4]);
  });

  it("frees a permit when a task fails", async () => {
    const limit = sharedConcurrencyLimit(1);
    await expect(limit(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await limit(() => Promise.resolve("next"))).toBe("next");
    expect(() => sharedConcurrencyLimit(0)).toThrow();
  });
});
