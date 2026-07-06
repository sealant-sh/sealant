/**
 * Maps any failure crossing the Effect boundary onto a plain public `SealantError`. The Effect core
 * fails with `@sealant/api-contracts` tagged errors (e.g. `WorkspaceNotFoundError`), Effect HTTP-client
 * errors, or schema decode errors; the runtime squashes the `Cause` to its failure value and hands it
 * here. This is the single funnel that keeps Effect internals out of the public, Promise-based API.
 */
import { SealantApiError, SealantError } from "../errors.js";

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;

const extractStatus = (record: Record<string, unknown> | undefined): number | undefined => {
  if (record === undefined) {
    return undefined;
  }
  if (typeof record["status"] === "number") {
    return record["status"] as number;
  }
  const response = asRecord(record["response"]);
  if (response !== undefined && typeof response["status"] === "number") {
    return response["status"] as number;
  }
  return undefined;
};

export const toSealantError = (cause: unknown): SealantError => {
  if (cause instanceof SealantError) {
    return cause;
  }

  const record = asRecord(cause);
  const tag = record === undefined ? undefined : record["_tag"];
  const message =
    record !== undefined && typeof record["message"] === "string"
      ? (record["message"] as string)
      : cause instanceof Error
        ? cause.message
        : typeof cause === "string"
          ? cause
          : "Sealant operation failed.";

  if (typeof tag === "string") {
    const status = extractStatus(record);
    return new SealantApiError(message, {
      code: tag,
      ...(status === undefined ? {} : { status }),
      cause,
    });
  }

  return new SealantError(message, { cause });
};
