import { describe, expect, it } from "vitest";

import { parsePublishedReference, planImageCoordinates } from "./plan-coordinates.js";

describe("planImageCoordinates", () => {
  it("keys the repository on the OS family and the tag on the plan hash", () => {
    expect(planImageCoordinates({ osFamily: "arch", planHash: "a".repeat(64) })).toEqual({
      repository: "sealant-workspace-arch",
      tag: "plan-aaaaaaaaaaaa",
    });
  });

  it("gives two workspaces with one plan the same coordinates", () => {
    const hash = "0123456789abcdef".repeat(4);
    expect(planImageCoordinates({ osFamily: "fedora", planHash: hash })).toEqual(
      planImageCoordinates({ osFamily: "fedora", planHash: hash }),
    );
  });

  it("keeps the repository a valid OCI path component", () => {
    expect(planImageCoordinates({ osFamily: "Custom Base!", planHash: "f".repeat(64) })).toEqual({
      repository: "sealant-workspace-custom-base",
      tag: "plan-ffffffffffff",
    });
    expect(planImageCoordinates({ osFamily: "---", planHash: "1".repeat(64) }).repository).toBe(
      "sealant-workspace-custom",
    );
  });
});

describe("parsePublishedReference", () => {
  it("reads the repository and tag behind the registry host, port included", () => {
    expect(parsePublishedReference("127.0.0.1:5000/session-aaaa:sdk-11111111")).toEqual({
      repository: "session-aaaa",
      tag: "sdk-11111111",
    });
    expect(parsePublishedReference("ghcr.io/sealant-sh/workspaces/demo:plan-abcdef012345")).toEqual(
      {
        repository: "sealant-sh/workspaces/demo",
        tag: "plan-abcdef012345",
      },
    );
  });

  it("refuses digest references and references with no tag", () => {
    expect(parsePublishedReference("127.0.0.1:5000/repo@sha256:abc")).toBeNull();
    expect(parsePublishedReference("127.0.0.1:5000/repo")).toBeNull();
    expect(parsePublishedReference("127.0.0.1:5000/repo:")).toBeNull();
    expect(parsePublishedReference("repo:tag")).toBeNull();
  });
});
