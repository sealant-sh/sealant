import { IssueWorkflowImportParseError, type IssueWorkflowProvider } from "./types.js";

export interface UnknownRecord {
  readonly [key: string]: unknown;
}

export function isUnknownRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readRecord(record: UnknownRecord, key: string): UnknownRecord | null {
  const value = record[key];

  return isUnknownRecord(value) ? value : null;
}

export function readArray(record: UnknownRecord, key: string): readonly unknown[] {
  const value = record[key];

  return Array.isArray(value) ? value : [];
}

export function requireArray(
  provider: IssueWorkflowProvider,
  value: unknown,
  label: string,
): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new IssueWorkflowImportParseError(provider, `Expected ${label} to be an array.`);
  }

  return value;
}

export function readString(record: UnknownRecord, key: string): string | null {
  const value = record[key];

  return typeof value === "string" && value.length > 0 ? value : null;
}

export function readNumber(record: UnknownRecord, key: string): number | null {
  const value = record[key];

  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function readBoolean(record: UnknownRecord, key: string): boolean | null {
  const value = record[key];

  return typeof value === "boolean" ? value : null;
}

export function readRequiredString(
  provider: IssueWorkflowProvider,
  record: UnknownRecord,
  key: string,
): string {
  const value = readString(record, key);

  if (value === null) {
    throw new IssueWorkflowImportParseError(provider, `Expected ${key} to be a non-empty string.`);
  }

  return value;
}

export function readRequiredNumber(
  provider: IssueWorkflowProvider,
  record: UnknownRecord,
  key: string,
): number {
  const value = readNumber(record, key);

  if (value === null) {
    throw new IssueWorkflowImportParseError(provider, `Expected ${key} to be a finite number.`);
  }

  return value;
}

export function requireRecord(
  provider: IssueWorkflowProvider,
  value: unknown,
  label: string,
): UnknownRecord {
  if (!isUnknownRecord(value)) {
    throw new IssueWorkflowImportParseError(provider, `Expected ${label} to be an object.`);
  }

  return value;
}

export function normalizeDateString(value: string | null): string | null {
  if (value === null) {
    return null;
  }

  const timestamp = Date.parse(value);

  if (Number.isNaN(timestamp)) {
    return null;
  }

  return new Date(timestamp).toISOString();
}

export function toImportedAt(input: Date | string | null): string {
  if (input instanceof Date) {
    return input.toISOString();
  }

  if (typeof input === "string") {
    return normalizeDateString(input) ?? new Date().toISOString();
  }

  return new Date().toISOString();
}

export function firstString(values: readonly string[]): string | null {
  return values[0] ?? null;
}
