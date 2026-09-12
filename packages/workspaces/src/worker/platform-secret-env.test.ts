import {
  CAPTURE_TOKEN_SECRET_ENV_NAME,
  parseWorkspaceSecretEnv,
  splitPlatformSecretEnv,
} from "@sealant/api-contracts/workspace-environment";
import { describe, expect, it } from "vitest";

describe("splitPlatformSecretEnv", () => {
  it("separates the control plane's capture token from the caller's lane, by exact name", () => {
    expect(
      splitPlatformSecretEnv({
        MEND_SESSION_TOKEN: "t",
        [CAPTURE_TOKEN_SECRET_ENV_NAME]: "t",
        SEALANT_CAPTURE_TOKEN_EXTRA: "smuggled",
      }),
    ).toEqual({
      callerEnv: { MEND_SESSION_TOKEN: "t", SEALANT_CAPTURE_TOKEN_EXTRA: "smuggled" },
      platformEnv: { SEALANT_CAPTURE_TOKEN: "t" },
    });
    // The caller lane still rejects the platform prefix, so a near-miss name fails as before, and
    // the real name can never be supplied by a caller.
    expect(parseWorkspaceSecretEnv({ SEALANT_CAPTURE_TOKEN_EXTRA: "smuggled" }).ok).toBe(false);
    expect(parseWorkspaceSecretEnv({ [CAPTURE_TOKEN_SECRET_ENV_NAME]: "t" }).ok).toBe(false);
  });
});
