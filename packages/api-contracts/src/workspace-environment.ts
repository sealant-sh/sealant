/**
 * Workspace environment policy: the ONE definition of which caller-supplied environment variables
 * a workspace may receive at creation, shared verbatim by the SDK (client-side rejection with the
 * same messages the server would produce), the control-plane validators (`runtime.userEnv`), and
 * any downstream product composing its own additions on top.
 *
 * Deliberately dependency-free (no schema library): consumers span an Effect-based contract
 * package, zod-based validators, and browser bundles. Everything here is data plus pure functions.
 *
 * Two invariants shape the rules:
 *
 * 1. **Nothing that validates may silently vanish.** sealantd rebuilds the child environment for
 *    every managed process from a boot-time snapshot of the container environment, dropping names
 *    that match its secret markers (substring `TOKEN`/`SECRET`/`PASSWORD`/`PASSWD`/`CREDENTIAL`/
 *    `APIKEY`, suffix `_KEY`, exact `KEY`) and its consumed `SEALANT_*` keys. The reserved rules
 *    here are a strict superset of that filter, so an accepted name is guaranteed to reach the
 *    workspace's processes rather than being filtered on the way in.
 * 2. **Diagnostics never carry values.** Accepted values are ordinary (non-secret) configuration
 *    by contract, but issue records still identify entries by name or index only — a name may
 *    appear in an issue only after it has passed the grammar check; otherwise a bounded escaped
 *    rendering is used.
 */

export const WORKSPACE_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/** Names are ASCII by grammar, so length in characters equals length in bytes. */
export const WORKSPACE_ENV_MAX_NAME_LENGTH = 128;

/** Maximum UTF-8 bytes per value. Values may be empty and may contain newlines, never NUL. */
export const WORKSPACE_ENV_MAX_VALUE_BYTES = 4096;

export const WORKSPACE_ENV_MAX_ENTRIES = 128;

/** Maximum total UTF-8 bytes across all names and values of one map. */
export const WORKSPACE_ENV_MAX_TOTAL_BYTES = 32768;

/**
 * Why a name is reserved. `secret-marker` mirrors sealantd's filter exactly (see module doc);
 * the rest prevent project-level settings from silently reconfiguring platform control,
 * connected-account lookup, loaders, shells, or global tool runtimes. Legitimate uses of a
 * blocked process-control variable belong in explicit command or workspace-image configuration
 * where the effect is visible.
 */
export type WorkspaceEnvReservedRule =
  | "platform-prefix"
  | "process-identity"
  | "runtime-network"
  | "account-lookup"
  | "dynamic-loader"
  | "shell-startup"
  | "runtime-injection"
  | "git-ssh"
  | "secret-marker";

const RESERVED_PREFIXES: ReadonlyArray<readonly [string, WorkspaceEnvReservedRule]> = [
  ["SEALANT_", "platform-prefix"],
  ["LD_", "dynamic-loader"],
  ["DYLD_", "dynamic-loader"],
  ["GIT_CONFIG_KEY_", "git-ssh"],
  ["GIT_CONFIG_VALUE_", "git-ssh"],
];

const RESERVED_NAMES: ReadonlyMap<string, WorkspaceEnvReservedRule> = new Map([
  // Identity/process roots the daemon and shells own.
  ...(
    [
      "HOME",
      "PATH",
      "USER",
      "LOGNAME",
      "SHELL",
      "PWD",
      "OLDPWD",
      "SHLVL",
      "TERM",
      "COLORTERM",
      "_",
    ] as const
  ).map((name) => [name, "process-identity"] as const),
  // Runtime/network ownership (lowercase variants are caught by the uppercase comparison).
  ...(
    [
      "DOCKER_HOST",
      "DOCKER_TLS_CERTDIR",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "NO_PROXY",
    ] as const
  ).map((name) => [name, "runtime-network"] as const),
  // Connected-account identity and config-lookup roots.
  ...(
    [
      "CLAUDE_CODE_OAUTH_TOKEN",
      "GITHUB_TOKEN",
      "GH_TOKEN",
      "XDG_CONFIG_HOME",
      "CLAUDE_CONFIG_DIR",
      "CODEX_HOME",
    ] as const
  ).map((name) => [name, "account-lookup"] as const),
  ["GLIBC_TUNABLES", "dynamic-loader"],
  // Shell startup/control.
  ...(["BASH_ENV", "ENV", "ZDOTDIR", "PROMPT_COMMAND", "PS4", "SHELLOPTS"] as const).map(
    (name) => [name, "shell-startup"] as const,
  ),
  // Runtime-wide code injection.
  ...(
    [
      "NODE_OPTIONS",
      "PYTHONPATH",
      "PYTHONSTARTUP",
      "RUBYOPT",
      "PERL5OPT",
      "JAVA_TOOL_OPTIONS",
    ] as const
  ).map((name) => [name, "runtime-injection"] as const),
  // Git/SSH identity and config controls.
  ...(
    [
      "SSH_AUTH_SOCK",
      "GIT_SSH",
      "GIT_SSH_COMMAND",
      "GIT_CONFIG_GLOBAL",
      "GIT_CONFIG_SYSTEM",
      "GIT_CONFIG_NOSYSTEM",
      "GIT_CONFIG_COUNT",
    ] as const
  ).map((name) => [name, "git-ssh"] as const),
]);

/** sealantd's secret markers, matched as substrings of the ASCII-uppercased name. */
export const WORKSPACE_ENV_SECRET_MARKERS = [
  "TOKEN",
  "SECRET",
  "PASSWORD",
  "PASSWD",
  "CREDENTIAL",
  "APIKEY",
] as const;

const toAsciiUpper = (name: string): string =>
  name.replace(/[a-z]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 32));

/**
 * The reserved rule a (grammar-valid) name violates, or undefined when the name is allowed.
 * Matching is ASCII-uppercase so `http_proxy` cannot bypass `HTTP_PROXY`.
 */
export const findWorkspaceEnvReservedRule = (
  name: string,
): WorkspaceEnvReservedRule | undefined => {
  const upper = toAsciiUpper(name);
  for (const [prefix, rule] of RESERVED_PREFIXES) {
    if (upper.startsWith(prefix)) {
      return rule;
    }
  }
  const exact = RESERVED_NAMES.get(upper);
  if (exact !== undefined) {
    return exact;
  }
  // Mirror of sealantd's is_secret_key: substring markers, `_KEY` suffix, bare `KEY`. Broader than
  // it looks on purpose — `TOKENIZER_PATH` matches `TOKEN` — because the daemon's filter would
  // silently drop those names, and a loud rejection here beats a variable that never appears.
  if (WORKSPACE_ENV_SECRET_MARKERS.some((marker) => upper.includes(marker))) {
    return "secret-marker";
  }
  if (upper === "KEY" || upper.endsWith("_KEY")) {
    return "secret-marker";
  }
  return undefined;
};

/**
 * One rejected aspect of a workspace environment map. Name-bearing variants carry a name only when
 * it passed the grammar check; grammar/length failures identify the entry by enumeration index and
 * a bounded escaped rendering. No variant ever carries a value.
 */
export type WorkspaceEnvIssue =
  | { readonly rule: "name-grammar"; readonly index: number; readonly nameDisplay: string }
  | { readonly rule: "name-length"; readonly index: number; readonly nameDisplay: string }
  | {
      readonly rule: "name-reserved";
      readonly name: string;
      readonly reservedRule: WorkspaceEnvReservedRule;
    }
  | { readonly rule: "value-nul"; readonly name: string }
  | { readonly rule: "value-size"; readonly name: string; readonly valueBytes: number }
  | { readonly rule: "entry-count"; readonly entryCount: number }
  | { readonly rule: "total-size"; readonly totalBytes: number };

export type WorkspaceEnvParseResult =
  | { readonly ok: true; readonly env: Readonly<Record<string, string>> }
  | { readonly ok: false; readonly issues: ReadonlyArray<WorkspaceEnvIssue> };

const boundedNameDisplay = (name: string): string => {
  const head = [...name].slice(0, 32).join("");
  return JSON.stringify(head.length < name.length ? `${head}…` : head);
};

const utf8Bytes = (value: string): number => new TextEncoder().encode(value).length;

/**
 * Validate a caller-supplied environment map against the full policy. On success the returned map
 * is re-serialized in name order (deterministic for tests and stored specs). Collects every issue
 * rather than stopping at the first, so a settings UI can annotate all rows in one round trip.
 * Duplicate names cannot be detected here — a parsed JS object has already collapsed them; owners
 * of the pre-parse representation (databases, forms) must enforce uniqueness themselves.
 */
export const parseWorkspaceEnv = (
  input: Readonly<Record<string, string>>,
): WorkspaceEnvParseResult => parseEnvMap(input, "env");

/**
 * Validate a caller-supplied SECRET environment map — the transient secret channel
 * (`CreateOptions.secretEnv`): same grammar and size bounds as `env`, and the same platform-owned
 * name classes are reserved, but secret-shaped names are exactly what belongs here, so the
 * `secret-marker` rule does not apply. Account-lookup names (`GITHUB_TOKEN`,
 * `CLAUDE_CODE_OAUTH_TOKEN`, …) stay reserved: connected accounts own those.
 */
export const parseWorkspaceSecretEnv = (
  input: Readonly<Record<string, string>>,
): WorkspaceEnvParseResult => parseEnvMap(input, "secretEnv");

/** Reserved-rule lookup for the secret lane: everything but `secret-marker`. */
export const findWorkspaceSecretEnvReservedRule = (
  name: string,
): WorkspaceEnvReservedRule | undefined => {
  const rule = findWorkspaceEnvReservedRule(name);
  return rule === "secret-marker" ? undefined : rule;
};

const parseEnvMap = (
  input: Readonly<Record<string, string>>,
  lane: "env" | "secretEnv",
): WorkspaceEnvParseResult => {
  const findReserved =
    lane === "env" ? findWorkspaceEnvReservedRule : findWorkspaceSecretEnvReservedRule;
  const issues: Array<WorkspaceEnvIssue> = [];
  const entries = Object.entries(input);
  if (entries.length > WORKSPACE_ENV_MAX_ENTRIES) {
    issues.push({ rule: "entry-count", entryCount: entries.length });
  }
  let totalBytes = 0;
  for (const [index, [name, value]] of entries.entries()) {
    if (!WORKSPACE_ENV_NAME_PATTERN.test(name)) {
      issues.push({ rule: "name-grammar", index, nameDisplay: boundedNameDisplay(name) });
      continue;
    }
    if (name.length > WORKSPACE_ENV_MAX_NAME_LENGTH) {
      issues.push({ rule: "name-length", index, nameDisplay: boundedNameDisplay(name) });
      continue;
    }
    const reservedRule = findReserved(name);
    if (reservedRule !== undefined) {
      issues.push({ rule: "name-reserved", name, reservedRule });
      continue;
    }
    if (value.includes("\u0000")) {
      issues.push({ rule: "value-nul", name });
      continue;
    }
    const valueBytes = utf8Bytes(value);
    if (valueBytes > WORKSPACE_ENV_MAX_VALUE_BYTES) {
      issues.push({ rule: "value-size", name, valueBytes });
      continue;
    }
    totalBytes += name.length + valueBytes;
  }
  if (totalBytes > WORKSPACE_ENV_MAX_TOTAL_BYTES) {
    issues.push({ rule: "total-size", totalBytes });
  }
  if (issues.length > 0) {
    return { ok: false, issues };
  }
  const env: Record<string, string> = {};
  for (const name of Object.keys(input).toSorted()) {
    env[name] = input[name] ?? "";
  }
  return { ok: true, env };
};

const RESERVED_RULE_MESSAGES: Readonly<Record<WorkspaceEnvReservedRule, string>> = {
  "platform-prefix": "the SEALANT_ prefix is platform-owned",
  "process-identity": "it is a process-identity variable owned by the workspace runtime",
  "runtime-network": "it controls runtime or network routing",
  "account-lookup": "it controls connected-account identity or configuration lookup",
  "dynamic-loader": "it controls the dynamic loader",
  "shell-startup": "it controls shell startup",
  "runtime-injection": "it injects code into a language runtime",
  "git-ssh": "it controls Git or SSH identity and configuration",
  "secret-marker":
    "secret-looking names (containing TOKEN, SECRET, PASSWORD, PASSWD, CREDENTIAL, or APIKEY, ending in _KEY, or exactly KEY) are filtered by the workspace runtime and would never reach any process; environment variables are for ordinary non-secret configuration",
};

/** Human-readable, value-free rendering of one issue; identical client- and server-side. */
export const formatWorkspaceEnvIssue = (issue: WorkspaceEnvIssue): string => {
  switch (issue.rule) {
    case "name-grammar":
      return `env entry ${issue.index} (${issue.nameDisplay}): names must match [A-Za-z_][A-Za-z0-9_]*`;
    case "name-length":
      return `env entry ${issue.index} (${issue.nameDisplay}): names must be at most ${WORKSPACE_ENV_MAX_NAME_LENGTH} characters`;
    case "name-reserved":
      return `env name ${issue.name} is reserved: ${RESERVED_RULE_MESSAGES[issue.reservedRule]}`;
    case "value-nul":
      return `env value for ${issue.name} must not contain NUL`;
    case "value-size":
      return `env value for ${issue.name} is ${issue.valueBytes} bytes; the maximum is ${WORKSPACE_ENV_MAX_VALUE_BYTES}`;
    case "entry-count":
      return `env has ${issue.entryCount} entries; the maximum is ${WORKSPACE_ENV_MAX_ENTRIES}`;
    case "total-size":
      return `env totals ${issue.totalBytes} bytes across names and values; the maximum is ${WORKSPACE_ENV_MAX_TOTAL_BYTES}`;
  }
};
