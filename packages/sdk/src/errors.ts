/**
 * Public SDK errors. The Effect core fails on a typed `Schema.TaggedError` channel; the facade maps
 * every tagged failure onto one of these PLAIN `Error` subclasses (a single `_tag` switch) so the
 * public, Promise-based surface never leaks Effect internals. Consumers `catch` ordinary `Error`s.
 */

/** Base class for every error the SDK throws. */
export class SealantError extends Error {
  override readonly name: string = "SealantError";
  /** Stable, machine-readable code for branching on the failure. */
  readonly code: string;

  constructor(message: string, options?: { readonly code?: string; readonly cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.code = options?.code ?? "sealant_error";
  }
}

/** A typed control/transport failure from the sandbox runtime daemon. */
export class SealantRuntimeError extends SealantError {
  override readonly name = "SealantRuntimeError";
  constructor(message: string, options?: { readonly code?: string; readonly cause?: unknown }) {
    super(message, {
      code: options?.code ?? "runtime_error",
      ...(options?.cause === undefined ? {} : { cause: options.cause }),
    });
  }
}

/** A control-plane API request failed (HTTP-level or typed API error). */
export class SealantApiError extends SealantError {
  override readonly name = "SealantApiError";
  /** HTTP status, when the failure came from a response. */
  readonly status?: number;
  constructor(
    message: string,
    options?: { readonly code?: string; readonly status?: number; readonly cause?: unknown },
  ) {
    super(message, {
      code: options?.code ?? "api_error",
      ...(options?.cause === undefined ? {} : { cause: options.cause }),
    });
    if (options?.status !== undefined) {
      this.status = options.status;
    }
  }
}

/** The requested operation is part of the public surface but not yet implemented in this slice. */
export class SealantNotImplementedError extends SealantError {
  override readonly name = "SealantNotImplementedError";
  constructor(operation: string) {
    super(
      `${operation} is part of the Sealant SDK surface but is not implemented in this build yet.`,
      { code: "not_implemented" },
    );
  }
}
