/**
 * Per-provider credential acquisition for `sealant login`. Reads what's already on the developer's
 * machine (or a `--token` override) and produces the payload to store. Kept renderer-agnostic.
 *
 * Per the architecture: gh = capture the user's token; claude = a `setup-token` OAuth token (or an
 * API key); codex = an API key (the ChatGPT subscription rotates and is out of scope for slice 1).
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { ConnectCredentialInput, CredentialProvider } from "./api.js";

const execFileAsync = promisify(execFile);

export type AcquireResult =
  | { readonly ok: true; readonly input: ConnectCredentialInput }
  | { readonly ok: false; readonly reason: string };

const ok = (input: ConnectCredentialInput): AcquireResult => ({ ok: true, input });
const fail = (reason: string): AcquireResult => ({ ok: false, reason });

const firstEnv = (env: NodeJS.ProcessEnv, keys: readonly string[]): string | undefined => {
  for (const key of keys) {
    const value = env[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
};

export interface AcquireOptions {
  readonly token?: string;
  readonly env?: NodeJS.ProcessEnv;
}

const acquireGh = async (opts: AcquireOptions): Promise<AcquireResult> => {
  const token = opts.token ?? (await runGhAuthToken());
  if (token === undefined) {
    return fail("not logged in — run `gh auth login` (or pass --token).");
  }
  return ok({ provider: "github", kind: "api_key", payloadShape: "api_key", secret: token });
};

const runGhAuthToken = async (): Promise<string | undefined> => {
  try {
    const { stdout } = await execFileAsync("gh", ["auth", "token"], { timeout: 10_000 });
    const token = stdout.trim();
    return token.length === 0 ? undefined : token;
  } catch {
    return undefined;
  }
};

const acquireClaude = (opts: AcquireOptions): AcquireResult => {
  const env = opts.env ?? process.env;
  const token =
    opts.token ?? firstEnv(env, ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]);
  if (token === undefined) {
    return fail(
      "no Claude token found — run `claude setup-token` and pass --token, or export CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY.",
    );
  }
  return ok({ provider: "claude", kind: "oauth", payloadShape: "oauth_token_set", secret: token });
};

const acquireCodex = async (opts: AcquireOptions): Promise<AcquireResult> => {
  const env = opts.env ?? process.env;
  const fromEnv = opts.token ?? firstEnv(env, ["OPENAI_API_KEY"]);
  if (fromEnv !== undefined) {
    return ok({ provider: "codex", kind: "api_key", payloadShape: "api_key", secret: fromEnv });
  }
  const fromFile = await readCodexApiKey(env);
  if (fromFile !== undefined) {
    return ok({ provider: "codex", kind: "api_key", payloadShape: "api_key", secret: fromFile });
  }
  return fail(
    "no OPENAI_API_KEY found — set OPENAI_API_KEY, run `codex login --api-key`, or pass --token. (ChatGPT-subscription forwarding is not supported yet.)",
  );
};

const readCodexApiKey = async (env: NodeJS.ProcessEnv): Promise<string | undefined> => {
  const home = env.CODEX_HOME && env.CODEX_HOME.trim().length > 0 ? env.CODEX_HOME : join(homedir(), ".codex");
  try {
    const parsed = JSON.parse(await readFile(join(home, "auth.json"), "utf8")) as {
      OPENAI_API_KEY?: unknown;
    };
    return typeof parsed.OPENAI_API_KEY === "string" && parsed.OPENAI_API_KEY.trim().length > 0
      ? parsed.OPENAI_API_KEY.trim()
      : undefined;
  } catch {
    return undefined;
  }
};

export const PROVIDERS: readonly CredentialProvider[] = ["github", "claude", "codex"];

/** Map a `login <name>` alias to a provider id (accepts `gh`, `claude-code`, etc.). */
export const resolveProvider = (name: string): CredentialProvider | undefined => {
  const normalized = name.toLowerCase();
  if (normalized === "gh" || normalized === "github") return "github";
  if (normalized === "claude" || normalized === "claude-code") return "claude";
  if (normalized === "codex" || normalized === "openai") return "codex";
  return undefined;
};

export const acquire = async (
  provider: CredentialProvider,
  opts: AcquireOptions = {},
): Promise<AcquireResult> => {
  switch (provider) {
    case "github":
      return acquireGh(opts);
    case "claude":
      return acquireClaude(opts);
    case "codex":
      return acquireCodex(opts);
  }
};
