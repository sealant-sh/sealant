import { inspect } from "node:util";

import { z } from "zod";

export class BoatApiError extends Error {
  readonly _tag = "BoatApiError";

  constructor(
    readonly operation: string,
    readonly status: number | null,
    readonly code: string,
  ) {
    super(
      `Boat request failed during ${operation}: ${code}${status === null ? "" : ` (HTTP ${status})`}`,
    );
  }
}

export type BoatResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: BoatApiError };

export class BoatSecret {
  readonly #value: string;

  private constructor(value: string) {
    this.#value = value;
  }

  static parse(value: unknown): BoatResult<BoatSecret> {
    if (typeof value !== "string" || !/^[A-Za-z0-9._~-]{16,4096}$/.test(value)) {
      return { ok: false, error: new BoatApiError("credential", null, "invalid_credential") };
    }
    return { ok: true, value: new BoatSecret(value) };
  }

  reveal(): string {
    return this.#value;
  }

  toJSON(): string {
    return "[REDACTED]";
  }

  toString(): string {
    return "[REDACTED]";
  }

  [inspect.custom](): string {
    return "[REDACTED]";
  }
}

export const boatSandboxIdSchema = z
  .string()
  .regex(/^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/)
  .brand<"BoatSandboxId">();
export type BoatSandboxId = z.infer<typeof boatSandboxIdSchema>;
export const boatDeletionIdSchema = z
  .string()
  .regex(/^bdop_[a-f0-9]{32}$/)
  .brand<"BoatDeletionId">();
export type BoatDeletionId = z.infer<typeof boatDeletionIdSchema>;
/** Snapshot names are provider handles, independent of source sandbox lifetime. */
export const boatSnapshotNameSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,62}$/)
  .brand<"BoatSnapshotName">();
export type BoatSnapshotName = z.infer<typeof boatSnapshotNameSchema>;

export const parseBoatUrl = (input: string): BoatResult<URL> => {
  try {
    const url = new URL(input);
    if (
      url.protocol !== "https:" ||
      !/^[a-z0-9-]+\.on\.boat\.dev$/.test(url.hostname) ||
      url.port !== "" ||
      url.username !== "" ||
      url.password !== "" ||
      url.hash !== ""
    ) {
      return { ok: false, error: new BoatApiError("url", null, "invalid_provider_url") };
    }
    return { ok: true, value: url };
  } catch {
    return { ok: false, error: new BoatApiError("url", null, "invalid_provider_url") };
  }
};
