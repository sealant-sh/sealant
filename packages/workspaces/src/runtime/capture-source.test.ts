import { describe, expect, it } from "vitest";

import { captureSourceEnv } from "./capture-source.js";
import { parseRuntimeAdapterLaunchInput } from "./runtime-adapter.js";

const captureSource = (input: { readonly worktreeId?: string; readonly harnessHome?: string }) => {
  const launch = parseRuntimeAdapterLaunchInput({
    blueprint: {
      sources: {
        workspace: {
          kind: "capture",
          endpoint: "https://mend.example.com/session/s1",
          ...input,
        },
      },
      harness: { id: "claude-code" },
    },
    publishedImage: {
      repository: "sealant/workspaces/demo",
      tag: "capture",
      reference: "registry.example.com/demo:capture",
      digestReference: "registry.example.com/demo@sha256:test",
      digest: "sha256:test",
    },
  });
  const source = launch.blueprint.sources.workspace;
  if (source.kind !== "capture") {
    throw new Error("expected capture source");
  }
  return source;
};

describe("captureSourceEnv", () => {
  it("encodes the cold capture channel, worktree and harness root", () => {
    expect(
      captureSourceEnv(
        captureSource({ worktreeId: "wt_1", harnessHome: "/workspace/harness-home" }),
      ),
    ).toEqual([
      ["SEALANT_WORKSPACE_SOURCE", "capture"],
      ["SEALANT_CAPTURE_ENDPOINT", "https://mend.example.com/session/s1"],
      ["SEALANT_CAPTURE_WORKTREE_ID", "wt_1"],
      ["SEALANT_CAPTURE_HARNESS_HOME", "/workspace/harness-home"],
    ]);
  });

  it("keeps the harness root for standby capture and omits only the worktree", () => {
    expect(captureSourceEnv(captureSource({ harnessHome: "/workspace/harness-home" }))).toEqual([
      ["SEALANT_WORKSPACE_SOURCE", "capture"],
      ["SEALANT_CAPTURE_ENDPOINT", "https://mend.example.com/session/s1"],
      ["SEALANT_CAPTURE_HARNESS_HOME", "/workspace/harness-home"],
    ]);
  });

  it("preserves the legacy environment when harnessHome is absent", () => {
    expect(captureSourceEnv(captureSource({ worktreeId: "wt_1" }))).toEqual([
      ["SEALANT_WORKSPACE_SOURCE", "capture"],
      ["SEALANT_CAPTURE_ENDPOINT", "https://mend.example.com/session/s1"],
      ["SEALANT_CAPTURE_WORKTREE_ID", "wt_1"],
    ]);
  });
});
