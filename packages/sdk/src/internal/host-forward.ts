/**
 * Host credential forwarding — the implementation behind `create({ forward: [...] })`.
 *
 * Goal: reuse the developer's EXISTING local logins inside a sandbox with ZERO per-sandbox setup —
 * including paid **Claude/Codex subscriptions**, not just API keys. This runs on the developer's
 * machine (the SDK is a thin HTTP client; the worker that launches the sandbox is containerized and
 * cannot read your home dir), captures whatever auth you already have, and ships it so the agent
 * inside the sandbox is authenticated as you.
 *
 * Two capture shapes, per tool, preferring the cleanest auth you already have:
 *   - ENV TOKEN  — a scoped token forwarded as the env var the CLI honors (gh → GH_TOKEN; an API key
 *     or `claude setup-token`/CLAUDE_CODE_OAUTH_TOKEN you already exported).
 *   - CRED FILE  — your on-disk SUBSCRIPTION credentials copied verbatim into the sandbox: Claude's
 *     `~/.claude/.credentials.json` → `/root/.claude/.credentials.json`, Codex's `~/.codex/auth.json`
 *     → `/root/.codex/auth.json`. On macOS (where there is no file) we extract from the login Keychain.
 *
 * Transport (no sealantd change needed): the file bytes ride as a base64 RUNTIME env var (injected at
 * `docker run -e`, so never baked into an image layer), and a `lifecycle.setup` boot step decodes it
 * into place before the harness runs. `materializeForward` builds both halves.
 *
 * Honest caveats (surfaced via warnings):
 *   - Codex ChatGPT login uses a ROTATING single-use refresh token. If the sandbox's codex refreshes
 *     it, your HOST copy goes stale and you'll have to `codex login` again. Unavoidable for codex subs.
 *   - A copied Claude credential refreshes against its own in-sandbox copy (your host is untouched),
 *     but a long-lived sandbox can still outlive the access token. Fine for short-lived sandboxes.
 *
 * `resolveHostForward` is a small registry over injectable `HostForwardDeps`, so a future
 * profiles/policies layer can reuse it to bundle credential forwarding.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir, platform as osPlatform } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { CreateOptions, HostForwardTool } from "../types.js";

const execFileAsync = promisify(execFile);

/** A credential file to materialize inside the sandbox (its `content` is a secret — never log it). */
interface ForwardFile {
  /** Absolute in-sandbox path. The sandbox runs as root, so config lands under `/root`. */
  readonly path: string;
  /** Octal mode string applied with `chmod`, e.g. "600". */
  readonly mode: string;
  /** Raw file bytes (the secret). */
  readonly content: string;
}

/** What a tool produced from the host. `env` and/or `files` carry the auth; `source` is secret-free. */
interface ForwardCapture {
  readonly env?: Readonly<Record<string, string>>;
  readonly files?: readonly ForwardFile[];
  /** A short note on what/where was captured, free of secret VALUES (safe to print). */
  readonly source: string;
  /** An optional non-fatal warning to surface even though capture succeeded (e.g. codex rotation). */
  readonly warning?: string;
}

/** Nothing was captured for a tool, with an actionable, secret-free reason. */
interface ForwardSkip {
  readonly skipped: true;
  readonly reason: string;
}

type ForwardOutcome = ForwardCapture | ForwardSkip;

const isSkip = (outcome: ForwardOutcome): outcome is ForwardSkip => "skipped" in outcome;

const skip = (reason: string): ForwardSkip => ({ skipped: true, reason });

/**
 * Host-side capabilities a forwarder needs, injected so capture is unit-testable without spawning
 * `gh`/`security` or touching the real filesystem. Defaults wrap the real Node APIs (`defaultDeps`).
 */
export interface HostForwardDeps {
  readonly hostEnv: NodeJS.ProcessEnv;
  /** Run a command and resolve its stdout; rejects if the binary is missing or exits non-zero. */
  readonly exec: (command: string, args: readonly string[]) => Promise<string>;
  /** Read a UTF-8 text file; rejects if it does not exist. */
  readonly readTextFile: (path: string) => Promise<string>;
  /** The current user's home directory. */
  readonly homeDir: string;
  /** Host platform; gates macOS Keychain extraction. */
  readonly platform: NodeJS.Platform;
  /** Sink for non-fatal warnings (default `console.warn`). */
  readonly warn: (message: string) => void;
}

export const defaultDeps = (): HostForwardDeps => ({
  hostEnv: process.env,
  exec: async (command, args) => {
    const { stdout } = await execFileAsync(command, [...args], {
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    return stdout;
  },
  readTextFile: (path) => readFile(path, "utf8"),
  homeDir: homedir(),
  platform: osPlatform(),
  warn: (message) => console.warn(message),
});

const pickEnv = (
  hostEnv: NodeJS.ProcessEnv,
  keys: readonly string[],
): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const key of keys) {
    const value = hostEnv[key];
    if (typeof value === "string" && value.trim().length > 0) {
      env[key] = value.trim();
    }
  }
  return env;
};

/**
 * Read a credential that lives EITHER in a file (Linux, or a headless macOS that fell back to a file)
 * OR in the macOS login Keychain (the default on a desktop Mac, where no file exists). Returns the
 * trimmed contents, or undefined if neither is present.
 */
const readCredential = async (
  deps: HostForwardDeps,
  filePath: string,
  keychainService: string,
): Promise<string | undefined> => {
  try {
    const fromFile = (await deps.readTextFile(filePath)).trim();
    if (fromFile.length > 0) {
      return fromFile;
    }
  } catch {
    // fall through to the Keychain on macOS
  }
  if (deps.platform === "darwin") {
    try {
      const fromKeychain = (
        await deps.exec("security", ["find-generic-password", "-s", keychainService, "-w"])
      ).trim();
      if (fromKeychain.length > 0) {
        return fromKeychain;
      }
    } catch {
      // not in the Keychain either
    }
  }
  return undefined;
};

interface HostForwarder {
  readonly id: HostForwardTool;
  /** Display label used in warnings, e.g. "GitHub CLI". */
  readonly label: string;
  capture(deps: HostForwardDeps): Promise<ForwardOutcome>;
}

const ghForwarder: HostForwarder = {
  id: "gh",
  label: "GitHub CLI (gh)",
  capture: async (deps) => {
    let stdout: string;
    try {
      stdout = await deps.exec("gh", ["auth", "token"]);
    } catch {
      return skip("could not run `gh auth token` — install gh and run `gh auth login`.");
    }
    const token = stdout.trim();
    if (token.length === 0) {
      return skip("`gh auth token` returned nothing — run `gh auth login`.");
    }
    // GH_TOKEN authenticates `gh` directly and outranks any stored credential; storage-agnostic, so it
    // works no matter where your host kept the token (Keychain / keyring / plaintext hosts.yml).
    return { env: { GH_TOKEN: token }, source: "gh auth token → GH_TOKEN" };
  },
};

// Env vars that authenticate Claude Code (API key or an explicitly exported token). Preferred when
// present because they are the cleanest; otherwise we fall back to the subscription credentials file.
const CLAUDE_AUTH_ENV_VARS = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
] as const;

const claudeCodeForwarder: HostForwarder = {
  id: "claude-code",
  label: "Claude Code",
  capture: async (deps) => {
    const envTokens = pickEnv(deps.hostEnv, CLAUDE_AUTH_ENV_VARS);
    if (Object.keys(envTokens).length > 0) {
      return { env: envTokens, source: `host env (${Object.keys(envTokens).join(", ")})` };
    }

    // Subscription login (`claude /login`): the OAuth tokens live in ~/.claude/.credentials.json on
    // Linux, or the "Claude Code-credentials" Keychain item on macOS. CLAUDE_CONFIG_DIR relocates it.
    const configDir =
      typeof deps.hostEnv.CLAUDE_CONFIG_DIR === "string" &&
      deps.hostEnv.CLAUDE_CONFIG_DIR.trim().length > 0
        ? deps.hostEnv.CLAUDE_CONFIG_DIR
        : join(deps.homeDir, ".claude");
    const creds = await readCredential(
      deps,
      join(configDir, ".credentials.json"),
      "Claude Code-credentials",
    );
    if (creds !== undefined) {
      return {
        files: [{ path: "/root/.claude/.credentials.json", mode: "600", content: creds }],
        source: "Claude subscription credentials → /root/.claude/.credentials.json",
      };
    }

    return skip(
      "not logged in — run `claude /login` for your subscription, or set ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN.",
    );
  },
};

const codexForwarder: HostForwarder = {
  id: "codex",
  label: "OpenAI Codex",
  capture: async (deps) => {
    const apiKey = deps.hostEnv.OPENAI_API_KEY;
    if (typeof apiKey === "string" && apiKey.trim().length > 0) {
      return { env: { OPENAI_API_KEY: apiKey.trim() }, source: "host env (OPENAI_API_KEY)" };
    }

    // Subscription login (ChatGPT) or a file-based api key: ~/.codex/auth.json, or the "Codex Auth"
    // Keychain item on macOS. CODEX_HOME relocates the dir.
    const codexHome =
      typeof deps.hostEnv.CODEX_HOME === "string" && deps.hostEnv.CODEX_HOME.trim().length > 0
        ? deps.hostEnv.CODEX_HOME
        : join(deps.homeDir, ".codex");
    const auth = await readCredential(deps, join(codexHome, "auth.json"), "Codex Auth");
    if (auth !== undefined) {
      return {
        files: [{ path: "/root/.codex/auth.json", mode: "600", content: auth }],
        source: "Codex subscription credentials → /root/.codex/auth.json",
        // The one caveat we cannot engineer away for a ChatGPT login.
        warning:
          "codex uses a rotating single-use refresh token; if the sandbox refreshes it you may need to `codex login` again on your machine. Avoid running codex on your host and in a sandbox at the same time.",
      };
    }

    return skip("not logged in — run `codex login` for your subscription, or set OPENAI_API_KEY.");
  },
};

const forwarders: Record<HostForwardTool, HostForwarder> = {
  gh: ghForwarder,
  "claude-code": claudeCodeForwarder,
  codex: codexForwarder,
};

export interface ResolvedHostForward {
  readonly captures: ReadonlyArray<{
    readonly tool: HostForwardTool;
    readonly label: string;
    readonly capture: ForwardCapture;
  }>;
  readonly skips: ReadonlyArray<{
    readonly tool: HostForwardTool;
    readonly label: string;
    readonly reason: string;
  }>;
}

/**
 * Resolve a list of forward tool ids into captures by querying each on the host. Pure over the
 * injected `deps`; emits no output (the caller decides how to surface skips/warnings). De-dupes ids,
 * preserving first-seen order. This is the seam a future profiles/policies layer reuses.
 */
export const resolveHostForward = async (
  tools: readonly HostForwardTool[],
  deps: HostForwardDeps = defaultDeps(),
): Promise<ResolvedHostForward> => {
  const captures: Array<ResolvedHostForward["captures"][number]> = [];
  const skips: Array<ResolvedHostForward["skips"][number]> = [];

  const seen = new Set<HostForwardTool>();
  for (const tool of tools) {
    if (seen.has(tool)) {
      continue;
    }
    seen.add(tool);

    const forwarder = forwarders[tool];
    const outcome = await forwarder.capture(deps);
    if (isSkip(outcome)) {
      skips.push({ tool, label: forwarder.label, reason: outcome.reason });
    } else {
      captures.push({ tool, label: forwarder.label, capture: outcome });
    }
  }

  return { captures, skips };
};

/** A boot command step the SDK lowers onto `blueprint.lifecycle.setup`. */
export interface ForwardSetupStep {
  readonly run: string;
  readonly shell: "bash";
}

export interface ForwardPlan {
  /** Runtime env vars to inject (scoped tokens + base64 file blobs). */
  readonly env: Readonly<Record<string, string>>;
  /** Boot steps that materialize the forwarded credential files inside the sandbox. */
  readonly setupSteps: readonly ForwardSetupStep[];
}

const toEnvVarSlug = (tool: HostForwardTool, index: number): string =>
  `SEALANT_FWD_${tool.replace(/[^a-z0-9]+/gi, "_").toUpperCase()}_${index}`;

const dirOf = (path: string): string => {
  const slash = path.lastIndexOf("/");
  return slash <= 0 ? "/" : path.slice(0, slash);
};

/**
 * Lower resolved captures into a `ForwardPlan`: tokens go straight into `env`; each credential file
 * becomes a base64 `env` var plus a `lifecycle.setup` step that decodes it to its in-sandbox path with
 * the right mode. The file BYTES travel only as a runtime env var, never in the baked setup command.
 */
const materializeForward = (resolved: ResolvedHostForward, explicitEnv: Readonly<Record<string, string>> | undefined): ForwardPlan => {
  const env: Record<string, string> = {};
  const setupSteps: ForwardSetupStep[] = [];

  for (const { tool, capture } of resolved.captures) {
    Object.assign(env, capture.env);
    const files = capture.files ?? [];
    for (let index = 0; index < files.length; index++) {
      const file = files[index]!;
      const varName = toEnvVarSlug(tool, index);
      env[varName] = Buffer.from(file.content, "utf8").toString("base64");
      // The command references only the var NAME (safe to bake); the value is the runtime env secret.
      setupSteps.push({
        run: `mkdir -p ${dirOf(file.path)} && printf %s "$${varName}" | base64 -d > ${file.path} && chmod ${file.mode} ${file.path}`,
        shell: "bash",
      });
    }
  }

  // An explicit `env` from the caller wins over anything captured (incl. a forwarded token of the same name).
  Object.assign(env, explicitEnv);
  return { env, setupSteps };
};

/**
 * Capture forwarded host logins for a create call and produce the runtime env + boot steps to inject.
 * Skips are surfaced via `deps.warn` (non-fatal — forwarding a tool you aren't logged into shouldn't
 * fail sandbox creation), as are success-time warnings like codex's refresh-token rotation.
 */
export const prepareForward = async (
  options: Pick<CreateOptions, "forward" | "env">,
  deps: HostForwardDeps = defaultDeps(),
): Promise<ForwardPlan> => {
  if (
    (options.forward === undefined || options.forward.length === 0) &&
    (options.env === undefined || Object.keys(options.env).length === 0)
  ) {
    return { env: {}, setupSteps: [] };
  }

  const resolved =
    options.forward === undefined || options.forward.length === 0
      ? { captures: [], skips: [] }
      : await resolveHostForward(options.forward, deps);

  for (const skipped of resolved.skips) {
    deps.warn(`[sealant] forward "${skipped.tool}" (${skipped.label}) skipped: ${skipped.reason}`);
  }
  for (const { tool, capture } of resolved.captures) {
    if (capture.warning !== undefined) {
      deps.warn(`[sealant] forward "${tool}": ${capture.warning}`);
    }
  }

  return materializeForward(resolved, options.env);
};
