/**
 * pg-boss records a failed delivery's error as its output: `serialize-error`, then
 * `JSON.stringify`. A bigint anywhere in the error (a failed query's parameters carry the
 * telemetry sequences) makes `JSON.stringify` throw, pg-boss emits "Do not know how to serialize a
 * BigInt" instead, and the failure is never recorded. A handler's error is rethrown as a
 * {@link JobFailure} whose every field is JSON: same name, message and stack, and the original's
 * fields as `detail`.
 */

const MAX_DEPTH = 8;

/** The error a failed delivery is recorded with. */
export class JobFailure extends Error {
  /** The original error's own fields (its cause chain included), as JSON values. */
  readonly detail: unknown;

  constructor(name: string, message: string, stack: string | undefined, detail: unknown) {
    super(message);
    this.name = name;
    if (stack !== undefined) this.stack = stack;
    this.detail = detail;
  }
}

const describeError = (error: Error, seen: WeakSet<object>, depth: number) => {
  const fields: Record<string, unknown> = { name: error.name, message: error.message };
  for (const [key, value] of Object.entries(error)) {
    fields[key] = toJson(value, seen, depth + 1);
  }
  if (error.cause !== undefined && !("cause" in fields)) {
    fields["cause"] = toJson(error.cause, seen, depth + 1);
  }
  return fields;
};

/** A JSON value standing for `value`: bigints as decimal strings, bytes as their length. */
export const toJson = (value: unknown, seen = new WeakSet<object>(), depth = 0): unknown => {
  switch (typeof value) {
    case "bigint":
      return value.toString();
    case "string":
    case "boolean":
      return value;
    case "number":
      return Number.isFinite(value) ? value : String(value);
    case "undefined":
    case "function":
    case "symbol":
      return undefined;
    case "object":
      break;
  }
  if (value === null) return null;
  if (seen.has(value)) return "[Circular]";
  if (depth >= MAX_DEPTH) return "[Truncated]";
  if (value instanceof Date) return value.toISOString();
  if (ArrayBuffer.isView(value)) return `[${value.byteLength} bytes]`;
  seen.add(value);
  try {
    if (value instanceof Error) return describeError(value, seen, depth);
    if (Array.isArray(value)) return value.map((item) => toJson(item, seen, depth + 1) ?? null);
    const fields: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const json = toJson(item, seen, depth + 1);
      if (json !== undefined) fields[key] = json;
    }
    return fields;
  } finally {
    seen.delete(value);
  }
};

/** The error to fail a delivery with: `error`, with every field a JSON value. */
export const toJobFailure = (error: unknown): JobFailure => {
  const detail = toJson(error);
  if (error instanceof Error) return new JobFailure(error.name, error.message, error.stack, detail);
  const message = typeof detail === "string" ? detail : (JSON.stringify(detail) ?? String(error));
  return new JobFailure("Error", message, undefined, detail);
};
