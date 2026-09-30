import { describe, expect, it } from "@effect/vitest";
import {
  WorkspaceRuntimeInstanceRepo,
  type WorkspaceRuntimeInstance,
  type WorkspaceRuntimeInstanceRepoService,
} from "@sealant/db";
import { Effect, Layer } from "effect";

import type { ControlChannel } from "../runtime/kubernetes/adapter.js";
import { instancesHoldingAccount, pushCredentialCopy } from "./credential-push.js";

const instance = (
  runId: string,
  injections: WorkspaceRuntimeInstance["launchCredentialInjections"],
): WorkspaceRuntimeInstance =>
  ({
    runId,
    status: "ready",
    adapter: "docker",
    resourceId: `container-${runId}`,
    reference: `container-${runId}`,
    endpoint: `unix:///run/sealant/${runId}.sock`,
    launchCredentialInjections: injections,
  }) as WorkspaceRuntimeInstance;

const running = [
  instance("a", [
    { provider: "claude", connectedAccountId: "cacc_1", injection: "file", copy: true },
  ]),
  instance("b", [
    { provider: "claude", connectedAccountId: "cacc_1", injection: "file", copy: true },
  ]),
  instance("c", [
    { provider: "claude", connectedAccountId: "cacc_2", injection: "file", copy: true },
  ]),
  instance("d", [{ provider: "claude", connectedAccountId: "cacc_1", injection: "env" }]),
  instance("e", null),
];

const repo = Layer.succeed(WorkspaceRuntimeInstanceRepo, {
  listRunningInstances: () => Effect.succeed(running),
} as unknown as WorkspaceRuntimeInstanceRepoService);

describe("instancesHoldingAccount", () => {
  it("picks the running workspaces that were FILE-injected with the account", () => {
    expect(instancesHoldingAccount(running, "cacc_1").map((row) => row.runId)).toEqual(["a", "b"]);
    expect(instancesHoldingAccount(running, "cacc_3")).toEqual([]);
  });
});

describe("pushCredentialCopy", () => {
  it.effect("writes the copy into every holding workspace at once, and counts a failure", () => {
    const written: Array<{ readonly endpoint: string; readonly content: string }> = [];
    const channel: ControlChannel = {
      health: async () => {},
      writeCredentialFiles: async (target, files) => {
        const endpoint = JSON.stringify(target);
        if (endpoint.includes("/b.sock")) throw new Error("the workspace did not answer");
        for (const file of files) {
          written.push({ endpoint, content: Buffer.from(file.contentBase64, "base64").toString() });
        }
      },
    };
    return Effect.gen(function* () {
      const summary = yield* pushCredentialCopy({
        connectedAccountId: "cacc_1",
        provider: "claude",
        copyJson: JSON.stringify({ claudeAiOauth: { accessToken: "at-new" } }),
        controlChannel: channel,
      });
      expect(summary).toEqual({ written: 1, failed: 1, unreachable: 0 });
      expect(written).toHaveLength(1);
      expect(written[0]?.endpoint).toContain("/a.sock");
      expect(written[0]?.content).toContain("at-new");
    }).pipe(Effect.provide(repo));
  });
});
