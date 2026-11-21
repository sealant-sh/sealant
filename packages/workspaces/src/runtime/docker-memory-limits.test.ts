import { describe, expect, it } from "vitest";

import {
  autoDockerMemoryLimits,
  dockerMemoryArgs,
  formatMemoryBytes,
  parseDockerHostMemory,
  parseDockerMemoryPolicy,
  parseDockerMemorySetting,
  resolveDockerMemoryLimits,
} from "./docker-memory-limits.js";

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

describe("parseDockerMemorySetting", () => {
  it("reads auto, none and sizes in binary units", () => {
    expect(parseDockerMemorySetting("X", undefined)).toEqual({ kind: "auto" });
    expect(parseDockerMemorySetting("X", " Auto ")).toEqual({ kind: "auto" });
    expect(parseDockerMemorySetting("X", "none")).toEqual({ kind: "none" });
    for (const raw of ["4g", "4G", "4GiB", "4gb", "4096m", "4096Mi", String(4 * GiB)]) {
      expect(parseDockerMemorySetting("X", raw)).toEqual({ kind: "bytes", bytes: 4 * GiB });
    }
    expect(parseDockerMemorySetting("X", "1.5g")).toEqual({ kind: "bytes", bytes: 1.5 * GiB });
    expect(parseDockerMemorySetting("X", "64m")).toEqual({ kind: "bytes", bytes: 64 * MiB });
  });

  it("refuses a size it cannot read, or one too small to run anything, naming the variable", () => {
    for (const raw of ["0", "63m", "4 gigs", "-1g", "4x", "lots"]) {
      expect(() => parseDockerMemorySetting("SEALANT_DOCKER_WORKSPACE_MEMORY_LIMIT", raw)).toThrow(
        /SEALANT_DOCKER_WORKSPACE_MEMORY_LIMIT must be auto, none, or a size/,
      );
    }
  });

  it("reads both variables, unset as auto", () => {
    expect(parseDockerMemoryPolicy({ SEALANT_DOCKER_SERVICE_MEMORY_LIMIT: "2g" })).toEqual({
      workspace: { kind: "auto" },
      service: { kind: "bytes", bytes: 2 * GiB },
    });
  });
});

describe("autoDockerMemoryLimits", () => {
  it("gives half the host to the workspace and a quarter to its Docker service, within bounds", () => {
    expect(autoDockerMemoryLimits(8 * GiB)).toEqual({ workspace: 4 * GiB, service: 2 * GiB });
    expect(autoDockerMemoryLimits(16 * GiB)).toEqual({ workspace: 8 * GiB, service: 4 * GiB });
    // Ceilings.
    expect(autoDockerMemoryLimits(128 * GiB)).toEqual({ workspace: 16 * GiB, service: 8 * GiB });
    // Floors.
    expect(autoDockerMemoryLimits(4 * GiB)).toEqual({ workspace: 2 * GiB, service: 1 * GiB });
    // A floor never takes more than three quarters (workspace) or half (service) of the host.
    expect(autoDockerMemoryLimits(2 * GiB)).toEqual({ workspace: 1.5 * GiB, service: 1 * GiB });
    expect(autoDockerMemoryLimits(1 * GiB)).toEqual({ workspace: 0.75 * GiB, service: 0.5 * GiB });
  });

  it("is whole bytes for a host whose memory is not a round figure", () => {
    const { workspace, service } = autoDockerMemoryLimits(8_331_264_001);
    expect(Number.isInteger(workspace)).toBe(true);
    expect(Number.isInteger(service)).toBe(true);
  });
});

describe("resolveDockerMemoryLimits", () => {
  it("resolves auto from the host, keeps a size, and drops none", () => {
    expect(
      resolveDockerMemoryLimits(
        { workspace: { kind: "auto" }, service: { kind: "none" } },
        8 * GiB,
      ),
    ).toEqual({ workspace: 4 * GiB, service: undefined });
    expect(
      resolveDockerMemoryLimits(
        { workspace: { kind: "bytes", bytes: 6 * GiB }, service: { kind: "auto" } },
        8 * GiB,
      ),
    ).toEqual({ workspace: 6 * GiB, service: 2 * GiB });
  });

  it("runs auto with no limit while the host's memory is unknown", () => {
    expect(
      resolveDockerMemoryLimits(
        { workspace: { kind: "auto" }, service: { kind: "bytes", bytes: GiB } },
        undefined,
      ),
    ).toEqual({ workspace: undefined, service: GiB });
  });
});

describe("docker flags", () => {
  it("holds swap at the limit and makes the container the host's first choice to stop", () => {
    expect(dockerMemoryArgs(4 * GiB)).toEqual([
      "--memory",
      String(4 * GiB),
      "--memory-swap",
      String(4 * GiB),
      "--oom-score-adj",
      "500",
    ]);
    expect(dockerMemoryArgs(undefined)).toEqual(["--oom-score-adj", "500"]);
  });

  it("reads docker info's MemTotal", () => {
    expect(parseDockerHostMemory("8331264000\n")).toBe(8_331_264_000);
    expect(parseDockerHostMemory("null")).toBeUndefined();
    expect(parseDockerHostMemory("0")).toBeUndefined();
  });

  it("prints a size as a person reads it", () => {
    expect(formatMemoryBytes(4 * GiB)).toBe("4 GiB");
    expect(formatMemoryBytes(1.5 * GiB)).toBe("1.5 GiB");
    expect(formatMemoryBytes(512 * MiB)).toBe("512 MiB");
  });
});
