import { Data } from "effect";

/**
 * Expected, user-facing CLI failure. Rendered by `main.ts` as a clean one-line error (plus an
 * optional dim hint) with exit code 1 — never a stack trace. Anything else that escapes a handler
 * is treated as a bug and reported by the runtime.
 */
export class CliFailure extends Data.TaggedError("CliFailure")<{
  readonly message: string;
  readonly hint?: string;
}> {}

/** One-line description of an unknown thrown value, for wrapping into `CliFailure` messages. */
export const describeUnknown = (cause: unknown): string => {
  if (cause instanceof Error) {
    const inner = cause.cause;
    if (inner instanceof Error && inner.message.trim() !== "") {
      return inner.message;
    }
    if (
      inner !== null &&
      typeof inner === "object" &&
      "code" in inner &&
      typeof inner.code === "string"
    ) {
      return inner.code;
    }
    return cause.message;
  }
  return String(cause);
};
