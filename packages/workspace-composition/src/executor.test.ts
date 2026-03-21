import { describe, expect, it } from "vitest";

import {
  parseOsExecutorCompileInput,
  parseOsExecutorCompileResult,
  parseOsExecutorSupport,
} from "./executor.js";

describe("parseOsExecutorSupport", () => {
  it("accepts supported executor responses", () => {
    expect(parseOsExecutorSupport({ supported: true })).toEqual({ supported: true });
  });

  it("accepts unsupported executor responses with a reason", () => {
    expect(
      parseOsExecutorSupport({
        supported: false,
        reason: "unsupported-harness",
        message: "Harness is not available on this OS backend.",
      }),
    ).toEqual({
      supported: false,
      reason: "unsupported-harness",
      message: "Harness is not available on this OS backend.",
    });
  });
});

describe("parseOsExecutorCompileInput", () => {
  it("accepts a normalized workspace blueprint as compile input", () => {
    const input = parseOsExecutorCompileInput({
      blueprint: {
        version: "1",
        sources: {
          workspace: {
            url: "https://github.com/example/project.git",
          },
        },
        harness: {
          id: "opencode",
        },
      },
    });

    expect(input.blueprint.target).toEqual({
      os: {
        family: "auto",
        mode: "prefer",
      },
      runtime: {
        family: "auto",
        mode: "prefer",
      },
    });
  });
});

describe("parseOsExecutorCompileResult", () => {
  it("accepts standardized executor compile results", () => {
    const result = parseOsExecutorCompileResult({
      executor: {
        id: "nix",
        osFamily: "nix",
      },
      artifacts: [
        {
          kind: "oci-image",
          name: "workspace-image",
          reference: "sealant/workspace:nix",
          loader: "docker-load",
        },
        {
          kind: "metadata",
          name: "workspace-spec",
          path: "/tmp/spec.json",
          format: "json",
        },
      ],
      metadata: {
        defaultArtifactName: "workspace-image",
        notes: ["Compiled by the Nix executor."],
      },
    });

    expect(result).toEqual({
      executor: {
        id: "nix",
        osFamily: "nix",
      },
      artifacts: [
        {
          kind: "oci-image",
          name: "workspace-image",
          reference: "sealant/workspace:nix",
          loader: "docker-load",
        },
        {
          kind: "metadata",
          name: "workspace-spec",
          path: "/tmp/spec.json",
          format: "json",
        },
      ],
      metadata: {
        defaultArtifactName: "workspace-image",
        notes: ["Compiled by the Nix executor."],
      },
    });
  });

  it("rejects auto as a concrete executor OS family", () => {
    expect(() =>
      parseOsExecutorCompileResult({
        executor: {
          id: "nix",
          osFamily: "auto",
        },
        artifacts: [
          {
            kind: "oci-image",
            name: "workspace-image",
          },
        ],
      }),
    ).toThrowError();
  });
});
