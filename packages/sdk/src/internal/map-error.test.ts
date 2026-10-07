import { describe, expect, it } from "vitest";

import { SealantApiError, SealantError } from "../errors.js";
import { toSealantError } from "./map-error.js";

describe("toSealantError", () => {
  it("passes through an existing SealantError unchanged", () => {
    const original = new SealantError("already mapped");
    expect(toSealantError(original)).toBe(original);
  });

  it("maps a tagged api error to SealantApiError with code + status", () => {
    const mapped = toSealantError({ _tag: "WorkspaceNotFoundError", message: "nope", status: 404 });
    expect(mapped).toBeInstanceOf(SealantApiError);
    expect(mapped.code).toBe("WorkspaceNotFoundError");
    expect(mapped.message).toBe("nope");
    expect((mapped as SealantApiError).status).toBe(404);
  });

  it("carries a body's stable code as `reason` and the account's `provider`", () => {
    const missing = toSealantError({
      _tag: "WorkspaceNotFoundError",
      message: 'No claude connected account matches "default".',
      code: "connected-account-missing",
      provider: "claude",
      status: 404,
    });
    expect(missing).toBeInstanceOf(SealantApiError);
    expect(missing).toMatchObject({
      code: "WorkspaceNotFoundError",
      reason: "connected-account-missing",
      provider: "claude",
      status: 404,
    });
    const held = toSealantError({
      _tag: "WorkspaceConflictError",
      message: "m",
      code: "home-held",
    });
    expect(held).toMatchObject({ reason: "home-held" });
    expect(held).toMatchObject({ provider: undefined });
    expect(toSealantError({ _tag: "WorkspaceNotFoundError", message: "m" })).toMatchObject({
      reason: undefined,
    });
  });

  it("reads status from a nested HTTP response", () => {
    const mapped = toSealantError({
      _tag: "RequestError",
      message: "bad",
      response: { status: 400 },
    });
    expect((mapped as SealantApiError).status).toBe(400);
  });

  it("falls back to a plain SealantError for strings and Errors", () => {
    expect(toSealantError("boom").message).toBe("boom");
    expect(toSealantError(new Error("kaboom")).message).toBe("kaboom");
    expect(toSealantError(undefined).message).toBe("Sealant operation failed.");
  });
});
