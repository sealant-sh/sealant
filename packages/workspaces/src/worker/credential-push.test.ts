import { describe, expect, it } from "@effect/vitest";
import {
  WorkspaceCredentialHomeRepo,
  WorkspaceRuntimeInstanceRepo,
  type WorkspaceRuntimeInstance,
  type WorkspaceRuntimeInstanceRepoService,
} from "@sealant/db";
import { makeInMemoryCredentialHomes } from "@sealant/db/testing/credential-homes";
import { Effect, Layer } from "effect";

import type { HomeCredentialChannel, HomeCredentialScript } from "../runtime/home-credentials.js";
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

const instancesRepo = (instances: readonly WorkspaceRuntimeInstance[]) =>
  Layer.succeed(WorkspaceRuntimeInstanceRepo, {
    listRunningInstances: () => Effect.succeed(instances),
  } as unknown as WorkspaceRuntimeInstanceRepoService);

const noHomes = makeInMemoryCredentialHomes(() => running);
const repo = Layer.merge(
  instancesRepo(running),
  Layer.succeed(WorkspaceCredentialHomeRepo, noHomes.service),
);

const silentLaunchChannel: ControlChannel = {
  health: async () => {},
  writeCredentialFiles: async () => {},
};

/** Records each home script, decoding its stdin payloads. */
const recordingHomeChannel = (
  ran: Array<{ readonly target: string; readonly script: HomeCredentialScript }>,
): HomeCredentialChannel => ({
  run: async (target, script) => {
    ran.push({ target: JSON.stringify(target), script });
    return { exitCode: 0 };
  },
});

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
      expect(summary).toEqual({ written: 1, failed: 1, unreachable: 0, released: 0 });
      expect(written).toHaveLength(1);
      expect(written[0]?.endpoint).toContain("/a.sock");
      expect(written[0]?.content).toContain("at-new");
    }).pipe(Effect.provide(repo));
  });
});

describe("pushCredentialCopy into homes", () => {
  const ready = [instance("h", [])];

  it.effect("writes the copy into every home whose person holds the account, and no other", () => {
    const homes = makeInMemoryCredentialHomes(() => ready);
    const ran: Array<{ readonly target: string; readonly script: HomeCredentialScript }> = [];
    return Effect.gen(function* () {
      const hold = (home: string, person: string, connectedAccountId: string) =>
        homes.service.withLockedHome({ runId: "h", home }, () =>
          Effect.succeed({
            result: undefined,
            outcome: {
              kind: "hold" as const,
              onBehalfOfUserId: person,
              accounts: [{ provider: "claude" as const, connectedAccountId }],
            },
          }),
        );
      yield* hold("/home/alice", "usr_alice", "cacc_alice");
      yield* hold("/run/mend/conv/ses_1", "usr_alice", "cacc_alice");
      yield* hold("/home/bob", "usr_bob", "cacc_bob");

      const summary = yield* pushCredentialCopy({
        connectedAccountId: "cacc_alice",
        provider: "claude",
        copyJson: JSON.stringify({ claudeAiOauth: { accessToken: "at-alice-2" } }),
        controlChannel: silentLaunchChannel,
        homeChannel: recordingHomeChannel(ran),
      });

      expect(summary).toEqual({ written: 2, failed: 0, unreachable: 0, released: 0 });
      expect(
        ran.map((entry) => entry.script.script.match(/home='([^']+)'/)?.[1]).toSorted(),
      ).toEqual(["/home/alice", "/run/mend/conv/ses_1"]);
      for (const entry of ran) {
        expect(Buffer.from(entry.script.stdin.trim(), "base64").toString()).toContain("at-alice-2");
        expect(entry.script.script).toContain(".claude/.credentials.json");
      }
    }).pipe(
      Effect.provide(
        Layer.merge(
          instancesRepo(ready),
          Layer.succeed(WorkspaceCredentialHomeRepo, homes.service),
        ),
      ),
    );
  });

  it.effect("leaves a home released or retaken by another person since the listing", () => {
    const homes = makeInMemoryCredentialHomes(() => ready);
    const ran: Array<{ readonly target: string; readonly script: HomeCredentialScript }> = [];
    return Effect.gen(function* () {
      yield* homes.service.withLockedHome({ runId: "h", home: "/run/mend/conv/ses_1" }, () =>
        Effect.succeed({
          result: undefined,
          outcome: {
            kind: "hold" as const,
            onBehalfOfUserId: "usr_alice",
            accounts: [{ provider: "claude" as const, connectedAccountId: "cacc_alice" }],
          },
        }),
      );
      // The listing still names Alice's home; under its lock, Bob holds it now.
      const listed = yield* homes.service.listReadyHoldingAccount("cacc_alice");
      const stale = {
        ...homes.service,
        listReadyHoldingAccount: () => Effect.succeed(listed),
      };
      yield* homes.service.withLockedHome({ runId: "h", home: "/run/mend/conv/ses_1" }, () =>
        Effect.succeed({ result: undefined, outcome: { kind: "release" as const } }),
      );
      yield* homes.service.withLockedHome({ runId: "h", home: "/run/mend/conv/ses_1" }, () =>
        Effect.succeed({
          result: undefined,
          outcome: {
            kind: "hold" as const,
            onBehalfOfUserId: "usr_bob",
            accounts: [{ provider: "claude" as const, connectedAccountId: "cacc_bob" }],
          },
        }),
      );

      const summary = yield* pushCredentialCopy({
        connectedAccountId: "cacc_alice",
        provider: "claude",
        copyJson: JSON.stringify({ claudeAiOauth: { accessToken: "at-alice-2" } }),
        controlChannel: silentLaunchChannel,
        homeChannel: recordingHomeChannel(ran),
      }).pipe(Effect.provideService(WorkspaceCredentialHomeRepo, stale));

      expect(summary).toEqual({ written: 0, failed: 0, unreachable: 0, released: 1 });
      expect(ran).toEqual([]);
    }).pipe(Effect.provide(instancesRepo(ready)));
  });
});
