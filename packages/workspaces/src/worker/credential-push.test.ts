import { describe, expect, it } from "@effect/vitest";
import {
  ConnectedAccountRepo,
  type ConnectedAccountRepoService,
  WorkspaceCredentialHomeRepo,
  WorkspaceRuntimeInstanceRepo,
  type WorkspaceRuntimeInstance,
  type WorkspaceRuntimeInstanceRepoService,
} from "@sealant/db";
import { makeInMemoryCredentialHomes } from "@sealant/db/testing/credential-homes";
import { Effect, Layer } from "effect";

import { HOME_SCRIPT_EXIT, type HomeCredentialChannel } from "../runtime/home-credentials.js";
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
  // Launched into a credentialsHome: reached through that home's record, never at $HOME.
  instance("f", [
    {
      provider: "claude",
      connectedAccountId: "cacc_1",
      injection: "file",
      copy: true,
      home: "/home/m4lice000",
    },
  ]),
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

interface RanScript {
  readonly target: string;
  readonly script: string;
  readonly stdin: string;
}

/** Records each home script; answers `exitCode` (a late write the home's marker fenced: 76). */
const recordingHomeChannel = (ran: RanScript[], exitCode = 0): HomeCredentialChannel => ({
  run: (target, script, stdin) =>
    Effect.sync(() => {
      ran.push({ target: JSON.stringify(target), script, stdin });
      return { exitCode };
    }),
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
    const ran: RanScript[] = [];
    return Effect.gen(function* () {
      const hold = (home: string, person: string, connectedAccountId: string) =>
        homes.service.withLockedHome({ runId: "h", home }, () =>
          Effect.succeed({
            result: undefined,
            outcome: {
              kind: "hold" as const,
              onBehalfOfUserId: person,
              accounts: [{ provider: "claude" as const, connectedAccountId }],
              generation: `generation-${person}`,
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
      expect(ran.map((entry) => entry.script.match(/home='([^']+)'/)?.[1]).toSorted()).toEqual([
        "/home/alice",
        "/run/mend/conv/ses_1",
      ]);
      for (const entry of ran) {
        expect(Buffer.from(entry.stdin.trim(), "base64").toString()).toContain("at-alice-2");
        expect(entry.script).toContain(".claude/.credentials.json");
        // Fenced by Alice's hold.
        expect(entry.script).toContain("generation-usr_alice");
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
    const ran: RanScript[] = [];
    return Effect.gen(function* () {
      yield* homes.service.withLockedHome({ runId: "h", home: "/run/mend/conv/ses_1" }, () =>
        Effect.succeed({
          result: undefined,
          outcome: {
            kind: "hold" as const,
            onBehalfOfUserId: "usr_alice",
            accounts: [{ provider: "claude" as const, connectedAccountId: "cacc_alice" }],
            generation: "generation-alice",
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
            generation: "generation-bob",
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

describe("pushCredentialCopy into a home whose marker moved on", () => {
  it.effect("counts a write the executor fenced as no longer held, never as written", () => {
    const ready = [instance("h", [])];
    const homes = makeInMemoryCredentialHomes(() => ready);
    const ran: RanScript[] = [];
    return Effect.gen(function* () {
      yield* homes.service.withLockedHome({ runId: "h", home: "/run/mend/conv/ses_1" }, () =>
        Effect.succeed({
          result: undefined,
          outcome: {
            kind: "hold" as const,
            onBehalfOfUserId: "usr_alice",
            accounts: [{ provider: "claude" as const, connectedAccountId: "cacc_alice" }],
            generation: "generation-alice",
          },
        }),
      );
      const summary = yield* pushCredentialCopy({
        connectedAccountId: "cacc_alice",
        provider: "claude",
        copyJson: "{}",
        controlChannel: silentLaunchChannel,
        homeChannel: recordingHomeChannel(ran, 76),
      });
      expect(summary).toEqual({ written: 0, failed: 0, unreachable: 0, released: 1 });
      expect(ran).toHaveLength(1);
    }).pipe(
      Effect.provide(
        Layer.merge(
          instancesRepo(ready),
          Layer.succeed(WorkspaceCredentialHomeRepo, homes.service),
        ),
      ),
    );
  });
});

describe("pushCredentialCopy re-reads the account under each home's lock", () => {
  it.effect(
    "writes the account as stored when the home's lock is taken, not the copy it was handed",
    () => {
      const ready = [instance("h", [])];
      const homes = makeInMemoryCredentialHomes(() => ready);
      const ran: RanScript[] = [];
      const stored = JSON.stringify({
        credentialsJson: JSON.stringify({
          claudeAiOauth: { accessToken: "at-newer", refreshToken: "rt", expiresAt: 2 },
        }),
      });
      const accounts = Layer.succeed(ConnectedAccountRepo, {
        getById: () =>
          Effect.succeed({
            id: "cacc_alice",
            archivedAt: null,
            encryptedPayload: `sealed:${stored}`,
          }),
      } as unknown as ConnectedAccountRepoService);
      return Effect.gen(function* () {
        yield* homes.service.withLockedHome({ runId: "h", home: "/home/alice" }, () =>
          Effect.succeed({
            result: undefined,
            outcome: {
              kind: "hold" as const,
              onBehalfOfUserId: "usr_alice",
              accounts: [{ provider: "claude" as const, connectedAccountId: "cacc_alice" }],
              generation: "generation-alice",
            },
          }),
        );
        yield* pushCredentialCopy({
          connectedAccountId: "cacc_alice",
          provider: "claude",
          copyJson: JSON.stringify({ claudeAiOauth: { accessToken: "at-older" } }),
          controlChannel: silentLaunchChannel,
          homeChannel: recordingHomeChannel(ran),
          credentialCipher: {
            encrypt: (plaintext) => Effect.succeed({ sealed: `sealed:${plaintext}`, keyId: "k" }),
            decrypt: (sealed) => Effect.succeed(sealed.slice("sealed:".length)),
          },
        });
        const written = Buffer.from(ran[0]?.stdin.trim() ?? "", "base64").toString();
        expect(written).toContain("at-newer");
        expect(written).not.toContain("rt");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            instancesRepo(ready),
            Layer.succeed(WorkspaceCredentialHomeRepo, homes.service),
            accounts,
          ),
        ),
      );
    },
  );
});

/** A token whose expiry is readable, as a ChatGPT access token's is. */
const jwt = (exp: number) => `h.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.s`;

describe("pushCredentialCopy into homes holding pi's and opencode's logins", () => {
  const ready = [instance("h", [])];

  it.effect(
    "leaves out a pi or opencode file the home refuses and writes the rest once more",
    () => {
      const homes = makeInMemoryCredentialHomes(() => ready);
      const ran: RanScript[] = [];
      // opencode's auth.json has a second hard link (a capture brought it back into saved state):
      // every script that writes it is refused, 85.
      const channel: HomeCredentialChannel = {
        run: (target, script, stdin) =>
          Effect.sync(() => {
            ran.push({ target: JSON.stringify(target), script, stdin });
            return {
              exitCode: script.includes('.local/share/opencode/auth.json" openai ')
                ? HOME_SCRIPT_EXIT.opencodeLoginOutside
                : 0,
            };
          }),
      };
      return Effect.gen(function* () {
        yield* homes.service.withLockedHome({ runId: "h", home: "/home/alice" }, () =>
          Effect.succeed({
            result: undefined,
            outcome: {
              kind: "hold" as const,
              onBehalfOfUserId: "usr_alice",
              accounts: [
                { provider: "codex" as const, connectedAccountId: "cacc_codex" },
                { provider: "pi" as const, connectedAccountId: "cacc_codex" },
                { provider: "opencode" as const, connectedAccountId: "cacc_codex" },
              ],
              generation: "generation-alice",
            },
          }),
        );
        const summary = yield* pushCredentialCopy({
          connectedAccountId: "cacc_codex",
          provider: "codex",
          copyJson: JSON.stringify({
            tokens: {
              access_token: jwt(1_900_000_000),
              refresh_token: "sealant-copy-cannot-refresh",
              account_id: "acc_1",
            },
          }),
          controlChannel: silentLaunchChannel,
          homeChannel: channel,
        });
        expect(summary).toMatchObject({ written: 1, failed: 0 });
        expect(ran).toHaveLength(2);
        // The second run writes the new Codex login and pi's entry, without opencode's.
        const second = ran[1];
        expect(second?.script).toContain(".codex/auth.json");
        expect(second?.script).toContain("openai-codex");
        expect(second?.script).not.toContain('.local/share/opencode/auth.json" openai ');
        const payloads = (second?.stdin ?? "").split("\n").filter((line) => line.length > 0);
        expect(payloads).toHaveLength(2);
        expect(Buffer.from(payloads[0] ?? "", "base64").toString("utf8")).toContain("tokens");
      }).pipe(
        Effect.provide(
          Layer.merge(
            instancesRepo(ready),
            Layer.succeed(WorkspaceCredentialHomeRepo, homes.service),
          ),
        ),
      );
    },
  );

  it.effect(
    "writes a Codex refresh into the home's codex, pi and opencode logins in one script",
    () => {
      const homes = makeInMemoryCredentialHomes(() => ready);
      const ran: RanScript[] = [];
      return Effect.gen(function* () {
        yield* homes.service.withLockedHome({ runId: "h", home: "/home/alice" }, () =>
          Effect.succeed({
            result: undefined,
            outcome: {
              kind: "hold" as const,
              onBehalfOfUserId: "usr_alice",
              accounts: [
                { provider: "codex" as const, connectedAccountId: "cacc_codex" },
                { provider: "pi" as const, connectedAccountId: "cacc_codex" },
                { provider: "opencode" as const, connectedAccountId: "cacc_codex" },
                { provider: "claude" as const, connectedAccountId: "cacc_claude" },
              ],
              generation: "generation-alice",
            },
          }),
        );
        const access = jwt(1_900_000_000);
        const summary = yield* pushCredentialCopy({
          connectedAccountId: "cacc_codex",
          provider: "codex",
          copyJson: JSON.stringify({
            tokens: {
              access_token: access,
              refresh_token: "sealant-copy-cannot-refresh",
              account_id: "acc_1",
            },
          }),
          controlChannel: silentLaunchChannel,
          homeChannel: recordingHomeChannel(ran),
        });
        expect(summary.written).toBe(1);
        expect(ran).toHaveLength(1);
        const payloads = (ran[0]?.stdin ?? "")
          .split("\n")
          .filter((line) => line.length > 0)
          .map((line) => Buffer.from(line, "base64").toString("utf8"));
        expect(payloads).toHaveLength(3);
        expect(JSON.parse(payloads[1] ?? "{}")).toEqual({
          type: "oauth",
          access,
          refresh: "sealant-copy-cannot-refresh",
          expires: 1_900_000_000_000,
          accountId: "acc_1",
        });
        expect(ran[0]?.script).toContain("openai-codex");
        expect(ran[0]?.script).toContain("openai");
        // Claude's login is another account's: not touched by a Codex refresh.
        expect(ran[0]?.script).not.toContain(".claude/.credentials.json");
      }).pipe(
        Effect.provide(
          Layer.merge(
            instancesRepo(ready),
            Layer.succeed(WorkspaceCredentialHomeRepo, homes.service),
          ),
        ),
      );
    },
  );
});
