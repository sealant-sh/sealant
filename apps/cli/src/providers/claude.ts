import { Console, Effect, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";

import { ControlPlaneClientService, toApiSettings } from "../api-client.js";
import { currentSettings } from "../config.js";
import { CliFailure } from "../errors.js";
import { confirmStep, hiddenInput, isInteractive } from "../prompts.js";
import { isColorEnabled, makePalette } from "../render.js";
import { ExternalToolsService } from "../tools.js";

/*
 * COMPLIANCE (docs/connected-accounts-design.md §2, Claude — strictest provider):
 * - The ONLY acquisition path is the user running Anthropic's official `claude setup-token` and
 *   pasting the resulting sk-ant-oat01-… token. We may spawn the official `claude` binary with
 *   inherited stdio for convenience; the OAuth loop is entirely Anthropic's.
 * - NEVER read ~/.claude/.credentials.json or any OS keychain.
 * - NEVER make any request to Anthropic domains (no OAuth, no token, no inference endpoints).
 */

export const CLAUDE_TOKEN_PREFIX = "sk-ant-oat01-";

export type ClaudeTokenValidation =
  | { readonly ok: true; readonly token: string }
  | { readonly ok: false; readonly reason: string };

/** Local shape check only — no network validation, per compliance rules. */
export const validateClaudeToken = (raw: string): ClaudeTokenValidation => {
  const token = raw.trim();
  if (token === "") {
    return { ok: false, reason: "The token is empty." };
  }
  if (!token.startsWith(CLAUDE_TOKEN_PREFIX)) {
    return {
      ok: false,
      reason: `Claude Code long-lived tokens start with ${CLAUDE_TOKEN_PREFIX}. Mint one with \`claude setup-token\` and paste it exactly.`,
    };
  }
  if (token.length <= CLAUDE_TOKEN_PREFIX.length) {
    return { ok: false, reason: "The token is truncated — paste the full value." };
  }
  return { ok: true, token };
};

export const authClaudeCommand = Command.make(
  "claude",
  {
    name: Flag.string("name").pipe(
      Flag.withDefault("default"),
      Flag.withDescription("Account name (you can connect multiple Claude accounts)"),
    ),
    yes: Flag.boolean("yes").pipe(
      Flag.withAlias("y"),
      Flag.withDescription("Skip confirmation prompts"),
    ),
    token: Flag.string("token").pipe(
      Flag.optional,
      Flag.withDescription("Token from `claude setup-token` (skips the interactive flow)"),
    ),
  },
  ({ name, token, yes }) =>
    Effect.gen(function* () {
      const settings = yield* currentSettings;
      const client = yield* ControlPlaneClientService;
      const tools = yield* ExternalToolsService;
      const palette = makePalette(isColorEnabled());

      yield* Console.log(palette.bold("Connect your Claude subscription"));
      yield* Console.log(
        "Sealant stores the long-lived token minted by Anthropic's official `claude setup-token`,",
      );
      yield* Console.log(
        `encrypted in your self-hosted control plane (${settings.apiUrl.value}), and only ever`,
      );
      yield* Console.log("injects it where the official Claude Code CLI / Agent SDK runs.");
      yield* Console.log("");

      let rawToken = Option.getOrUndefined(token);
      if (rawToken === undefined) {
        if (!isInteractive()) {
          return yield* Effect.fail(
            new CliFailure({
              message: "No --token provided and this is not an interactive terminal.",
              hint: "Mint a token with `claude setup-token`, then re-run with --token <tok>.",
            }),
          );
        }
        // Offer to spawn the official binary; skipped under --yes (scripting should pass --token).
        const claudePath = yield* tools.which("claude");
        if (claudePath !== null && !yes) {
          const runNow = yield* confirmStep({
            message: "Run `claude setup-token` now? (the token prints at the end of that flow)",
            yes: false,
          });
          if (runNow) {
            const exitCode = yield* tools.runInteractive("claude", ["setup-token"]);
            if (exitCode !== 0) {
              yield* Console.log(
                palette.yellow(`\`claude setup-token\` exited with code ${exitCode}.`),
              );
            }
            yield* Console.log("");
          }
        } else if (claudePath === null) {
          yield* Console.log(
            palette.dim(
              "`claude` was not found on PATH — run `claude setup-token` on any machine and paste the token below.",
            ),
          );
        }
        rawToken = yield* hiddenInput(`Paste your ${CLAUDE_TOKEN_PREFIX}… token`);
      }

      const validated = validateClaudeToken(rawToken);
      if (!validated.ok) {
        return yield* Effect.fail(new CliFailure({ message: validated.reason }));
      }

      const account = yield* client.createConnectedAccount(toApiSettings(settings), {
        provider: "claude",
        name,
        secret: validated.token,
      });

      yield* Console.log(
        `${palette.green("✓")} Connected ${palette.bold(`claude/${account.name}`)} (${account.status})`,
      );
      yield* Console.log(
        palette.dim(
          `Bind it to a profile: sealant profiles bind <profile> --claude ${account.name}`,
        ),
      );
    }),
).pipe(Command.withDescription("Connect a Claude subscription via `claude setup-token`"));
