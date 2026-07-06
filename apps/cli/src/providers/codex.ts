import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Console, Effect, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";

import { ControlPlaneClientService, toApiSettings } from "../api-client.js";
import { currentSettings } from "../config.js";
import { CliFailure, describeUnknown } from "../errors.js";
import { abortedByUser, confirmStep, isInteractive } from "../prompts.js";
import { isColorEnabled, makePalette } from "../render.js";
import { ExternalToolsService } from "../tools.js";

/*
 * COMPLIANCE (docs/connected-accounts-design.md §2, Codex):
 * - Uploading the auth.json created by the official `codex login` is OpenAI's own documented
 *   CI/CD pattern for running Codex on other machines.
 * - The file is read only AFTER explicit consent naming the exact path and upload target.
 * - NEVER call auth.openai.com ourselves; refresh happens inside workspaces via the official CLI.
 */

/** `$CODEX_HOME/auth.json`, falling back to `~/.codex/auth.json`. */
export const codexAuthPath = (
  env: Readonly<Record<string, string | undefined>>,
  homeDirectory: string,
): string => {
  const codexHome = env.CODEX_HOME?.trim();
  return codexHome !== undefined && codexHome !== ""
    ? path.join(codexHome, "auth.json")
    : path.join(homeDirectory, ".codex", "auth.json");
};

export type CodexAuthJsonValidation =
  | { readonly ok: true; readonly authMode: "chatgpt" | "api-key" }
  | { readonly ok: false; readonly reason: string };

/** Light local parse: enough to catch the wrong file before uploading, nothing more. */
export const validateCodexAuthJson = (contents: string): CodexAuthJsonValidation => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return { ok: false, reason: "the file is not valid JSON" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "expected a JSON object" };
  }
  const record: Record<string, unknown> = { ...parsed };
  const tokens = record.tokens;
  if (
    tokens !== null &&
    typeof tokens === "object" &&
    !Array.isArray(tokens) &&
    "refresh_token" in tokens &&
    typeof tokens.refresh_token === "string" &&
    tokens.refresh_token.trim() !== ""
  ) {
    return { ok: true, authMode: "chatgpt" };
  }
  if (typeof record.OPENAI_API_KEY === "string" && record.OPENAI_API_KEY.trim() !== "") {
    return { ok: true, authMode: "api-key" };
  }
  return {
    ok: false,
    reason:
      "it has neither tokens.refresh_token nor OPENAI_API_KEY — run `codex login` to refresh it",
  };
};

const fileExists = (filePath: string): Effect.Effect<boolean> =>
  Effect.promise(() =>
    fs.access(filePath).then(
      () => true,
      () => false,
    ),
  );

export const authCodexCommand = Command.make(
  "codex",
  {
    name: Flag.string("name").pipe(
      Flag.withDefault("default"),
      Flag.withDescription("Account name (you can connect multiple Codex accounts)"),
    ),
    yes: Flag.boolean("yes").pipe(
      Flag.withAlias("y"),
      Flag.withDescription("Skip confirmation prompts"),
    ),
    file: Flag.string("file").pipe(
      Flag.optional,
      Flag.withDescription(
        "Path to auth.json (default: $CODEX_HOME/auth.json or ~/.codex/auth.json)",
      ),
    ),
  },
  ({ file, name, yes }) =>
    Effect.gen(function* () {
      const settings = yield* currentSettings;
      const client = yield* ControlPlaneClientService;
      const tools = yield* ExternalToolsService;
      const palette = makePalette(isColorEnabled());

      yield* Console.log(palette.bold("Connect your ChatGPT/Codex subscription"));
      yield* Console.log(
        "Sealant uploads the session file created by the official `codex login` — OpenAI's",
      );
      yield* Console.log(
        "documented pattern for running Codex on other machines. The Codex CLI inside workspaces",
      );
      yield* Console.log("refreshes it, and Sealant syncs the refreshed file back.");
      yield* Console.log("");

      const explicitPath = Option.getOrUndefined(file);
      const authPath = explicitPath ?? codexAuthPath(process.env, os.homedir());

      let exists = yield* fileExists(authPath);
      if (!exists && explicitPath !== undefined) {
        return yield* Effect.fail(new CliFailure({ message: `No file at ${authPath}.` }));
      }
      if (!exists) {
        const codexPath = yield* tools.which("codex");
        if (codexPath === null || !isInteractive() || yes) {
          return yield* Effect.fail(
            new CliFailure({
              message: `No Codex session found at ${authPath}.`,
              hint: "Run `codex login` on this machine (or pass --file <path> to an existing auth.json).",
            }),
          );
        }
        const runLogin = yield* confirmStep({
          message: `No auth.json at ${authPath}. Run \`codex login\` now?`,
          yes: false,
        });
        if (!runLogin) {
          return yield* Effect.fail(abortedByUser());
        }
        const exitCode = yield* tools.runInteractive("codex", ["login"]);
        if (exitCode !== 0) {
          return yield* Effect.fail(
            new CliFailure({ message: `\`codex login\` exited with code ${exitCode}.` }),
          );
        }
        yield* Console.log("");
        exists = yield* fileExists(authPath);
        if (!exists) {
          return yield* Effect.fail(
            new CliFailure({ message: `Still no auth.json at ${authPath} after \`codex login\`.` }),
          );
        }
      }

      // Explicit consent BEFORE the file is read — the path and the upload target are both named.
      const consent = yield* confirmStep({
        message: `Read ${authPath} and upload it to ${settings.apiUrl.value}?`,
        yes,
      });
      if (!consent) {
        return yield* Effect.fail(abortedByUser());
      }

      const contents = yield* Effect.tryPromise({
        try: () => fs.readFile(authPath, "utf8"),
        catch: (cause) =>
          new CliFailure({ message: `Could not read ${authPath}: ${describeUnknown(cause)}.` }),
      });

      const validated = validateCodexAuthJson(contents);
      if (!validated.ok) {
        return yield* Effect.fail(
          new CliFailure({
            message: `${authPath} does not look like a Codex session: ${validated.reason}.`,
          }),
        );
      }

      // Secret is the verbatim file contents so the control plane can re-materialize the file.
      const account = yield* client.createConnectedAccount(toApiSettings(settings), {
        provider: "codex",
        name,
        secret: contents,
      });

      const identity = [account.metadata.email, account.metadata.accountId].find(
        (value): value is string => typeof value === "string" && value.trim() !== "",
      );
      yield* Console.log(
        `${palette.green("✓")} Connected ${palette.bold(`codex/${account.name}`)} (${account.status})${
          identity !== undefined ? ` — ${identity}` : ""
        }`,
      );
      yield* Console.log(
        palette.dim(
          `Bind it to a profile: sealant profiles bind <profile> --codex ${account.name}`,
        ),
      );
    }),
).pipe(Command.withDescription("Upload the Codex session created by `codex login`"));
