import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Console, Effect, Option } from "effect";
import { Command, Flag } from "effect/cli";

import { ControlPlaneClientService, toApiSettings } from "../api-client.js";
import { currentSettings } from "../config.js";
import { CliFailure, describeUnknown } from "../errors.js";
import { abortedByUser, confirmStep, isInteractive } from "../prompts.js";
import { isColorEnabled, makePalette } from "../render.js";
import { ExternalToolsService } from "../tools.js";

/** `~/.gemini/antigravity-cli/antigravity-oauth-token`. */
export const antigravityTokenPath = (homeDirectory: string): string =>
  path.join(homeDirectory, ".gemini", "antigravity-cli", "antigravity-oauth-token");

export type AntigravityTokenValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/** Light local parse: enough to catch the wrong file before uploading. */
export const validateAntigravityTokenJson = (contents: string): AntigravityTokenValidation => {
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
  const token = record.token;
  if (token === null || typeof token !== "object" || Array.isArray(token)) {
    return { ok: false, reason: "it has no token object — sign in with `agy` first" };
  }
  const hasAccess =
    "access_token" in token &&
    typeof token.access_token === "string" &&
    token.access_token.trim() !== "";
  const hasRefresh =
    "refresh_token" in token &&
    typeof token.refresh_token === "string" &&
    token.refresh_token.trim() !== "";
  if (!hasAccess || !hasRefresh) {
    return {
      ok: false,
      reason: "it needs both token.access_token and token.refresh_token — sign in with `agy` first",
    };
  }
  return { ok: true };
};

const fileExists = (filePath: string): Effect.Effect<boolean> =>
  Effect.promise(() =>
    fs.access(filePath).then(
      () => true,
      () => false,
    ),
  );

export const authAntigravityCommand = Command.make(
  "antigravity",
  {
    name: Flag.String("name").pipe(
      Flag.optional,
      Flag.withDescription(
        "Account name: replaces the account of that name or connects a new one (default: your only Antigravity account, or a first one named default)",
      ),
    ),
    yes: Flag.Boolean("yes").pipe(
      Flag.withAlias("y"),
      Flag.withDescription("Skip confirmation prompts"),
    ),
    file: Flag.String("file").pipe(
      Flag.optional,
      Flag.withDescription(
        "Path to antigravity-oauth-token (default: ~/.gemini/antigravity-cli/antigravity-oauth-token)",
      ),
    ),
  },
  ({ file, name, yes }) =>
    Effect.gen(function* () {
      const settings = yield* currentSettings;
      const client = yield* ControlPlaneClientService;
      const tools = yield* ExternalToolsService;
      const palette = makePalette(isColorEnabled());

      yield* Console.log(palette.bold("Connect your Google Antigravity login"));
      yield* Console.log(
        "Sealant uploads the OAuth token created by the official `agy` CLI. Workspaces receive a",
      );
      yield* Console.log(
        "copy without the refresh token; Sealant refreshes it in the background and pushes fresh",
      );
      yield* Console.log("access tokens to running workspaces.");
      yield* Console.log("");

      const explicitPath = Option.getOrUndefined(file);
      const tokenPath = explicitPath ?? antigravityTokenPath(os.homedir());

      let exists = yield* fileExists(tokenPath);
      if (!exists && explicitPath !== undefined) {
        return yield* Effect.fail(new CliFailure({ message: `No file at ${tokenPath}.` }));
      }
      if (!exists) {
        const agyPath = yield* tools.which("agy");
        if (agyPath === null || !isInteractive() || yes) {
          return yield* Effect.fail(
            new CliFailure({
              message: `No Antigravity login found at ${tokenPath}.`,
              hint: "Sign in with `agy` on this machine (or pass --file <path> to an existing antigravity-oauth-token).",
            }),
          );
        }
        const runLogin = yield* confirmStep({
          message: `No antigravity-oauth-token at ${tokenPath}. Launch \`agy\` to sign in now?`,
          yes: false,
        });
        if (!runLogin) {
          return yield* Effect.fail(abortedByUser());
        }
        const exitCode = yield* tools.runInteractive("agy", []);
        if (exitCode !== 0) {
          return yield* Effect.fail(
            new CliFailure({ message: `\`agy\` exited with code ${exitCode}.` }),
          );
        }
        yield* Console.log("");
        exists = yield* fileExists(tokenPath);
        if (!exists) {
          return yield* Effect.fail(
            new CliFailure({
              message: `Still no antigravity-oauth-token at ${tokenPath} after running \`agy\`.`,
            }),
          );
        }
      }

      const consent = yield* confirmStep({
        message: `Read ${tokenPath} and upload it to ${settings.apiUrl.value}?`,
        yes,
      });
      if (!consent) {
        return yield* Effect.fail(abortedByUser());
      }

      const contents = yield* Effect.tryPromise({
        try: () => fs.readFile(tokenPath, "utf8"),
        catch: (cause) =>
          new CliFailure({ message: `Could not read ${tokenPath}: ${describeUnknown(cause)}.` }),
      });

      const validated = validateAntigravityTokenJson(contents);
      if (!validated.ok) {
        return yield* Effect.fail(
          new CliFailure({
            message: `${tokenPath} does not look like an Antigravity token: ${validated.reason}.`,
          }),
        );
      }

      const account = yield* client.createConnectedAccount(toApiSettings(settings), {
        provider: "antigravity",
        name: Option.getOrUndefined(name),
        secret: contents,
      });

      const identity =
        typeof account.metadata.email === "string" && account.metadata.email.trim() !== ""
          ? account.metadata.email
          : undefined;
      yield* Console.log(
        `${palette.green("✓")} Connected ${palette.bold(`antigravity/${account.name}`)} (${account.status})${
          identity !== undefined ? ` — ${identity}` : ""
        }`,
      );
      yield* Console.log(
        palette.dim(
          `Bind it to a profile: sealant profiles bind <profile> --antigravity ${account.name}`,
        ),
      );
    }),
).pipe(Command.withDescription("Upload the Antigravity Google OAuth token created by `agy`"));
