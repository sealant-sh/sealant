import { statSync } from "node:fs";
import { tmpdir } from "node:os";

import { describe, expect, it } from "@effect/vitest";

import { provisionCodexHome, readCodexHomeAuthJson, removeCodexHome } from "./codex-session.js";

describe("codex home provisioning", () => {
  const authJson = JSON.stringify({
    tokens: { refresh_token: "rt-test", access_token: "at-test" },
    last_refresh: "2026-08-01T00:00:00.000Z",
  });

  it("materializes a private dir (0700) with a private file (0600) and reads it back", () => {
    const provisioned = provisionCodexHome({ authJson });
    try {
      expect(provisioned.codexHome.startsWith(tmpdir())).toBe(true);
      expect(statSync(provisioned.codexHome).mode & 0o777).toBe(0o700);
      expect(statSync(provisioned.authJsonPath).mode & 0o777).toBe(0o600);
      expect(readCodexHomeAuthJson(provisioned.codexHome)).toBe(authJson);
    } finally {
      removeCodexHome(provisioned.codexHome);
    }
  });

  it("returns undefined for a missing file and removal is idempotent", () => {
    const provisioned = provisionCodexHome({ authJson });
    removeCodexHome(provisioned.codexHome);
    expect(readCodexHomeAuthJson(provisioned.codexHome)).toBeUndefined();
    // Removing an already-removed dir must not throw.
    removeCodexHome(provisioned.codexHome);
  });
});
