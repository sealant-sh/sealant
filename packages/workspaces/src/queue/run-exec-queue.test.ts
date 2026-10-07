/**
 * Unit tests for the run-exec message codec — the three framings (`command` = harness, `commands` =
 * exec/check run, `dotfiles` = a person's dotfiles applied as their user) must round-trip and malformed messages must be rejected before they reach the
 * worker (a bad message dead-letters instead of poisoning the consumer).
 */
import { describe, expect, it } from "vitest";

import { parseRunExecRequestedMessage, runExecRequestedMessageKind } from "./run-exec-queue.js";

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

  it("carries the exec framing's user, and refuses root, a uid outside the range and a misplaced user", () => {
    const commands = [{ executable: "id", args: [] }];
    expect(parseRunExecRequestedMessage({ ...base, commands, user: "m4lice000" })).toEqual({
      ...base,
      commands,
      user: "m4lice000",
    });
    expect(parseRunExecRequestedMessage({ ...base, commands }).user).toBeUndefined();
    for (const user of ["root", "0", "1000", "a b", ""]) {
      expect(() => parseRunExecRequestedMessage({ ...base, commands, user })).toThrow();
    }
    expect(() =>
      parseRunExecRequestedMessage({
        ...base,
        command: { executable: "opencode", args: [] },
        user: "m4lice000",
      }),
    ).toThrow(/only the exec framing/);
  });
});
