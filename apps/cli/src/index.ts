#!/usr/bin/env node
/**
 * The `sealant` CLI entry point. A thin, renderer-agnostic command layer over the control-plane API:
 * `ps` (list sandboxes), `login <provider>` (acquire a tool login → encrypted store), `creds` (list).
 * Plain-text rendering today; the view is isolated so a richer TUI can drop in later. Every command
 * honors `--json` / a non-TTY stdout so it composes in scripts and CI.
 */
import { acquire, PROVIDERS, resolveProvider } from "./acquire.js";
import {
  ApiError,
  connectCredential,
  listCredentials,
  listSandboxes,
  type CredentialMetadata,
  type SandboxSummary,
} from "./api.js";
import { resolveConfig, type CliConfig } from "./config.js";

const USAGE = `sealant — manage sandboxes and forward your tool logins

Usage:
  sealant ps                      List sandboxes
  sealant login <provider>        Connect a tool login to the credential store
                                    provider: gh | claude | codex
                                    options:  --token <value>, --label <name>
  sealant creds                   List connected credentials
  sealant help

Then forward stored credentials into a sandbox with the SDK:
  sealant.sandboxes.create({ repository, harness: claudeCode(), use: ["<credential-id>"] })

Environment:
  SEALANT_BASE_URL        control-plane URL (default http://localhost:4000)
  SEALANT_OWNER_USER_ID   owner principal (default usr_local)
  SEALANT_API_KEY         bearer token, if the deployment requires auth
`;

const pad = (value: string, width: number): string =>
  value.length >= width ? value.slice(0, width) : value.padEnd(width);

const relativeAge = (iso: string, now: number): string => {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) {
    return "-";
  }
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86_400)}d`;
};

const wantsJson = (args: readonly string[]): boolean =>
  args.includes("--json") || !process.stdout.isTTY;

interface LoginFlags {
  readonly provider: string | undefined;
  readonly token: string | undefined;
  readonly label: string | undefined;
}

const parseLoginArgs = (args: readonly string[]): LoginFlags => {
  let provider: string | undefined;
  let token: string | undefined;
  let label: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--token") {
      token = args[++i];
    } else if (arg === "--label") {
      label = args[++i];
    } else if (!arg.startsWith("-") && provider === undefined) {
      provider = arg;
    }
  }
  return { provider, token, label };
};

const cmdPs = async (config: CliConfig, args: readonly string[]): Promise<void> => {
  const sandboxes = await listSandboxes(config);
  if (wantsJson(args)) {
    process.stdout.write(`${JSON.stringify(sandboxes, null, 2)}\n`);
    return;
  }
  if (sandboxes.length === 0) {
    process.stdout.write("No sandboxes.\n");
    return;
  }
  const now = Date.now();
  process.stdout.write(`${pad("ID", 24)}${pad("NAME", 24)}${pad("STATUS", 12)}AGE\n`);
  for (const s of sandboxes as readonly SandboxSummary[]) {
    process.stdout.write(
      `${pad(s.sandboxId, 24)}${pad(s.name, 24)}${pad(s.status, 12)}${relativeAge(s.createdAt, now)}\n`,
    );
  }
};

const cmdLogin = async (config: CliConfig, args: readonly string[]): Promise<void> => {
  const { provider: providerArg, token, label } = parseLoginArgs(args);
  if (providerArg === undefined) {
    process.stderr.write(`login: missing provider (one of: gh, claude, codex)\n`);
    process.exitCode = 1;
    return;
  }
  const provider = resolveProvider(providerArg);
  if (provider === undefined) {
    process.stderr.write(`login: unknown provider "${providerArg}" (expected gh | claude | codex)\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`Connecting ${provider}…\n`);
  const result = await acquire(provider, token === undefined ? {} : { token });
  if (!result.ok) {
    process.stderr.write(`login: ${result.reason}\n`);
    process.exitCode = 1;
    return;
  }

  const metadata = await connectCredential(config, {
    ...result.input,
    ...(label === undefined ? {} : { label }),
  });
  process.stdout.write(
    `✓ connected ${metadata.provider} → ${metadata.id}` +
      `${metadata.last4 === undefined ? "" : ` (…${metadata.last4})`}\n` +
      `  use it: sealant.sandboxes.create({ …, use: ["${metadata.id}"] })\n`,
  );
};

const cmdCreds = async (config: CliConfig, args: readonly string[]): Promise<void> => {
  const creds = await listCredentials(config);
  if (wantsJson(args)) {
    process.stdout.write(`${JSON.stringify(creds, null, 2)}\n`);
    return;
  }
  if (creds.length === 0) {
    process.stdout.write("No credentials. Connect one with `sealant login <provider>`.\n");
    return;
  }
  const now = Date.now();
  process.stdout.write(
    `${pad("ID", 28)}${pad("PROVIDER", 10)}${pad("STATUS", 12)}${pad("ACCOUNT", 18)}AGE\n`,
  );
  for (const c of creds as readonly CredentialMetadata[]) {
    process.stdout.write(
      `${pad(c.id, 28)}${pad(c.provider, 10)}${pad(c.status, 12)}${pad(c.accountIdentifier ?? "-", 18)}${relativeAge(c.connectedAt, now)}\n`,
    );
  }
};

const main = async (): Promise<void> => {
  const [command, ...rest] = process.argv.slice(2);
  const config = resolveConfig();
  switch (command) {
    case "ps":
      await cmdPs(config, rest);
      break;
    case "login":
      await cmdLogin(config, rest);
      break;
    case "creds":
    case "credentials":
      await cmdCreds(config, rest);
      break;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(USAGE);
      break;
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
      process.exitCode = 1;
  }
};

void PROVIDERS; // referenced for completeness of the public provider set

main().catch((error: unknown) => {
  const message =
    error instanceof ApiError
      ? `API error (${error.status}): ${error.message}`
      : error instanceof Error
        ? error.message
        : String(error);
  process.stderr.write(`error: ${message}\n`);
  process.exitCode = 1;
});
