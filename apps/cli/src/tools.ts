import { execFile, spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import * as path from "node:path";

import { Context, Effect, Layer } from "effect";

import { CliFailure, describeUnknown } from "./errors.js";

/*
 * External tool runner: locating and spawning the official provider CLIs (`claude`, `codex`,
 * `gh`). Interactive spawns inherit stdio so the provider's own auth flow runs untouched — the
 * Sealant CLI never participates in any provider OAuth loop.
 */

/** All PATH entries joined with the command name — pure, for unit tests. */
export const candidateExecutablePaths = (
  command: string,
  pathVariable: string | undefined,
  delimiter: string = path.delimiter,
): ReadonlyArray<string> =>
  (pathVariable ?? "")
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
    .map((directory) => path.join(directory, command));

export interface ExternalTools {
  /** Absolute path of the executable on PATH, or null when absent. */
  readonly which: (command: string) => Effect.Effect<string | null>;
  /** Spawn with inherited stdio (interactive provider flows). Resolves with the exit code. */
  readonly runInteractive: (
    command: string,
    args: ReadonlyArray<string>,
  ) => Effect.Effect<number, CliFailure>;
  /** Run non-interactively and capture trimmed stdout; non-zero exit becomes a CliFailure. */
  readonly capture: (
    command: string,
    args: ReadonlyArray<string>,
  ) => Effect.Effect<string, CliFailure>;
}

export class ExternalToolsService extends Context.Service<ExternalToolsService, ExternalTools>()(
  "@sealant/cli/ExternalToolsService",
) {}

const makeExternalTools = (): ExternalTools => ({
  which: (command) =>
    Effect.sync(() => {
      for (const candidate of candidateExecutablePaths(command, process.env.PATH)) {
        try {
          accessSync(candidate, constants.X_OK);
          return candidate;
        } catch {
          // keep looking
        }
      }
      return null;
    }),
  runInteractive: (command, args) =>
    Effect.tryPromise({
      try: () =>
        new Promise<number>((resolvePromise, rejectPromise) => {
          const child = spawn(command, [...args], { stdio: "inherit" });
          child.once("error", rejectPromise);
          child.once("exit", (code) => resolvePromise(code ?? 0));
        }),
      catch: (cause) =>
        new CliFailure({
          message: `Failed to run \`${command} ${args.join(" ")}\`: ${describeUnknown(cause)}.`,
        }),
    }),
  capture: (command, args) =>
    Effect.tryPromise({
      try: () =>
        new Promise<string>((resolvePromise, rejectPromise) => {
          execFile(command, [...args], { encoding: "utf8" }, (error, stdout, stderr) => {
            if (error !== null) {
              const detail = stderr.trim() !== "" ? stderr.trim() : error.message;
              rejectPromise(new Error(detail));
              return;
            }
            resolvePromise(stdout.trim());
          });
        }),
      catch: (cause) =>
        new CliFailure({
          message: `\`${command} ${args.join(" ")}\` failed: ${describeUnknown(cause)}.`,
        }),
    }),
});

export const ExternalToolsLive: Layer.Layer<ExternalToolsService> = Layer.sync(
  ExternalToolsService,
  makeExternalTools,
);
