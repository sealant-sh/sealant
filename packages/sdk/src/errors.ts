import type { ForwardRefusalReason } from "@sealant/api-contracts";

import type { ForwardResetCause, InferenceReceipt } from "./types.js";

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

/** A typed control/transport failure from the workspace runtime daemon. */
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
  override readonly name: string = "SealantApiError";
  /** HTTP status, when the failure came from a response. */
  readonly status?: number;
  /**
   * The stable reason the control plane gave in the error's body, when it gave one (`home-held`,
   * `connected-account-missing`, `connected-account-invalid`, `user-unsupported`, …). `code` is the
   * error's type (`WorkspaceConflictError`); branch on this one.
   */
  readonly reason?: string;
  /**
   * The connected account's provider a `connected-account-missing` or `connected-account-invalid`
   * reason is about (`claude`, `codex`, `github`).
   */
  readonly provider?: string;
  /** The accounts a `connected-account-ambiguous` connect could have meant. */
  readonly candidateAccountIds?: readonly string[];
  /** An inference error after the account was resolved: the exchange's login. */
  readonly receipt?: InferenceReceipt;
  constructor(
    message: string,
    options?: {
      readonly code?: string;
      readonly status?: number;
      readonly reason?: string;
      readonly provider?: string;
      readonly candidateAccountIds?: readonly string[];
      readonly receipt?: InferenceReceipt;
      readonly cause?: unknown;
    },
  ) {
    super(message, {
      code: options?.code ?? "api_error",
      ...(options?.cause === undefined ? {} : { cause: options.cause }),
    });
    if (options?.status !== undefined) {
      this.status = options.status;
    }
    if (options?.reason !== undefined) {
      this.reason = options.reason;
    }
    if (options?.provider !== undefined) {
      this.provider = options.provider;
    }
    if (options?.candidateAccountIds !== undefined) {
      this.candidateAccountIds = options.candidateAccountIds;
    }
    if (options?.receipt !== undefined) {
      this.receipt = options.receipt;
    }
  }
}

/**
 * Why a workspace forward did not open. Core names every refusal it sends. The SDK adds
 * `unrecognized-refusal` (Core sent a reason newer than this SDK; it is kept in `wireReason`),
 * `protocol-unsupported` (the control plane predates typed refusals, or answered with something
 * unreadable) and `transport-unavailable` (no answer could be read at all).
 */
export type ForwardDialReason =
  | ForwardRefusalReason
  | "unrecognized-refusal"
  | "protocol-unsupported"
  | "transport-unavailable";

export type ForwardDialFailure =
  | {
      readonly reason: ForwardRefusalReason;
      readonly status: number;
      readonly message: string;
    }
  | {
      readonly reason: "unrecognized-refusal";
      readonly wireReason: string;
      readonly status: number;
      readonly message: string;
    }
  | {
      readonly reason: "protocol-unsupported" | "transport-unavailable";
      readonly message: string;
    };

/** A workspace forward was refused before it opened. Branch on `reason`. */
export class ForwardDialError extends SealantApiError {
  override readonly name: string = "ForwardDialError";
  override readonly reason: ForwardDialReason;
  /** The reason Core sent, when this SDK does not know it (`unrecognized-refusal`). */
  readonly wireReason?: string;
  constructor(failure: ForwardDialFailure) {
    super(failure.message, {
      code: "ForwardDialError",
      reason: failure.reason,
      ...("status" in failure ? { status: failure.status } : {}),
    });
    this.reason = failure.reason;
    if ("wireReason" in failure) {
      this.wireReason = failure.wireReason;
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

/** A bounded forward was reset after it opened. Its streams error with this. */
export class ForwardResetError extends SealantError {
  override readonly name: string = "ForwardResetError";
  readonly reason: ForwardResetCause;
  /** The reason Core sent, when this SDK does not know it (`unrecognized-reset`). */
  readonly wireReason?: string;
  constructor(reason: ForwardResetCause, wireReason?: string) {
    super(`The forward was reset: ${wireReason ?? reason}.`, { code: "ForwardResetError" });
    this.reason = reason;
    if (wireReason !== undefined) this.wireReason = wireReason;
  }
}
