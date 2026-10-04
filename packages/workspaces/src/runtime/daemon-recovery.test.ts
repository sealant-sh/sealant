import { describe, expect, it } from "vitest";

import {
  declaredRecoveryBootImages,
  sealantdHasRecoveryBoot,
  sealantdImageOfContainerfile,
} from "./daemon-recovery.js";

describe("sealantdHasRecoveryBoot", () => {
  it("knows released daemons by version: before 0.19.0 without it, from 0.19.0 with it", () => {
    expect(sealantdHasRecoveryBoot("ghcr.io/sealant-sh/sealantd:0.18.2", [])).toBe(false);
    expect(sealantdHasRecoveryBoot("ghcr.io/sealant-sh/sealantd:0.9.9", [])).toBe(false);
    expect(sealantdHasRecoveryBoot("ghcr.io/sealant-sh/sealantd:0.19.0", [])).toBe(true);
    expect(sealantdHasRecoveryBoot("ghcr.io/sealant-sh/sealantd:0.20.3", [])).toBe(true);
    expect(sealantdHasRecoveryBoot("ghcr.io/sealant-sh/sealantd:1.0.0", [])).toBe(true);
    expect(
      sealantdHasRecoveryBoot(`ghcr.io/sealant-sh/sealantd:0.19.1@sha256:${"a".repeat(64)}`, []),
    ).toBe(true);
  });

  it("knows a prerelease from sealantd's main by the version it leads to", () => {
    expect(sealantdHasRecoveryBoot("ghcr.io/sealant-sh/sealantd:0.20.0-next.7", [])).toBe(true);
    expect(
      sealantdHasRecoveryBoot(
        `ghcr.io/sealant-sh/sealantd:0.20.0-next.7@sha256:${"b".repeat(64)}`,
        [],
      ),
    ).toBe(true);
    expect(sealantdHasRecoveryBoot("ghcr.io/sealant-sh/sealantd:0.19.1-next.2", [])).toBe(true);
    // A prerelease of the first release with the recovery boot comes before it.
    expect(sealantdHasRecoveryBoot("ghcr.io/sealant-sh/sealantd:0.19.0-next.40", [])).toBe(false);
    expect(sealantdHasRecoveryBoot("ghcr.io/sealant-sh/sealantd:0.18.3-next.1", [])).toBe(false);
  });

  it("does not know any other build unless the operator declares it (fail closed)", () => {
    expect(sealantdHasRecoveryBoot(undefined, [])).toBeNull();
    expect(sealantdHasRecoveryBoot("sealantd-dev:mount", [])).toBeNull();
    expect(sealantdHasRecoveryBoot("ghcr.io/sealant-sh/sealantd:latest", [])).toBeNull();
    expect(sealantdHasRecoveryBoot("sealantd-dev:mount", ["sealantd-dev:mount"])).toBe(true);
  });

  it("reads the declared images from SEALANT_SEALANTD_RECOVERY_BOOT_IMAGES", () => {
    expect(
      declaredRecoveryBootImages({ SEALANT_SEALANTD_RECOVERY_BOOT_IMAGES: " a:1 , b:2,," }),
    ).toEqual(["a:1", "b:2"]);
    expect(declaredRecoveryBootImages({})).toEqual([]);
  });

  it("finds the daemon image a planned Containerfile copies from", () => {
    expect(
      sealantdImageOfContainerfile(
        "FROM fedora:41\nCOPY --chmod=755 --from=ghcr.io/sealant-sh/sealantd:0.18.2 /usr/local/bin/sealantd /usr/local/bin/sealantd\n",
      ),
    ).toBe("ghcr.io/sealant-sh/sealantd:0.18.2");
    expect(sealantdImageOfContainerfile("FROM fedora:41\n")).toBeUndefined();
  });
});
