import { Schema } from "effect";

/**
 * Single typed failure for the sandbox build job pipeline.
 *
 * Repository services (`@sealant/db`) and the GitHub integration each fail with their own
 * tagged errors; this is the orchestration-owned boundary error those are normalised into so
 * the worker has one error channel to reason about. It carries the human-readable `message`
 * surfaced to operators, an optional machine `errorCode`, and the original `cause` (as a
 * `Schema.Defect`) for diagnostics.
 */
export class SandboxBuildJobProcessingError extends Schema.TaggedError<SandboxBuildJobProcessingError>(
  "SandboxBuildJobProcessingError",
)("SandboxBuildJobProcessingError", {
  message: Schema.String,
  errorCode: Schema.optional(Schema.String),
  cause: Schema.Defect,
}) {}

const extractErrorCode = (cause: unknown): string | undefined => {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    typeof (cause as { code: unknown }).code === "string"
  ) {
    return (cause as { code: string }).code;
  }

  return undefined;
};

/**
 * Normalise an arbitrary failure (repo error, external rejection, thrown `Error`, …) into a
 * {@link SandboxBuildJobProcessingError}, preserving the original message and any `code`.
 */
export const toSandboxBuildJobProcessingError = (
  cause: unknown,
): SandboxBuildJobProcessingError => {
  if (cause instanceof SandboxBuildJobProcessingError) {
    return cause;
  }

  const errorCode = extractErrorCode(cause);

  return new SandboxBuildJobProcessingError({
    message: cause instanceof Error ? cause.message : "Sandbox build job failed.",
    ...(errorCode === undefined ? {} : { errorCode }),
    cause,
  });
};

/**
 * Construct a {@link SandboxBuildJobProcessingError} for a domain failure the orchestration
 * raises itself (e.g. GitHub integration unavailable).
 */
export const sandboxBuildJobProcessingError = (input: {
  readonly message: string;
  readonly errorCode?: string;
  readonly cause?: unknown;
}): SandboxBuildJobProcessingError =>
  new SandboxBuildJobProcessingError({
    message: input.message,
    ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
    cause: input.cause ?? input.message,
  });
