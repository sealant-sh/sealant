import { Effect, Redacted, type Terminal } from "effect";
import { Prompt } from "effect/unstable/cli";

import { CliFailure } from "./errors.js";

/*
 * Prompt helpers with non-TTY degradation: every destructive/upload action gets an explicit
 * consent prompt, `--yes` skips it, and non-interactive shells fail with a clear instruction
 * instead of hanging on a prompt that can never be answered.
 */

export const isInteractive = (): boolean =>
  Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);

/** Consent gate: true with --yes, otherwise an interactive confirm (default no). */
export const confirmStep = (options: {
  readonly message: string;
  readonly yes: boolean;
}): Effect.Effect<boolean, CliFailure | Terminal.QuitError, Prompt.Environment> => {
  if (options.yes) {
    return Effect.succeed(true);
  }
  if (!isInteractive()) {
    return Effect.fail(
      new CliFailure({
        message: `Confirmation required: ${options.message}`,
        hint: "Re-run with --yes to skip prompts in non-interactive shells.",
      }),
    );
  }
  return Prompt.confirm({ message: options.message });
};

/** Hidden-input prompt for secrets; the value never echoes to the terminal. */
export const hiddenInput = (
  message: string,
): Effect.Effect<string, CliFailure | Terminal.QuitError, Prompt.Environment> => {
  if (!isInteractive()) {
    return Effect.fail(
      new CliFailure({
        message: "This step needs an interactive terminal to paste the secret.",
        hint: "Re-run in a terminal, or pass the value via the command's flag.",
      }),
    );
  }
  return Effect.map(Prompt.hidden({ message }), (secret) => Redacted.value(secret).trim());
};

/** Uniform failure for a declined consent prompt. */
export const abortedByUser = (): CliFailure =>
  new CliFailure({ message: "Aborted — nothing was read or uploaded." });
