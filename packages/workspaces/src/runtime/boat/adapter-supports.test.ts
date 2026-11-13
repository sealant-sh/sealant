/**
 * The Boat adapter's own refusals are the runtime table's: the create refuses the same items
 * first, and a blueprint recorded before it did is refused here with the same sentence.
 */
import { parseWorkspaceBlueprint, runtimeSupport } from "@sealant/validators";
import { describe, expect, it } from "vitest";

import { BOAT_GATEWAY_UNAVAILABLE_MESSAGE, boatAdapterSupports } from "./adapter.js";

const boat = runtimeSupport("boat", {
  kubernetesDocker: false,
  microvmDocker: false,
  microvmAgentPort: 8080,
  containerArchitecture: "x86_64",
  resourceHost: "docker",
});
const capture = {
  kind: "capture",
  endpoint: "https://mend.example.com/session/s1",
  worktreeId: "wt_1",
  harnessHome: "/workspace/harness-home",
};
const blueprint = (spec: Record<string, unknown>) =>
  parseWorkspaceBlueprint({
    harness: { id: "claude-code" },
    target: { runtime: { family: "boat", mode: "require" } },
    sources: { workspace: capture },
    ...spec,
  });
const message = (item: (typeof boat)["gitSource"]) => (item.supported ? "" : item.message);

describe("boatAdapterSupports", () => {
  it("serves a capture workspace", () => {
    expect(boatAdapterSupports({ blueprint: blueprint({}) }, true)).toEqual({ supported: true });
  });

  it("refuses a git source and dotfiles archives with the table's sentences", () => {
    expect(
      boatAdapterSupports(
        {
          blueprint: blueprint({
            sources: { workspace: { kind: "git", url: "https://github.com/acme/app.git" } },
          }),
        },
        true,
      ),
    ).toMatchObject({
      supported: false,
      reason: "runtime-requirement-unsupported",
      message: message(boat.gitSource),
    });
    expect(
      boatAdapterSupports(
        { blueprint: blueprint({ runtime: { dotfilesArchives: [{ data: "aGVsbG8=" }] } }) },
        true,
      ),
    ).toMatchObject({
      supported: false,
      reason: "runtime-requirement-unsupported",
      message: message(boat.dotfilesArchives),
    });
  });

  it("keeps the gateway check, which only the worker can make", () => {
    expect(boatAdapterSupports({ blueprint: blueprint({}) }, false)).toEqual({
      supported: false,
      reason: "gateway-unavailable",
      message: BOAT_GATEWAY_UNAVAILABLE_MESSAGE,
    });
  });
});
