import { describe, expect, it } from "vitest";

import type { RuntimeMountIntent } from "../mount-intent.js";
import type { VolumeMapping } from "./config.js";
import { lowerMountIntents, MountLoweringError, resolveVolumeMapping } from "./volumes.js";

const mappings: readonly VolumeMapping[] = [
  { logicalRoot: "/var/lib/mend/store", claimName: "mend-store", readOnly: false },
  { logicalRoot: "/var/lib/sealant/staging", claimName: "sealant-staging", readOnly: false },
  { logicalRoot: "/srv/readonly", claimName: "ro-claim", readOnly: true },
];

const intent = (
  sourcePath: string,
  mountPath: string,
  readOnly = false,
  purpose: RuntimeMountIntent["purpose"] = "extra-mount",
): RuntimeMountIntent => ({ sourcePath, mountPath, readOnly, purpose });

describe("resolveVolumeMapping", () => {
  it("maps a proper descendant to its claim and subPath", () => {
    expect(resolveVolumeMapping("/var/lib/mend/store/acme/worktrees/s1", mappings)).toEqual({
      mapping: mappings[0],
      subPath: "acme/worktrees/s1",
    });
  });

  it("refuses a path equal to a root (never the whole store)", () => {
    expect(() => resolveVolumeMapping("/var/lib/mend/store", mappings)).toThrow(
      /proper descendant/,
    );
  });

  it("refuses paths outside every root", () => {
    expect(() => resolveVolumeMapping("/etc/passwd", mappings)).toThrow(MountLoweringError);
    expect(() => resolveVolumeMapping("/var/lib/mend/storeX/y", mappings)).toThrow(
      /not under any configured logical root/,
    );
  });

  it("refuses traversal, relative and unnormalized paths", () => {
    for (const bad of [
      "/var/lib/mend/store/../secrets",
      "/var/lib/mend/store/./x",
      "var/lib/mend/store/x",
      "/var/lib/mend/store//x",
      "/var/lib/mend/store/x/",
      "",
    ]) {
      expect(() => resolveVolumeMapping(bad, mappings), bad).toThrow(MountLoweringError);
    }
  });
});

describe("lowerMountIntents", () => {
  it("emits one volume per claim and one mount per intent, preserving mountPath and readOnly", () => {
    const lowered = lowerMountIntents(
      [
        intent("/var/lib/mend/store/acme/worktrees/s1", "/workspace/repo", false, "workspace"),
        intent(
          "/var/lib/mend/store/acme/repo.git",
          "/var/lib/mend/store/acme/repo.git",
          false,
          "git-common",
        ),
        intent("/var/lib/mend/store/_references/lib", "/workspace/ref/lib", true),
        intent(
          "/var/lib/sealant/staging/sealant-dotfiles-run1",
          "/run/sealant/dotfiles",
          true,
          "launch-material",
        ),
      ],
      mappings,
    );
    expect(lowered).toEqual({
      volumes: [
        { name: "store-0", persistentVolumeClaim: { claimName: "mend-store" } },
        { name: "store-1", persistentVolumeClaim: { claimName: "sealant-staging" } },
      ],
      volumeMounts: [
        {
          name: "store-0",
          mountPath: "/workspace/repo",
          subPath: "acme/worktrees/s1",
          readOnly: false,
        },
        {
          name: "store-0",
          mountPath: "/var/lib/mend/store/acme/repo.git",
          subPath: "acme/repo.git",
          readOnly: false,
        },
        {
          name: "store-0",
          mountPath: "/workspace/ref/lib",
          subPath: "_references/lib",
          readOnly: true,
        },
        {
          name: "store-1",
          mountPath: "/run/sealant/dotfiles",
          subPath: "sealant-dotfiles-run1",
          readOnly: true,
        },
      ],
    });
  });

  it("forces read-only when the mapping is read-only", () => {
    const lowered = lowerMountIntents([intent("/srv/readonly/x", "/mnt/x", false)], mappings);
    expect(lowered.volumes[0]?.persistentVolumeClaim.readOnly).toBe(true);
    expect(lowered.volumeMounts[0]?.readOnly).toBe(true);
  });

  it("refuses duplicate mount paths and unnormalized mount paths", () => {
    expect(() =>
      lowerMountIntents(
        [intent("/var/lib/mend/store/a", "/m"), intent("/var/lib/mend/store/b", "/m")],
        mappings,
      ),
    ).toThrow(/requested twice/);
    expect(() => lowerMountIntents([intent("/var/lib/mend/store/a", "/m/../x")], mappings)).toThrow(
      MountLoweringError,
    );
  });

  it("carries the unsupported-runtime-requirement code for adapter errors", () => {
    try {
      lowerMountIntents([intent("/nowhere/a", "/m")], mappings);
    } catch (error) {
      expect(error).toBeInstanceOf(MountLoweringError);
      expect((error as MountLoweringError).code).toBe("unsupported-runtime-requirement");
      return;
    }
    throw new Error("expected a MountLoweringError");
  });
});
