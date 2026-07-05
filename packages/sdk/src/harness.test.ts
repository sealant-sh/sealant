import { describe, expect, it } from "vitest";

import { claudeCode, codex, customHarness, opencode } from "./harness.js";

describe("harness factories", () => {
  it("opencode runs one-shot as `opencode run <prompt>`", () => {
    const command = opencode().buildRunCommand("fix the test");
    expect(command).toEqual({ executable: "opencode", args: ["run", "fix the test"] });
  });

  it("codex and claude-code use their headless one-shot forms", () => {
    expect(codex().buildRunCommand("p").args).toEqual(["exec", "p"]);
    expect(claudeCode().buildRunCommand("p").args).toEqual(["-p", "p"]);
    expect(claudeCode({ profile: "review" }).buildRunCommand("p").args).toEqual([
      "--profile",
      "review",
      "-p",
      "p",
    ]);
  });

  it("customHarness is the bring-your-own escape hatch", () => {
    const harness = customHarness({ id: "mybot", invoke: (prompt) => ["go", prompt] });
    expect(harness.id).toBe("mybot");
    expect(harness.buildRunCommand("hello")).toEqual({
      executable: "mybot",
      args: ["go", "hello"],
    });
  });

  it("customHarness can override the executable", () => {
    const harness = customHarness({
      id: "mybot",
      executable: "/usr/local/bin/mybot",
      invoke: (p) => [p],
    });
    expect(harness.buildRunCommand("x").executable).toBe("/usr/local/bin/mybot");
  });
});
