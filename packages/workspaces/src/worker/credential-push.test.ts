import { describe, expect, it } from "@effect/vitest";
import { RESOURCE_DOMAIN_ID_PREFIX } from "@sealant/api-contracts";
import {
  ConnectedAccountRepo,
  CredentialPlacementRepo,
  type ConnectedAccount,
  type ConnectedAccountRepoService,
  WorkspaceCredentialHomeRepo,
  WorkspaceRuntimeInstanceRepo,
  type WorkspaceCredentialPlacement,
  type WorkspaceRuntimeInstance,
  type WorkspaceRuntimeInstanceRepoService,
} from "@sealant/db";
import {
  makeInMemoryCredentialHomes,
  type InMemoryCredentialHomes,
} from "@sealant/db/testing/credential-homes";
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
      placed: { login: { kind: "subscription" }, revision: 1 },
    },
  ]),
];

const instancesRepo = (instances: readonly WorkspaceRuntimeInstance[]) =>
  Layer.succeed(WorkspaceRuntimeInstanceRepo, {
    listRunningInstances: () => Effect.succeed(instances),
  } as unknown as WorkspaceRuntimeInstanceRepoService);

const noHomes = makeInMemoryCredentialHomes(() => running);
const repo = Layer.mergeAll(
  instancesRepo(running),
  Layer.succeed(WorkspaceCredentialHomeRepo, noHomes.service),
  Layer.succeed(CredentialPlacementRepo, noHomes.placements),
  Layer.succeed(ConnectedAccountRepo, {} as ConnectedAccountRepoService),
);

const account = (
  id: string,
  ownerUserId: string,
  provider: ConnectedAccount["provider"],
  payload: string = JSON.stringify({ credentialsJson: "{}" }),
  revision = 1,
): ConnectedAccount => ({
  id,
  ownerUserId,
  provider,
  name: id,
  kind: provider === "claude" ? "credentials-json" : "auth-json",
  status: "active",
  encryptedPayload: `sealed:${payload}`,
  encryptionKeyId: "k",
  payloadSha256: "sha",
  credentialRevision: revision,
  metadata: {},
  createdAt: new Date(0),
  updatedAt: new Date(0),
  lastUsedAt: null,
  lastSyncedAt: null,
  invalidAt: null,
  archivedAt: null,
  refreshClaimedUntil: null,
  apiKeyConnectedAt: null,
  kindUnchecked: false,
});

const homesOf = (
  instances: readonly WorkspaceRuntimeInstance[],
  accounts: readonly ConnectedAccount[],
) => {
  const homes = makeInMemoryCredentialHomes(() => instances, { accounts: () => accounts });
  const layer = Layer.mergeAll(
    instancesRepo(instances),
    Layer.succeed(WorkspaceCredentialHomeRepo, homes.service),
    Layer.succeed(CredentialPlacementRepo, homes.placements),
    Layer.succeed(ConnectedAccountRepo, {
      getById: (id: string) => Effect.succeed(accounts.find((row) => row.id === id)),
    } as unknown as ConnectedAccountRepoService),
  );
  return { homes, layer };
};

const hold = (
  homes: InMemoryCredentialHomes,
  home: string,
  person: string,
  generation: string,
  logins: ReadonlyArray<readonly [WorkspaceCredentialPlacement["provider"], string]>,
) =>
  homes.service
    .withLockedHome({ runId: "h", home }, () =>
      Effect.succeed({
        result: undefined,
        outcome: { kind: "hold" as const, onBehalfOfUserId: person, generation },
      }),
    )
    .pipe(
      Effect.andThen(
        Effect.sync(() =>
          logins.map(([provider, accountId]) =>
            homes.place({ runId: "h", home, provider, accountId }),
          ),
        ),
      ),
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

  it("leaves out a launch that placed the account as an API key", () => {
    const launches = [
      instance("subscription", [
        {
          provider: "codex",
          connectedAccountId: "cacc_1",
          injection: "file",
          copy: true,
          login: "subscription",
        },
      ]),
      instance("key", [
        {
          provider: "codex",
          connectedAccountId: "cacc_1",
          injection: "file",
          copy: true,
          login: "api-key",
        },
      ]),
    ];
    expect(instancesHoldingAccount(launches, "cacc_1").map((row) => row.runId)).toEqual([
      "subscription",
    ]);
  });
});

const recording = (written: string[]): ControlChannel => ({
  health: async () => {},
  writeCredentialFiles: async (_target, files) => {
    for (const file of files) written.push(Buffer.from(file.contentBase64, "base64").toString());
  },
});

describe("pushCredentialCopy re-reads the account before writing at $HOME", () => {
  const sealedCipher = {
    encrypt: (plaintext: string) => Effect.succeed({ sealed: `sealed:${plaintext}`, keyId: "k" }),
    decrypt: (sealed: string) => Effect.succeed(sealed.slice("sealed:".length)),
  };
  const holding = [
    instance("a", [
      { provider: "codex", connectedAccountId: "cacc_1", injection: "file", copy: true },
    ]),
  ];
  const emptyHomes = makeInMemoryCredentialHomes(() => []);
  const storing = (payload: unknown) =>
    Layer.mergeAll(
      instancesRepo(holding),
      Layer.succeed(WorkspaceCredentialHomeRepo, emptyHomes.service),
      Layer.succeed(CredentialPlacementRepo, emptyHomes.placements),
      Layer.succeed(ConnectedAccountRepo, {
        getById: () =>
          Effect.succeed({
            id: "cacc_1",
            archivedAt: null,
            encryptedPayload: `sealed:${JSON.stringify(payload)}`,
          }),
      } as unknown as ConnectedAccountRepoService),
    );
  it.effect("writes nothing once the account holds a key", () => {
    const written: string[] = [];
    return Effect.gen(function* () {
      const summary = yield* pushCredentialCopy({
        connectedAccountId: "cacc_1",
        provider: "codex",
        copyJson: JSON.stringify({ tokens: { access_token: "at-stale" } }),
        controlChannel: recording(written),
        credentialCipher: sealedCipher,
      });
      expect(written).toEqual([]);
      expect(summary).toEqual({ written: 0, failed: 0, unreachable: 0, released: 1 });
    }).pipe(Effect.provide(storing({ apiKey: "sk-proj-FAKEcodexkeyforthetests0000wxyz" })));
  });

  it.effect("writes the account as stored now, not the copy it was handed", () => {
    const written: string[] = [];
    const authJson = JSON.stringify({ tokens: { access_token: "at-newer", refresh_token: "rt" } });
    return Effect.gen(function* () {
      yield* pushCredentialCopy({
        connectedAccountId: "cacc_1",
        provider: "codex",
        copyJson: JSON.stringify({ tokens: { access_token: "at-stale" } }),
        controlChannel: recording(written),
        credentialCipher: sealedCipher,
      });
      expect(written).toHaveLength(1);
      expect(written[0]).toContain("at-newer");
      expect(written[0]).not.toContain('"rt"');
    }).pipe(Effect.provide(storing({ authJson })));
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
  const accounts = [
    account("cacc_alice", "usr_alice", "claude"),
    account("cacc_bob", "usr_bob", "claude"),
  ];

  it.effect("writes the copy into every home whose person holds the account, and no other", () => {
    const { homes, layer } = homesOf(ready, accounts);
    const ran: RanScript[] = [];
    return Effect.gen(function* () {
      yield* hold(homes, "/home/alice", "usr_alice", "generation-usr_alice", [
        ["claude", "cacc_alice"],
      ]);
      yield* hold(homes, "/run/mend/conv/ses_1", "usr_alice", "generation-usr_alice", [
        ["claude", "cacc_alice"],
      ]);
      yield* hold(homes, "/home/bob", "usr_bob", "generation-usr_bob", [["claude", "cacc_bob"]]);

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
    }).pipe(Effect.provide(layer));
  });

  it.effect("leaves a home released or retaken by another person since the listing", () => {
    const { homes, layer } = homesOf(ready, accounts);
    const ran: RanScript[] = [];
    return Effect.gen(function* () {
      yield* hold(homes, "/run/mend/conv/ses_1", "usr_alice", "generation-alice", [
        ["claude", "cacc_alice"],
      ]);
      // The listing still names Alice's home; under its lock, Bob holds it now.
      const listed = yield* homes.placements.homesHoldingSubscription("cacc_alice");
      yield* homes.service.withLockedHome({ runId: "h", home: "/run/mend/conv/ses_1" }, () =>
        Effect.succeed({ result: undefined, outcome: { kind: "release" as const } }),
      );
      yield* hold(homes, "/run/mend/conv/ses_1", "usr_bob", "generation-bob", [
        ["claude", "cacc_bob"],
      ]);

      const summary = yield* pushCredentialCopy({
        connectedAccountId: "cacc_alice",
        provider: "claude",
        copyJson: JSON.stringify({ claudeAiOauth: { accessToken: "at-alice-2" } }),
        controlChannel: silentLaunchChannel,
        homeChannel: recordingHomeChannel(ran),
      }).pipe(
        Effect.provideService(CredentialPlacementRepo, {
          ...homes.placements,
          homesHoldingSubscription: () => Effect.succeed(listed),
        }),
      );

      expect(summary).toEqual({ written: 0, failed: 0, unreachable: 0, released: 1 });
      expect(ran).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "leaves a home recorded for a resource domain as no longer held, unread and unwritten",
    () => {
      const { homes, layer } = homesOf(ready, accounts);
      const ran: RanScript[] = [];
      const read: string[] = [];
      return Effect.gen(function* () {
        // The database refuses this row (workspace_credential_homes_holder_not_resource_domain);
        // the push refuses it again, in case a row ever gets past that.
        yield* hold(
          homes,
          "/home/project",
          `${RESOURCE_DOMAIN_ID_PREFIX}6f1c2a7e-3b4d-4e5f-8a9b-0c1d2e3f4a5b`,
          "generation-domain",
          [["claude", "cacc_alice"]],
        );
        const summary = yield* pushCredentialCopy({
          connectedAccountId: "cacc_alice",
          provider: "claude",
          copyJson: JSON.stringify({ claudeAiOauth: { accessToken: "at-alice-2" } }),
          controlChannel: silentLaunchChannel,
          homeChannel: recordingHomeChannel(ran),
        }).pipe(
          Effect.provideService(ConnectedAccountRepo, {
            getById: (id: string) =>
              Effect.sync(() => read.push(id)).pipe(
                Effect.as(accounts.find((row) => row.id === id)),
              ),
          } as unknown as ConnectedAccountRepoService),
        );
        expect(summary).toEqual({ written: 0, failed: 0, unreachable: 0, released: 1 });
        expect(ran).toEqual([]);
        expect(read).toEqual([]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("counts a write the executor fenced as no longer held, never as written", () => {
    const { homes, layer } = homesOf(ready, accounts);
    const ran: RanScript[] = [];
    return Effect.gen(function* () {
      yield* hold(homes, "/run/mend/conv/ses_1", "usr_alice", "generation-alice", [
        ["claude", "cacc_alice"],
      ]);
      const summary = yield* pushCredentialCopy({
        connectedAccountId: "cacc_alice",
        provider: "claude",
        copyJson: "{}",
        controlChannel: silentLaunchChannel,
        homeChannel: recordingHomeChannel(ran, HOME_SCRIPT_EXIT.fenced),
      });
      expect(summary).toEqual({ written: 0, failed: 0, unreachable: 0, released: 1 });
      expect(ran).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "writes the account as stored when the home's lock is taken, at its revision, under the same id",
    () => {
      const stored = JSON.stringify({
        credentialsJson: JSON.stringify({
          claudeAiOauth: { accessToken: "at-newer", refreshToken: "rt", expiresAt: 2 },
        }),
      });
      const { homes, layer } = homesOf(ready, [
        account("cacc_alice", "usr_alice", "claude", stored, 2),
      ]);
      const ran: RanScript[] = [];
      return Effect.gen(function* () {
        const [placed] = yield* hold(homes, "/home/alice", "usr_alice", "generation-alice", [
          ["claude", "cacc_alice"],
        ]);
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
        expect([...homes.placementRows.values()]).toEqual([
          expect.objectContaining({ id: placed?.id, revision: 2, state: "ready" }),
        ]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("leaves no ready receipt for bytes an unanswered refresh may have written", () => {
    const { homes, layer } = homesOf(ready, [
      account("cacc_alice", "usr_alice", "claude", "{}", 2),
    ]);
    return Effect.gen(function* () {
      yield* hold(homes, "/home/alice", "usr_alice", "generation-alice", [
        ["claude", "cacc_alice"],
      ]);
      const summary = yield* pushCredentialCopy({
        connectedAccountId: "cacc_alice",
        provider: "claude",
        copyJson: "{}",
        controlChannel: silentLaunchChannel,
        homeChannel: { run: () => Effect.fail(new Error("the executor did not answer")) },
      });
      expect(summary).toMatchObject({ written: 0, failed: 1 });
      expect([...homes.placementRows.values()].map((row) => row.state)).toEqual(["pending"]);
      expect(yield* homes.placements.homesWithRemovalWork()).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });
});

/** A token whose expiry is readable, as a ChatGPT access token's is. */
const jwt = (exp: number) => `h.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.s`;

const codexCopy = (access: string) =>
  JSON.stringify({
    tokens: {
      access_token: access,
      refresh_token: "sealant-copy-cannot-refresh",
      account_id: "acc_1",
    },
  });

describe("pushCredentialCopy into homes holding pi's and opencode's logins", () => {
  const ready = [instance("h", [])];
  const accounts = [
    account("cacc_codex", "usr_alice", "codex"),
    account("cacc_claude", "usr_alice", "claude"),
  ];

  it.effect(
    "leaves out a pi or opencode file the home refuses and writes the rest once more",
    () => {
      const { homes, layer } = homesOf(ready, accounts);
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
        yield* hold(homes, "/home/alice", "usr_alice", "generation-alice", [
          ["codex", "cacc_codex"],
          ["pi", "cacc_codex"],
          ["opencode", "cacc_codex"],
        ]);
        const summary = yield* pushCredentialCopy({
          connectedAccountId: "cacc_codex",
          provider: "codex",
          copyJson: codexCopy(jwt(1_900_000_000)),
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
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("leaves a home's placements alone once the account holds a key", () => {
    const key = JSON.stringify({ apiKey: "sk-proj-FAKEcodexkeyforthetests0000wxyz" });
    const { homes, layer } = homesOf(ready, [account("cacc_codex", "usr_alice", "codex", key, 2)]);
    const ran: RanScript[] = [];
    return Effect.gen(function* () {
      yield* hold(homes, "/home/alice", "usr_alice", "generation-alice", [
        ["codex", "cacc_codex"],
        ["pi", "cacc_codex"],
      ]);
      const summary = yield* pushCredentialCopy({
        connectedAccountId: "cacc_codex",
        provider: "codex",
        copyJson: codexCopy(jwt(1_900_000_000)),
        controlChannel: silentLaunchChannel,
        homeChannel: recordingHomeChannel(ran),
        credentialCipher: {
          encrypt: (plaintext) => Effect.succeed({ sealed: `sealed:${plaintext}`, keyId: "k" }),
          decrypt: (sealed) => Effect.succeed(sealed.slice("sealed:".length)),
        },
      });
      expect(summary).toEqual({ written: 0, failed: 0, unreachable: 0, released: 1 });
      expect(ran).toEqual([]);
      expect(
        [...homes.placementRows.values()].map(({ revision, state }) => [revision, state]),
      ).toEqual([
        [1, "ready"],
        [1, "ready"],
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "writes a Codex refresh into the home's codex, pi and opencode logins in one script",
    () => {
      const { homes, layer } = homesOf(ready, accounts);
      const ran: RanScript[] = [];
      return Effect.gen(function* () {
        yield* hold(homes, "/home/alice", "usr_alice", "generation-alice", [
          ["codex", "cacc_codex"],
          ["pi", "cacc_codex"],
          ["opencode", "cacc_codex"],
          ["claude", "cacc_claude"],
        ]);
        const access = jwt(1_900_000_000);
        const summary = yield* pushCredentialCopy({
          connectedAccountId: "cacc_codex",
          provider: "codex",
          copyJson: codexCopy(access),
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
      }).pipe(Effect.provide(layer));
    },
  );
});
