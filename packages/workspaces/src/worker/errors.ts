import { Effect, Schema } from "effect";

/**
 * Single typed failure for the workspace build job pipeline.
 *
 * Repository services (`@sealant/db`) and the GitHub integration each fail with their own
 * tagged errors; this is the orchestration-owned boundary error those are normalised into so
 * the worker has one error channel to reason about. It carries the human-readable `message`
 * surfaced to operators, an optional machine `errorCode`, and the original `cause` (as a
 * `Schema.Defect`) for diagnostics.
 */
export class WorkspaceBuildJobProcessingError extends Schema.TaggedErrorClass<WorkspaceBuildJobProcessingError>()(
  "WorkspaceBuildJobProcessingError",
  {
    message: Schema.String,
    errorCode: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {}

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
 * {@link WorkspaceBuildJobProcessingError}, preserving the original message and any `code`.
 */
export const toWorkspaceBuildJobProcessingError = (
  cause: unknown,
): WorkspaceBuildJobProcessingError => {
  if (cause instanceof WorkspaceBuildJobProcessingError) {
    return cause;
  }

  const errorCode = extractErrorCode(cause);

  return new WorkspaceBuildJobProcessingError({
    message: cause instanceof Error ? cause.message : "Workspace build job failed.",
    ...(errorCode === undefined ? {} : { errorCode }),
    cause,
  });
};

/**
 * Construct a {@link WorkspaceBuildJobProcessingError} for a domain failure the orchestration
 * raises itself (e.g. GitHub integration unavailable).
 */
export const workspaceBuildJobProcessingError = (input: {
  readonly message: string;
  readonly errorCode?: string;
  readonly cause?: unknown;
}): WorkspaceBuildJobProcessingError =>
  new WorkspaceBuildJobProcessingError({
    message: input.message,
    ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
    cause: input.cause ?? input.message,
  });

/**
 * Run a best-effort state update: never propagate its failure (so it cannot mask the originating
 * error), but log a warning so a failed status update is still observable instead of silent.
 * Shared by the build-job and lifecycle pipelines; `pipelineName` prefixes the log line.
 */
export const swallowingFailure =
  (pipelineName: string, operation: string) =>
  <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<void> =>
    effect.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(`${pipelineName} ${operation} failed; continuing.`, cause),
      ),
      Effect.asVoid,
    );
