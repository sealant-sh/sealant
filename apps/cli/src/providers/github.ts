import { Console, Effect, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";

import { ControlPlaneClientService, toApiSettings } from "../api-client.js";
import { currentSettings } from "../config.js";
import { CliFailure, describeUnknown } from "../errors.js";
import { abortedByUser, confirmStep } from "../prompts.js";
import { accountDetails, isColorEnabled, makePalette } from "../render.js";
import { ExternalToolsService } from "../tools.js";

/*
 * COMPLIANCE (docs/connected-accounts-design.md §2, GitHub):
 * - `gh auth token` is a documented public command; we shell out to it only after explicit
 *   consent. We never read hosts.yml/keyrings and never mint tokens with gh's client id.
 * - The only network call here is a read-only scope preflight against api.github.com using the
 *   user's own token (User-Agent required by GitHub).
 */

export const REQUIRED_SCOPE = "repo";
export const RECOMMENDED_SCOPE = "workflow";

/** Parse GitHub's `X-OAuth-Scopes` header ("repo, workflow") into a scope list. */
export const parseOAuthScopes = (header: string | null | undefined): ReadonlyArray<string> =>
  (header ?? "")
    .split(",")
    .map((scope) => scope.trim())
    .filter((scope) => scope !== "");

interface GitHubPreflight {
  readonly login: string | undefined;
  readonly scopes: ReadonlyArray<string>;
}

const preflightGitHubToken = (token: string): Effect.Effect<GitHubPreflight, CliFailure> =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () =>
        fetch("https://api.github.com/user", {
          headers: {
            Authorization: `token ${token}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "sealant-cli",
          },
        }),
      catch: (cause) =>
        new CliFailure({
          message: `Could not reach api.github.com to check the token (${describeUnknown(cause)}).`,
          hint: "Check your network and retry.",
        }),
    });
    if (response.status === 401) {
      return yield* Effect.fail(
        new CliFailure({
          message: "GitHub rejected the token (401) — it has likely been revoked or rotated.",
          hint: "Run `gh auth login`, then retry `sealant auth github`.",
        }),
      );
    }
    const scopes = parseOAuthScopes(response.headers.get("x-oauth-scopes"));
    const payload: unknown = yield* Effect.promise(() => response.json().catch(() => null));
    const login =
      payload !== null &&
      typeof payload === "object" &&
      "login" in payload &&
      typeof payload.login === "string"
        ? payload.login
        : undefined;
    return { login, scopes };
  });

export const authGithubCommand = Command.make(
  "github",
  {
    name: Flag.string("name").pipe(
      Flag.withDefault("default"),
      Flag.withDescription("Account name (you can connect multiple GitHub accounts)"),
    ),
    yes: Flag.boolean("yes").pipe(
      Flag.withAlias("y"),
      Flag.withDescription("Skip confirmation prompts"),
    ),
    token: Flag.string("token").pipe(
      Flag.optional,
      Flag.withDescription("GitHub token to upload (skips capturing it from `gh auth token`)"),
    ),
  },
  ({ name, token, yes }) =>
    Effect.gen(function* () {
      const settings = yield* currentSettings;
      const client = yield* ControlPlaneClientService;
      const tools = yield* ExternalToolsService;
      const palette = makePalette(isColorEnabled());

      yield* Console.log(palette.bold("Connect your GitHub identity"));
      yield* Console.log(
        "Sealant captures the token your gh CLI already holds (`gh auth token` is a documented",
      );
      yield* Console.log(
        "command) so sandboxes can push, pull, and call the GitHub API as you. Caveats: revoking",
      );
      yield* Console.log(
        'the "GitHub CLI" OAuth app kills it, and logging into gh on many machines expires the oldest token.',
      );
      yield* Console.log("");

      let rawToken = Option.getOrUndefined(token);
      if (rawToken === undefined) {
        const ghPath = yield* tools.which("gh");
        if (ghPath === null) {
          return yield* Effect.fail(
            new CliFailure({
              message: "GitHub CLI (`gh`) was not found on PATH.",
              hint: "Install it from https://cli.github.com and run `gh auth login`, or pass --token.",
            }),
          );
        }
        const consent = yield* confirmStep({
          message: `Capture the token from \`gh auth token\` and upload it to ${settings.apiUrl.value}?`,
          yes,
        });
        if (!consent) {
          return yield* Effect.fail(abortedByUser());
        }
        rawToken = yield* tools.capture("gh", ["auth", "token"]);
      }
      rawToken = rawToken.trim();
      if (rawToken === "") {
        return yield* Effect.fail(new CliFailure({ message: "The GitHub token is empty." }));
      }

      const preflight = yield* preflightGitHubToken(rawToken);
      if (!preflight.scopes.includes(REQUIRED_SCOPE)) {
        return yield* Effect.fail(
          new CliFailure({
            message: `The token lacks the \`${REQUIRED_SCOPE}\` scope (has: ${
              preflight.scopes.length > 0 ? preflight.scopes.join(", ") : "none"
            }), so sandboxes could not push or pull.`,
            hint: "Run `gh auth refresh -s repo,workflow`, then retry.",
          }),
        );
      }
      if (!preflight.scopes.includes(RECOMMENDED_SCOPE)) {
        yield* Console.log(
          palette.yellow(
            `warning: the token lacks the \`${RECOMMENDED_SCOPE}\` scope — pushes touching .github/workflows will be rejected.`,
          ),
        );
        yield* Console.log(palette.yellow("Add it with `gh auth refresh -s workflow`."));
      }

      const account = yield* client.createConnectedAccount(toApiSettings(settings), {
        provider: "github",
        name,
        secret: rawToken,
      });

      const details = accountDetails(account);
      const fallbackDetails =
        preflight.login !== undefined ? `${preflight.login} (${preflight.scopes.join(", ")})` : "";
      const shownDetails = details !== "" ? details : fallbackDetails;
      yield* Console.log(
        `${palette.green("✓")} Connected ${palette.bold(`github/${account.name}`)} (${account.status})${
          shownDetails !== "" ? ` — ${shownDetails}` : ""
        }`,
      );
      yield* Console.log(
        palette.dim(
          `Bind it to a profile: sealant profiles bind <profile> --github ${account.name}`,
        ),
      );
    }),
).pipe(Command.withDescription("Capture and upload the token held by the gh CLI"));
