import { SealantError } from "../errors.js";

const DURATION_PATTERN = /^(\d+)(ms|s|m|h|d)$/;

const UNIT_SECONDS: Record<string, number> = {
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
};

/**
 * Parse a human TTL like `"90m"`, `"2h"`, `"45s"`, `"1d"` into whole seconds (milliseconds round
 * up to at least 1s — the wire TTL is second-granular). Throws a typed `SealantError` on anything
 * else so a typo'd TTL fails at the call site instead of silently never expiring.
 */
export const parseTtlSeconds = (ttl: string): number => {
  const match = DURATION_PATTERN.exec(ttl.trim());
  if (match === null) {
    throw new SealantError(
      `Invalid TTL duration "${ttl}". Use a positive integer with a unit: e.g. "45s", "90m", "2h", "1d".`,
      { code: "invalid_ttl" },
    );
  }

  const value = Number.parseInt(match[1] ?? "", 10);
  const unit = match[2] ?? "";
  if (!Number.isInteger(value) || value <= 0) {
    throw new SealantError(`Invalid TTL duration "${ttl}". The value must be a positive integer.`, {
      code: "invalid_ttl",
    });
  }

  if (unit === "ms") {
    return Math.max(1, Math.ceil(value / 1000));
  }

  const multiplier = UNIT_SECONDS[unit];
  if (multiplier === undefined) {
    throw new SealantError(`Invalid TTL duration "${ttl}".`, { code: "invalid_ttl" });
  }
  return value * multiplier;
};
