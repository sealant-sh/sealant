import { execFileSync, spawnSync } from "node:child_process";

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

const pageSize = (): number => Number(execFileSync("getconf", ["PAGESIZE"], { encoding: "utf8" }));

/** Starts `/bin/sh` with `word` as an argument and an empty environment, as `execve` takes it. */
const spawnWith = (word: string) =>
  spawnSync("/bin/sh", ["-c", "exit 0", word], { env: {}, stdio: "ignore" });

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

  it("holds at most 131,071 bytes per word, counted in UTF-8 bytes", () => {
    expect(SESSION_ARGV_MAX_WORD_BYTES).toBe(131_071);
    const atLimit = "x".repeat(SESSION_ARGV_MAX_WORD_BYTES);
    expect(accepted(["bash", "-lc", atLimit])).toHaveLength(3);
    expect(refusal(["bash", "-lc", `${atLimit}x`])).toContain(
      `argv[2] is ${SESSION_ARGV_MAX_WORD_BYTES + 1} bytes; the maximum per word is ${SESSION_ARGV_MAX_WORD_BYTES}`,
    );
    // Two bytes each in UTF-8: half as many characters pass the limit.
    const wide = "é".repeat((SESSION_ARGV_MAX_WORD_BYTES + 1) / 2);
    expect(refusal(["bash", "-lc", wide])).toContain(
      `argv[2] is ${SESSION_ARGV_MAX_WORD_BYTES + 1} bytes`,
    );
  });

  // Linux's MAX_ARG_STRLEN is 32 pages and counts the terminating NUL: on 4 KiB pages, the longest
  // word `execve` takes is exactly the limit, and one byte more fails with E2BIG.
  it.runIf(process.platform === "linux" && pageSize() === 4096)(
    "is the longest word execve takes on Linux",
    () => {
      const atLimit = spawnWith("x".repeat(SESSION_ARGV_MAX_WORD_BYTES));
      expect(atLimit.error).toBeUndefined();
      expect(atLimit.status).toBe(0);
      const overLimit = spawnWith("x".repeat(SESSION_ARGV_MAX_WORD_BYTES + 1));
      expect(overLimit.error).toMatchObject({ code: "E2BIG" });
    },
  );

  it("refuses a lone surrogate, which has no UTF-8 form", () => {
    expect(refusal(["printf", "a\ud800b"])).toContain(
      "argv[1] is not well-formed Unicode (a lone surrogate)",
    );
    expect(refusal(["printf", "%s", "\udc00"])).toContain("argv[2] is not well-formed Unicode");
    expect(accepted(["printf", "😀 é"])).toEqual(["printf", "😀 é"]);
  });

  it("holds at most 1 MiB in all, the program included", () => {
    expect(SESSION_ARGV_MAX_TOTAL_BYTES).toBe(1_048_576);
    const word = "x".repeat(SESSION_ARGV_MAX_WORD_BYTES);
    // "bash" (4 bytes), eight full words (1,048,568 bytes) and 4 bytes: exactly the total.
    const atTotal = ["bash", ...Array.from({ length: 8 }, () => word), "xxxx"];
    expect(accepted(atTotal)).toHaveLength(10);
    const overTotal = [...atTotal.slice(0, -1), "xxxxx"];
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
