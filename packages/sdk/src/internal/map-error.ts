/**
 * Maps any failure crossing the Effect boundary onto a plain public `SealantError`. The Effect core
 * fails with `@sealant/api-contracts` tagged errors (e.g. `WorkspaceNotFoundError`), Effect HTTP-client
 * errors, or schema decode errors; the runtime squashes the `Cause` to its failure value and hands it
 * here. This is the single funnel that keeps Effect internals out of the public, Promise-based API.
 */
import {
  boatFailureSchema,
  boatKeyReportSchema,
  BudgetExceededError,
} from "@sealant/api-contracts";
import { Option, Predicate, Schema } from "effect";

import { SealantApiError, SealantBudgetExceededError, SealantError } from "../errors.js";
import type { InferenceReceipt } from "../types.js";

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  Predicate.isObject(value) ? value : undefined;

const extractStatus = (record: Record<string, unknown> | undefined): number | undefined => {
  if (record === undefined) {
    return undefined;
  }
  if (typeof record["status"] === "number") {
    return record["status"];
  }
  const response = asRecord(record["response"]);
  if (response !== undefined && typeof response["status"] === "number") {
    return response["status"];
  }
  return undefined;
};

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const toReceipt = (value: unknown): InferenceReceipt | undefined => {
  const record = asRecord(value);
  const accountId = nonEmptyString(record?.["accountId"]);
  const revision = record?.["revision"];
  const login = record?.["login"];
  return accountId !== undefined &&
    typeof revision === "number" &&
    (login === "subscription" || login === "api-key")
    ? { accountId, revision, login }
    : undefined;
};

export const toSealantError = (cause: unknown): SealantError => {
  if (cause instanceof SealantError) {
    return cause;
  }

  const record = asRecord(cause);
  const tag = record === undefined ? undefined : record["_tag"];
  const message =
    record !== undefined && typeof record["message"] === "string"
      ? record["message"]
      : cause instanceof Error
        ? cause.message
        : typeof cause === "string"
          ? cause
          : "Sealant operation failed.";

  if (tag === "BudgetExceededError") {
    const budget = Schema.decodeUnknownOption(BudgetExceededError)(cause);
    if (Option.isSome(budget)) {
      const receipt = toReceipt(record?.["receipt"]);
      return new SealantBudgetExceededError(message, {
        budget: budget.value.budget,
        limit: budget.value.limit,
        retryAfterSeconds: budget.value.retryAfterSeconds,
        ...(budget.value.refusal === undefined ? {} : { refusal: budget.value.refusal }),
        ...(receipt === undefined ? {} : { receipt }),
        cause,
      });
    }
  }

  if (typeof tag === "string") {
    const status = extractStatus(record);
    const reason = nonEmptyString(record?.["code"]);
    const provider = nonEmptyString(record?.["provider"]);
    const candidates = record?.["candidateAccountIds"];
    const candidateAccountIds = Array.isArray(candidates)
      ? candidates.filter((id): id is string => typeof id === "string")
      : undefined;
    const receipt = toReceipt(record?.["receipt"]);
    const boat = Schema.decodeUnknownOption(boatFailureSchema)(record?.["boat"]);
    const missing = record?.["missingPermissions"];
    const missingPermissions = Array.isArray(missing)
      ? missing.filter((name): name is string => typeof name === "string")
      : undefined;
    const report = Schema.decodeUnknownOption(boatKeyReportSchema)(record?.["report"]);
    return new SealantApiError(message, {
      code: tag,
      ...(status === undefined ? {} : { status }),
      ...(reason === undefined ? {} : { reason }),
      ...(provider === undefined ? {} : { provider }),
      ...(candidateAccountIds === undefined ? {} : { candidateAccountIds }),
      ...(receipt === undefined ? {} : { receipt }),
      ...(Option.isSome(boat) ? { boat: boat.value } : {}),
      ...(missingPermissions === undefined ? {} : { missingPermissions }),
      ...(tag === "BoatAccountKeyRefusedError" && Option.isSome(report)
        ? { boatKeyReport: report.value }
        : {}),
      cause,
    });
  }

  return new SealantError(message, { cause });
};
