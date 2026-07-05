import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { CliError, Command } from "effect/unstable/cli";

import packageJson from "../package.json" with { type: "json" };
import { ControlPlaneClientLive } from "./api-client.js";
import { configCommand } from "./commands/config.js";
import { profilesCommand } from "./commands/profiles.js";
import { authRemoveCommand } from "./commands/remove.js";
import { authStatusCommand } from "./commands/status.js";
import { ApiUrlFlag, CliConfigStoreLive, OwnerFlag } from "./config.js";
import { CliFailure, describeUnknown } from "./errors.js";
import { authClaudeCommand } from "./providers/claude.js";
import { authCodexCommand } from "./providers/codex.js";
import { authGithubCommand } from "./providers/github.js";
import { makePalette } from "./render.js";
import { ExternalToolsLive } from "./tools.js";

const authCommand = Command.make("auth").pipe(
  Command.withDescription("Connect and manage AI-subscription and GitHub credentials"),
  Command.withSubcommands([
    authClaudeCommand,
    authCodexCommand,
    authGithubCommand,
    authStatusCommand,
    authRemoveCommand,
  ]),
);

const rootCommand = Command.make("sealant").pipe(
  Command.withDescription(
    "Sealant CLI — connect AI-subscription credentials to your self-hosted control plane",
  ),
  Command.withSubcommands([authCommand, profilesCommand, configCommand]),
  Command.withGlobalFlags([ApiUrlFlag, OwnerFlag]),
);

const MainLive = Layer.mergeAll(
  NodeServices.layer,
  CliConfigStoreLive,
  ControlPlaneClientLive,
  ExternalToolsLive,
);

/**
 * Expected failures render as clean one-liners with exit code 1 — never stack traces. Anything
 * uncaught here is a bug and is reported by the runtime as a defect.
 */
const handleFailure = (error: unknown): Effect.Effect<void> =>
  Effect.sync(() => {
    const palette = makePalette(
      Boolean(process.stderr.isTTY) && process.env.NO_COLOR === undefined,
    );
    if (error instanceof CliFailure) {
      console.error(palette.red(`error: ${error.message}`));
      if (error.hint !== undefined) {
        console.error(palette.dim(error.hint));
      }
      process.exitCode = 1;
      return;
    }
    if (CliError.isCliError(error)) {
      if (error instanceof CliError.ShowHelp) {
        // Help text was already rendered by the framework.
        process.exitCode = error.errors.length > 0 ? 1 : 0;
        return;
      }
      console.error(palette.red(`error: ${error.message}`));
      process.exitCode = 1;
      return;
    }
    console.error(palette.red(`unexpected error: ${describeUnknown(error)}`));
    process.exitCode = 1;
  });

Command.run(rootCommand, { version: packageJson.version }).pipe(
  Effect.catch(handleFailure),
  Effect.provide(MainLive),
  NodeRuntime.runMain(),
);
