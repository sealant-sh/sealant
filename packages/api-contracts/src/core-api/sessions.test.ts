import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  createSessionAsUserRequestSchema,
  createSessionRequestSchema,
  SESSION_ARGV_MAX_TOTAL_BYTES,
  SESSION_ARGV_MAX_WORD_BYTES,
  SESSION_ARGV_MAX_WORDS,
} from "./sessions.js";

const request = (argv: readonly string[]) => ({
  workspaceId: "wks_1",
  ownerUserId: "usr_alice",
  argv,
});

const decode = Schema.decodeUnknownResult(createSessionRequestSchema);

const accepted = (argv: readonly string[]) => {
  const result = decode(request(argv));
  if (!Result.isSuccess(result)) throw new Error(String(result.failure));
  return result.success.argv;
};

const refusal = (argv: readonly string[]): string => {
  const result = decode(request(argv));
  if (!Result.isFailure(result)) throw new Error("expected a refusal");
  return String(result.failure);
};

describe("a session's argv", () => {
  it("takes an argument that starts with whitespace", () => {
    const argv = ["bash", "-lc", "\n echo hi"];
    expect(accepted(argv)).toEqual(argv);
    expect(accepted(["printf", "%s", "  padded  "])).toEqual(["printf", "%s", "  padded  "]);
  });

  it("takes a multi-line argument", () => {
    const script = "set -e\ncd /workspace/repo\n\tgit status --short\necho done\n";
    expect(accepted(["bash", "-lc", script])).toEqual(["bash", "-lc", script]);
  });

  it("takes an empty argument", () => {
    expect(accepted(["git", "commit", "--allow-empty", "-m", ""])).toEqual([
      "git",
      "commit",
      "--allow-empty",
      "-m",
      "",
    ]);
    expect(accepted(["sh", "-c", "echo $#", "", " "])).toEqual(["sh", "-c", "echo $#", "", " "]);
  });

  it("still refuses a program that is empty or not trimmed", () => {
    for (const program of ["", " bash", "bash ", "\nbash", "bash\n"]) {
      expect(refusal([program, "-lc", "echo hi"])).toContain(
        "argv[0], the program, must be non-empty with no leading or trailing whitespace",
      );
    }
    expect(refusal([])).toContain("argv is empty");
  });

  it("refuses an argument with a NUL byte, which no process can receive", () => {
    expect(refusal(["printf", "a\u0000b"])).toContain("argv[1] contains a NUL byte");
  });

  it("holds at most 64 words", () => {
    const words = Array.from({ length: SESSION_ARGV_MAX_WORDS - 1 }, () => "");
    expect(accepted(["true", ...words])).toHaveLength(SESSION_ARGV_MAX_WORDS);
    expect(refusal(["true", ...words, ""])).toContain(
      `argv has ${SESSION_ARGV_MAX_WORDS + 1} words; the maximum is ${SESSION_ARGV_MAX_WORDS}`,
    );
  });

  it("holds at most 128 KiB per word, counted in UTF-8 bytes", () => {
    expect(SESSION_ARGV_MAX_WORD_BYTES).toBe(131_072);
    const atLimit = "x".repeat(SESSION_ARGV_MAX_WORD_BYTES);
    expect(accepted(["bash", "-lc", atLimit])).toHaveLength(3);
    expect(refusal(["bash", "-lc", `${atLimit}x`])).toContain(
      `argv[2] is ${SESSION_ARGV_MAX_WORD_BYTES + 1} bytes; the maximum per word is ${SESSION_ARGV_MAX_WORD_BYTES}`,
    );
    // Two bytes each in UTF-8: half as many characters reach the limit.
    const wide = "é".repeat(SESSION_ARGV_MAX_WORD_BYTES / 2 + 1);
    expect(refusal(["bash", "-lc", wide])).toContain(
      `argv[2] is ${SESSION_ARGV_MAX_WORD_BYTES + 2} bytes`,
    );
  });

  it("holds at most 1 MiB in all, the program included", () => {
    expect(SESSION_ARGV_MAX_TOTAL_BYTES).toBe(1_048_576);
    const word = "x".repeat(SESSION_ARGV_MAX_WORD_BYTES);
    // "bash" (4 bytes), seven full words and the rest of the total.
    const atTotal = ["bash", ...Array.from({ length: 7 }, () => word), "x".repeat(131_068)];
    expect(accepted(atTotal)).toHaveLength(9);
    const overTotal = [...atTotal.slice(0, -1), "x".repeat(131_069)];
    expect(refusal(overTotal)).toContain(
      `argv totals ${SESSION_ARGV_MAX_TOTAL_BYTES + 1} bytes; the maximum is ${SESSION_ARGV_MAX_TOTAL_BYTES}`,
    );
  });

  it("never quotes an argument's text in a refusal", () => {
    const secret = "ghp_secretTokenValue";
    for (const argv of [
      [" bash", secret],
      ["printf", `${secret}\u0000`],
      ["bash", "-lc", `${secret}${"x".repeat(SESSION_ARGV_MAX_WORD_BYTES)}`],
      ["true", ...Array.from({ length: SESSION_ARGV_MAX_WORDS }, () => secret)],
    ]) {
      expect(refusal(argv)).not.toContain(secret);
    }
  });

  it("applies the same rule to a session as a user", () => {
    const decodeAsUser = Schema.decodeUnknownResult(createSessionAsUserRequestSchema);
    const asUser = (argv: readonly string[]) =>
      decodeAsUser({ ...request(argv), user: "m4lice000" });
    expect(Result.isSuccess(asUser(["bash", "-lc", "\n echo hi", ""]))).toBe(true);
    expect(Result.isFailure(asUser([" bash", "-lc", "echo hi"]))).toBe(true);
  });
});
