/**
 * Harness factories. Each returns a thin `Harness` value: an id plus how to invoke it one-shot
 * against a prompt.
 *
 * NOTE — the one-shot invocation forms below (`opencode run <prompt>`, `codex exec <prompt>`,
 * `claude -p <prompt>`) are the expected headless shapes but are PENDING live verification against
 * the baked sandbox image (see the SDK plan's task #2, "verify harness one-shot CLI semantics").
 * Until that is confirmed, only `opencode()` is exercised end-to-end; the others are provided for the
 * typed surface and adjusted once verified.
 */
import type { Harness } from "./types.js";

/** OpenCode — the harness used in the canonical hero example. */
export const opencode = (): Harness => ({
  id: "opencode",
  buildRunCommand: (prompt) => ({ executable: "opencode", args: ["run", prompt] }),
  launchCommand: "opencode",
});

/** OpenAI Codex CLI. */
export const codex = (): Harness => ({
  id: "codex",
  buildRunCommand: (prompt) => ({ executable: "codex", args: ["exec", prompt] }),
  launchCommand: "codex",
});

/** Anthropic Claude Code. */
export const claudeCode = (options?: { readonly profile?: string }): Harness => ({
  id: "claude-code",
  buildRunCommand: (prompt) => ({
    executable: "claude",
    args:
      options?.profile === undefined
        ? ["-p", prompt]
        : ["--profile", options.profile, "-p", prompt],
  }),
  launchCommand: "claude",
});

/**
 * A bring-your-own harness. The caller supplies how to invoke it one-shot (`invoke`) and, optionally,
 * how to install and launch it. This is the harness-neutral escape hatch: any agent loop, CI worker,
 * or custom binary.
 */
export const customHarness = (options: {
  readonly id: string;
  readonly invoke: (prompt: string) => readonly string[];
  readonly executable?: string;
  readonly install?: { readonly packages?: readonly string[]; readonly command?: string };
  readonly launchCommand?: string;
}): Harness => ({
  id: options.id,
  buildRunCommand: (prompt) => ({
    executable: options.executable ?? options.id,
    args: options.invoke(prompt),
  }),
  ...(options.install === undefined ? {} : { install: options.install }),
  ...(options.launchCommand === undefined ? {} : { launchCommand: options.launchCommand }),
});
