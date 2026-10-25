/**
 * A person's logins in one home of a running workspace (`/v1/workspaces/:id/credentials`, design
 * doc §6c): one person per home while it is held, a refusal for anyone else, GitHub as the CLI's
 * hosts.yml, `null` removing a provider, a release that removes the files, the home path's rules,
 * and only a service key. Everything runs against an in-memory store with the live repository's
 * locking and a recording home channel. SEALANT_CREDENTIALS_KEY is stubbed before the dynamic
 * import because runtime-env parses process.env at module load.
 */
import { CredentialCipher, type CredentialCipherService } from "@sealant/credentials";
import {
  ConnectedAccountRepo,
  CredentialPlacementRepo,
  type CredentialPlacementRepoService,
  WorkspaceAttemptRepo,
  WorkspaceBuildJobRepo,
  WorkspaceCredentialHomeRepo,
  WorkspaceRepo,
  WorkspaceRuntimeInstanceRepo,
  type ConnectedAccount,
  type ConnectedAccountRepoService,
  type Workspace,
  type WorkspaceLaunchCredentialInjection,
  type WorkspaceAttemptRepoService,
  type WorkspaceBuildJobRepoService,
  type WorkspaceRepoService,
  type WorkspaceRuntimeInstance,
  type WorkspaceRuntimeInstanceRepoService,
} from "@sealant/db";
import {
  makeInMemoryCredentialHomes,
  type InMemoryCredentialHomes,
} from "@sealant/db/testing/credential-homes";
import { sweepCredentialPlacements, type HomeCredentialChannel } from "@sealant/workspaces";
import { Effect, Fiber, Layer, Result } from "effect";
import { beforeAll, describe, expect, it } from "vitest";

import type { RequestPrincipal } from "../../services/service-principals.js";

process.env["SEALANT_CREDENTIALS_KEY"] = Buffer.alloc(32, 7).toString("base64");

let routes: typeof import("./workspace-credentials.js");
let CurrentPrincipal: (typeof import("../../services/service-principals.js"))["CurrentPrincipal"];

beforeAll(async () => {
  routes = await import("./workspace-credentials.js");
  ({ CurrentPrincipal } = await import("../../services/service-principals.js"));
});

const OWNER = "usr_owner";
const ALICE = "usr_alice";
const BOB = "usr_bob";
const HOME = "/home/m4lice000";
const CONV = "/run/mend/conv/ses_1";

const fakeCipher: CredentialCipherService = {
  encrypt: (plaintext) => Effect.succeed({ sealed: `sealed:${plaintext}`, keyId: "k-test" }),
  decrypt: (sealed) => Effect.succeed(sealed.slice("sealed:".length)),
};

const claudeFile = (accessToken: string) =>
  JSON.stringify({
    claudeAiOauth: { accessToken, refreshToken: `rt-${accessToken}`, expiresAt: 1_900_000_000_000 },
  });

const account = (overrides: Partial<ConnectedAccount>): ConnectedAccount =>
  ({
    id: "cacc_x",
    ownerUserId: ALICE,
    provider: "claude",
    name: "default",
    kind: "credentials-json",
    status: "active",
    encryptedPayload: `sealed:${JSON.stringify({ credentialsJson: claudeFile("at-alice") })}`,
    encryptionKeyId: "k-test",
    payloadSha256: "sha",
    credentialRevision: 1,
    metadata: {},
    createdAt: new Date("2026-10-01T00:00:00.000Z"),
    updatedAt: new Date("2026-10-01T00:00:00.000Z"),
    lastUsedAt: null,
    lastSyncedAt: null,
    invalidAt: null,
    archivedAt: null,
    ...overrides,
  }) as ConnectedAccount;

const aliceClaude = account({ id: "cacc_alice_claude" });
const aliceWork = account({
  id: "cacc_alice_work",
  name: "work",
  encryptedPayload: `sealed:${JSON.stringify({ credentialsJson: claudeFile("at-alice-work") })}`,
});
const aliceCodex = account({
  id: "cacc_alice_codex",
  provider: "codex",
  kind: "auth-json",
  encryptedPayload: `sealed:${JSON.stringify({
    authJson: JSON.stringify({ tokens: { access_token: "at-codex", refresh_token: "rt-codex" } }),
  })}`,
});
const aliceGitHub = account({
  id: "cacc_alice_github",
  provider: "github",
  kind: "gh-cli-token",
  encryptedPayload: `sealed:${JSON.stringify({ token: "gho_alice" })}`,
  metadata: { login: "alice-gh" },
});
const aliceInvalid = account({ id: "cacc_alice_invalid", name: "broken", status: "invalid" });
const chatgptAccess = `h.${Buffer.from(JSON.stringify({ exp: 1_900_000_000 })).toString("base64url")}.s`;
const aliceChatGpt = account({
  id: "cacc_alice_chatgpt",
  provider: "codex",
  kind: "auth-json",
  name: "chatgpt",
  encryptedPayload: `sealed:${JSON.stringify({
    authJson: JSON.stringify({
      tokens: { access_token: chatgptAccess, refresh_token: "rt-chatgpt", account_id: "acct_1" },
    }),
  })}`,
});
const aliceCorruptCodex = account({
  id: "cacc_alice_corrupt",
  provider: "codex",
  kind: "auth-json",
  name: "corrupt",
  encryptedPayload: `sealed:${JSON.stringify({ authJson: "not json" })}`,
});
const aliceSetupToken = account({
  id: "cacc_alice_token",
  name: "token",
  kind: "oauth-token",
  encryptedPayload: `sealed:${JSON.stringify({ token: "sk-ant-oat01-alice" })}`,
});
const codexKey = "sk-proj-FAKEcodexkeyforthetests0000wxyz";
const aliceCodexKey = account({
  id: "cacc_alice_codex_key",
  provider: "codex",
  kind: "api-key",
  name: "key",
  encryptedPayload: `sealed:${JSON.stringify({ apiKey: codexKey })}`,
});
const aliceLegacyCodexKey = account({
  id: "cacc_alice_codex_legacy_key",
  provider: "codex",
  kind: "auth-json",
  name: "legacy-key",
  encryptedPayload: `sealed:${JSON.stringify({
    authJson: JSON.stringify({ OPENAI_API_KEY: codexKey, tokens: null }),
  })}`,
});
const aliceClaudeKey = account({
  id: "cacc_alice_claude_key",
  kind: "api-key",
  name: "key",
  encryptedPayload: `sealed:${JSON.stringify({ apiKey: "sk-ant-api03-FAKEclaudekeyforthetests000000wxyz" })}`,
});
const ownerClaudeKey = account({
  id: "cacc_owner_claude_key",
  ownerUserId: OWNER,
  kind: "api-key",
  name: "key",
  encryptedPayload: `sealed:${JSON.stringify({ apiKey: "sk-ant-api03-FAKEownerkeyforthetests00000000wxyz" })}`,
});
const bobClaude = account({
  id: "cacc_bob_claude",
  ownerUserId: BOB,
  encryptedPayload: `sealed:${JSON.stringify({ credentialsJson: claudeFile("at-bob") })}`,
});

const accounts: ConnectedAccount[] = [
  aliceClaude,
  aliceWork,
  aliceCodex,
  aliceGitHub,
  aliceInvalid,
  aliceCorruptCodex,
  aliceChatGpt,
  aliceSetupToken,
  aliceCodexKey,
  aliceLegacyCodexKey,
  aliceClaudeKey,
  ownerClaudeKey,
  bobClaude,
];

const chosenDefaults: ReadonlyMap<string, string> = new Map([
  [`${ALICE} claude`, aliceClaude.id],
  [`${ALICE} codex`, aliceCodex.id],
  [`${ALICE} github`, aliceGitHub.id],
  [`${BOB} claude`, bobClaude.id],
]);

const instanceRow = (
  status: WorkspaceRuntimeInstance["status"] = "ready",
  injections: readonly WorkspaceLaunchCredentialInjection[] | null = [],
): WorkspaceRuntimeInstance =>
  ({
    runId: "run_1",
    status,
    adapter: "docker",
    resourceId: "container-run_1",
    reference: "container-run_1",
    endpoint: "unix:///run/sealant/run_1.sock",
    launchCredentialInjections: injections,
  }) as WorkspaceRuntimeInstance;

const workspace = { id: "wks_1", ownerUserId: OWNER, latestRunId: "run_1" } as Workspace;

/** The parts of a recorded spec a Claude key put reads: where the run saves state. */
interface SavedRoots {
  readonly workingDirectory: string;
  readonly harnessHome?: string;
}
const recordedSpec = (roots: SavedRoots) => ({
  runtime: { workingDirectory: roots.workingDirectory },
  sources: {
    workspace:
      roots.harnessHome === undefined
        ? { kind: "git" }
        : { kind: "capture", harnessHome: roots.harnessHome },
  },
});

interface Ran {
  readonly script: string;
  /** The decoded payloads, in order. */
  readonly payloads: readonly string[];
}

const homeOf = (entry: Ran) => entry.script.match(/home='([^']+)'/)?.[1];

const newWorld = (
  instance: WorkspaceRuntimeInstance = instanceRow(),
  defaults: ReadonlyMap<string, string> = chosenDefaults,
) => {
  const state: { instance: WorkspaceRuntimeInstance; saved: SavedRoots | undefined } = {
    instance,
    saved: { workingDirectory: "/workspace/repo" },
  };
  const currentAccounts = accounts.map((entry) => ({ ...entry }));
  const homes = makeInMemoryCredentialHomes(() => [state.instance], {
    accounts: () => currentAccounts,
    defaults: () => [...defaults.values()],
  });
  const ran: Ran[] = [];
  const exits: Array<number | "throw"> = [];
  const afterRun: Array<() => void> = [];
  let slowRead = false;
  const channel: HomeCredentialChannel = {
    run: (_target, script, stdin) =>
      Effect.suspend(() => {
        const next = exits.shift() ?? 0;
        if (next === "throw") return Effect.fail(new Error("the daemon did not answer"));
        ran.push({
          script,
          payloads: stdin
            .split("\n")
            .filter((line) => line.length > 0)
            .map((line) => Buffer.from(line, "base64").toString("utf8")),
        });
        afterRun.shift()?.();
        return Effect.succeed({ exitCode: next });
      }),
  };
  const slowNextRead = () => {
    slowRead = true;
  };
  const placements: CredentialPlacementRepoService = {
    ...homes.placements,
    state: (home, accountIds) =>
      Effect.suspend(() => {
        const slow = slowRead;
        slowRead = false;
        return slow
          ? Effect.sleep("40 millis").pipe(Effect.andThen(homes.placements.state(home, accountIds)))
          : homes.placements.state(home, accountIds);
      }),
  };
  const layer = Layer.mergeAll(
    Layer.succeed(CredentialCipher, fakeCipher),
    Layer.succeed(WorkspaceCredentialHomeRepo, homes.service),
    Layer.succeed(CredentialPlacementRepo, placements),
    Layer.succeed(WorkspaceRepo, {
      getWorkspaceById: (id: string) => Effect.succeed(id === workspace.id ? workspace : undefined),
    } as unknown as WorkspaceRepoService),
    Layer.succeed(ConnectedAccountRepo, {
      getById: (id: string) =>
        Effect.succeed(currentAccounts.find((candidate) => candidate.id === id)),
      getByOwnerProviderName: (input: { ownerUserId: string; provider: string; name: string }) =>
        Effect.succeed(
          currentAccounts.find(
            (candidate) =>
              candidate.ownerUserId === input.ownerUserId &&
              candidate.provider === input.provider &&
              candidate.name === input.name &&
              candidate.archivedAt === null,
          ),
        ),
      getDefault: (input: { ownerUserId: string; provider: string }) =>
        Effect.succeed(
          currentAccounts.find(
            (candidate) => candidate.id === defaults.get(`${input.ownerUserId} ${input.provider}`),
          ),
        ),
    } as unknown as ConnectedAccountRepoService),
    Layer.succeed(WorkspaceAttemptRepo, {
      getAttemptSnapshotByRunId: (runId: string) =>
        Effect.succeed(
          runId === state.instance.runId && state.saved !== undefined
            ? { resolvedSpecPayload: recordedSpec(state.saved) }
            : undefined,
        ),
    } as unknown as WorkspaceAttemptRepoService),
    Layer.succeed(WorkspaceBuildJobRepo, {
      getLatestJobByRunId: () => Effect.succeed(undefined),
    } as unknown as WorkspaceBuildJobRepoService),
    Layer.succeed(WorkspaceRuntimeInstanceRepo, {
      listRunningInstances: () => Effect.succeed([state.instance]),
      getRuntimeInstanceByRunId: (runId: string) =>
        Effect.succeed(state.instance.runId === runId ? state.instance : undefined),
    } as unknown as WorkspaceRuntimeInstanceRepoService),
  );

  const run = <A, E>(
    effect: Effect.Effect<A, E, Layer.Success<typeof layer>>,
    principal: RequestPrincipal = { kind: "service" },
  ) =>
    Effect.runPromise(
      Effect.result(
        effect.pipe(Effect.provide(layer), Effect.provideService(CurrentPrincipal, principal)),
      ),
    );

  const put = (
    payload: {
      readonly onBehalfOfUserId: string;
      readonly home?: string;
      readonly claude?: string | null;
      readonly codex?: string | null;
      readonly github?: string | null;
      readonly pi?: string | null;
      readonly opencode?: string | null;
      readonly partial?: boolean;
      readonly live?: readonly string[];
      readonly uid?: number;
      readonly gid?: number;
    },
    principal?: RequestPrincipal,
  ) =>
    run(
      routes.putWorkspaceCredentials({
        workspaceId: workspace.id,
        payload: { ownerUserId: OWNER, home: HOME, ...payload },
        homeChannel: channel,
      }),
      principal,
    );

  const release = (home: string = HOME) =>
    run(
      routes.releaseWorkspaceCredentials({
        workspaceId: workspace.id,
        query: { ownerUserId: OWNER, home },
        homeChannel: channel,
      }),
    );

  const list = () =>
    run(
      routes.listWorkspaceCredentials({ workspaceId: workspace.id, query: { ownerUserId: OWNER } }),
    );

  const prune = (live: readonly string[]) =>
    run(
      routes.pruneWorkspaceCredentials({
        workspaceId: workspace.id,
        payload: { ownerUserId: OWNER, home: HOME, live },
        homeChannel: channel,
      }),
    );
  const sweep = () => run(sweepCredentialPlacements({ homeChannel: channel }));
  return {
    state,
    homes,
    ran,
    exits,
    afterRun,
    slowNextRead,
    put,
    release,
    list,
    prune,
    sweep,
    currentAccounts,
  };
};

const succeeded = <A, E>(result: Result.Result<A, E>): A => {
  if (Result.isFailure(result)) throw new Error(`refused: ${JSON.stringify(result.failure)}`);
  return result.success;
};

const failed = <A, E>(result: Result.Result<A, E>): E => {
  if (!Result.isFailure(result)) throw new Error("expected a refusal");
  return result.failure;
};

const heldLogins = (world: { readonly homes: InMemoryCredentialHomes }) =>
  [...world.homes.placementRows.values()]
    .filter((row) => row.state === "ready")
    .map((row) => ({ provider: row.provider, connectedAccountId: row.accountId }));

describe("putWorkspaceCredentials", () => {
  it("writes the person's logins into the home as copies and records the home as theirs", async () => {
    const world = newWorld();
    const answer = succeeded(
      await world.put({
        onBehalfOfUserId: ALICE,
        claude: "default",
        codex: "default",
        github: "default",
      }),
    );

    expect(answer).toMatchObject({
      workspaceId: "wks_1",
      runId: "run_1",
      home: {
        home: HOME,
        onBehalfOfUserId: ALICE,
        accounts: {
          claude: { connectedAccountId: aliceClaude.id, name: "default" },
          codex: { connectedAccountId: aliceCodex.id, name: "default" },
          github: { connectedAccountId: aliceGitHub.id, name: "default" },
        },
      },
    });
    // One exec for the whole put.
    expect(world.ran).toHaveLength(1);
    const [claude, codex, github] = world.ran[0]?.payloads ?? [];
    expect(claude).toContain("at-alice");
    expect(claude).not.toContain("refreshToken");
    expect(codex).toContain("at-codex");
    expect(codex).not.toContain("rt-codex");
    expect(github).toBe(
      'github.com:\n    oauth_token: "gho_alice"\n    git_protocol: https\n    user: "alice-gh"\n',
    );
    expect(world.ran[0]?.script).toContain(".config/gh/hosts.yml");
    expect(world.homes.rows.get(`run_1 ${HOME}`)?.onBehalfOfUserId).toBe(ALICE);
  });

  it("writes the chosen default for `default`, though another account is named default", async () => {
    const world = newWorld(instanceRow(), new Map([[`${ALICE} claude`, aliceWork.id]]));
    const answer = succeeded(await world.put({ onBehalfOfUserId: ALICE, claude: "default" }));
    expect(answer.home.accounts.claude).toEqual({
      connectedAccountId: aliceWork.id,
      name: "work",
    });
    expect(world.ran[0]?.payloads[0]).toContain("at-alice-work");

    const none = newWorld(instanceRow(), new Map());
    expect(failed(await none.put({ onBehalfOfUserId: ALICE, claude: "default" }))).toMatchObject({
      code: "connected-account-missing",
      provider: "claude",
    });
  });

  it("writes a setup token as a credentials file", async () => {
    const world = newWorld();
    succeeded(await world.put({ onBehalfOfUserId: ALICE, claude: "token" }));
    expect(JSON.parse(world.ran[0]?.payloads[0] ?? "{}")).toMatchObject({
      claudeAiOauth: { accessToken: "sk-ant-oat01-alice", scopes: ["user:inference"] },
    });
  });

  it("refuses anyone else's logins in a held home, writing nothing", async () => {
    const world = newWorld();
    succeeded(await world.put({ onBehalfOfUserId: ALICE, claude: "default" }));

    const failure = failed(await world.put({ onBehalfOfUserId: BOB, claude: "default" }));
    expect(failure).toMatchObject({ _tag: "WorkspaceConflictError", code: "home-held" });
    expect(world.ran).toHaveLength(1);
    expect(world.homes.rows.get(`run_1 ${HOME}`)).toMatchObject({ onBehalfOfUserId: ALICE });
    expect(
      [...world.homes.placementRows.values()].map((row) => [
        row.provider,
        row.accountId,
        row.state,
      ]),
    ).toEqual([["claude", aliceClaude.id, "ready"]]);
  });

  it("lets the same person change an account and remove a provider they have not connected", async () => {
    const world = newWorld();
    succeeded(await world.put({ onBehalfOfUserId: ALICE, claude: "default", codex: "default" }));

    const answer = succeeded(
      await world.put({ onBehalfOfUserId: ALICE, claude: "work", codex: null }),
    );
    expect(answer.home.accounts).toEqual({
      claude: { connectedAccountId: aliceWork.id, name: "work" },
    });
    expect(world.ran[1]?.payloads).toEqual([expect.stringContaining("at-alice-work")]);
    expect(world.ran[1]?.script).toContain(`rm -f "$home/.codex/auth.json"`);
  });

  it("takes the home again for another person once it is released", async () => {
    const world = newWorld();
    succeeded(await world.put({ onBehalfOfUserId: ALICE, home: CONV, claude: "default" }));
    expect(succeeded(await world.release(CONV)).released).toBe(true);

    const answer = succeeded(
      await world.put({ onBehalfOfUserId: BOB, home: CONV, claude: "default" }),
    );
    expect(answer.home.onBehalfOfUserId).toBe(BOB);
    expect(world.ran.at(-1)?.payloads[0]).toContain("at-bob");
  });

  it("refuses an account the person cannot name, and an invalid one, writing nothing", async () => {
    for (const selection of ["missing", bobClaude.id]) {
      const world = newWorld();
      expect(failed(await world.put({ onBehalfOfUserId: ALICE, claude: selection }))).toMatchObject(
        {
          _tag: "WorkspaceNotFoundError",
          code: "connected-account-missing",
          provider: "claude",
          // The words stay as they were.
          message: `No claude connected account matches "${selection}".`,
        },
      );
      expect(world.ran).toEqual([]);
      expect([...world.homes.placementRows.values()].some((row) => row.state === "ready")).toBe(
        false,
      );
    }
    const world = newWorld();
    expect(failed(await world.put({ onBehalfOfUserId: ALICE, claude: "broken" }))).toMatchObject({
      _tag: "WorkspaceConflictError",
      code: "connected-account-invalid",
      provider: "claude",
      message: 'Connected claude account "broken" is invalid — reconnect it.',
    });
    expect(world.ran).toEqual([]);
  });

  it("names the provider a refusal is about, whichever provider of the put it is", async () => {
    // Claude is connected; GitHub is not: the refusal names github, and nothing is written.
    const world = newWorld();
    expect(
      failed(await world.put({ onBehalfOfUserId: ALICE, claude: "default", github: "work" })),
    ).toMatchObject({ code: "connected-account-missing", provider: "github" });
    expect(world.ran).toEqual([]);
    // Bob has no Codex account at all.
    expect(failed(await newWorld().put({ onBehalfOfUserId: BOB, codex: "default" }))).toMatchObject(
      { code: "connected-account-missing", provider: "codex" },
    );
  });

  it("answers an account whose stored credential is unusable as invalid, naming its provider", async () => {
    const world = newWorld();
    expect(failed(await world.put({ onBehalfOfUserId: ALICE, codex: "corrupt" }))).toMatchObject({
      _tag: "WorkspaceConflictError",
      code: "connected-account-invalid",
      provider: "codex",
    });
    expect(world.ran).toEqual([]);
  });

  it("writes pi's and opencode's ChatGPT logins from the person's Codex account", async () => {
    const world = newWorld();
    const answer = succeeded(
      await world.put({ onBehalfOfUserId: ALICE, pi: "chatgpt", opencode: "chatgpt" }),
    );
    expect(answer.home.accounts).toEqual({
      pi: { connectedAccountId: aliceChatGpt.id, name: "chatgpt" },
      opencode: { connectedAccountId: aliceChatGpt.id, name: "chatgpt" },
    });
    expect(world.ran).toHaveLength(1);
    const entry = {
      type: "oauth",
      access: chatgptAccess,
      refresh: "sealant-copy-cannot-refresh",
      expires: 1_900_000_000_000,
      accountId: "acct_1",
    };
    expect(world.ran[0]?.payloads.map((payload) => JSON.parse(payload))).toEqual([entry, entry]);
    // The stored refresh token never leaves the store.
    expect(world.ran[0]?.payloads.join("")).not.toContain("rt-chatgpt");
    expect(world.ran[0]?.script).toContain("openai-codex");
    expect(heldLogins(world)).toEqual([
      { provider: "pi", connectedAccountId: aliceChatGpt.id },
      { provider: "opencode", connectedAccountId: aliceChatGpt.id },
    ]);
  });

  it("refuses pi's login from a Codex account that is not a ChatGPT login, or that is missing", async () => {
    const world = newWorld();
    expect(failed(await world.put({ onBehalfOfUserId: ALICE, pi: "default" }))).toMatchObject({
      _tag: "WorkspaceConflictError",
      code: "connected-account-unsupported",
      provider: "codex",
    });
    expect(world.ran).toEqual([]);
    expect(failed(await world.put({ onBehalfOfUserId: BOB, opencode: "default" }))).toMatchObject({
      _tag: "WorkspaceNotFoundError",
      code: "connected-account-missing",
      provider: "codex",
    });
  });

  it("writes a Codex key as Codex's own key file, a key stored as an auth.json too", async () => {
    for (const name of ["key", "legacy-key"]) {
      const world = newWorld();
      const answer = succeeded(await world.put({ onBehalfOfUserId: ALICE, codex: name }));
      expect(answer.home.placements?.[0]?.login).toEqual({ kind: "api-key", suffix: "wxyz" });
      expect(world.ran[0]?.payloads).toEqual([
        JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: codexKey }),
      ]);
      expect(world.ran[0]?.script).toContain(".codex/auth.json");
    }
  });

  it("writes a Claude key alone into a file of its own, and its receipt names that file", async () => {
    const world = newWorld();
    const answer = succeeded(await world.put({ onBehalfOfUserId: ALICE, claude: "key" }));
    const receipt = answer.home.placements?.[0];
    const keyPath = `${HOME}/.sealant/keys/${receipt?.placementId ?? "missing"}`;
    expect(receipt).toMatchObject({
      provider: "claude",
      accountId: aliceClaudeKey.id,
      login: { kind: "api-key", suffix: "wxyz", keyPath },
      pinned: false,
    });
    expect(world.ran[0]?.payloads).toEqual(["sk-ant-api03-FAKEclaudekeyforthetests000000wxyz"]);
    expect(world.ran[0]?.script).toContain(`f="$home/.sealant/keys/${receipt?.placementId ?? ""}"`);
    expect(world.ran[0]?.script).not.toContain('f="$home/.claude/.credentials.json"');
  });

  it("names the subscription's account under accounts.claude, never a key's", async () => {
    const world = newWorld();
    succeeded(await world.put({ onBehalfOfUserId: ALICE, claude: "key" }));
    const keyOnly = succeeded(await world.put({ onBehalfOfUserId: ALICE, claude: "key" }));
    expect(keyOnly.home.accounts).toEqual({});
    const keyId = keyOnly.home.placements?.[0]?.placementId ?? "missing";
    const both = succeeded(
      await world.put({ onBehalfOfUserId: ALICE, claude: "default", live: [keyId] }),
    );
    const again = succeeded(
      await world.put({ onBehalfOfUserId: ALICE, claude: "key", live: [keyId] }),
    );
    for (const answer of [both, again]) {
      expect(answer.home.accounts).toEqual({
        claude: { connectedAccountId: aliceClaude.id, name: "default" },
      });
      expect(answer.home.placements?.map((row) => row.accountId).toSorted()).toEqual(
        [aliceClaude.id, aliceClaudeKey.id].toSorted(),
      );
    }
  });

  it("refuses a Claude key in the launch home, with words and nothing written", async () => {
    const world = newWorld();
    expect(
      failed(await world.put({ onBehalfOfUserId: OWNER, home: "/root", claude: "key" })),
    ).toMatchObject({
      code: "connected-account-unsupported",
      provider: "claude",
      message: expect.stringContaining("/root is the launch's home"),
    });
    expect(world.ran).toEqual([]);
  });

  it("refuses a Claude key where the run saves state, or where Core cannot tell", async () => {
    const cases: ReadonlyArray<readonly [SavedRoots | undefined, string, string]> = [
      [
        { workingDirectory: "/workspace/repo", harnessHome: "/captured" },
        "/captured/people/alice",
        "lies in /captured, which the workspace saves",
      ],
      [{ workingDirectory: "/srv/work" }, "/srv/work/alice", "lies in /srv/work"],
      [{ workingDirectory: "/workspace/repo", harnessHome: `${HOME}/.sealant` }, HOME, "lies in"],
      [undefined, HOME, "no recorded spec"],
    ];
    for (const [saved, home, words] of cases) {
      const world = newWorld();
      world.state.saved = saved;
      expect(
        failed(await world.put({ onBehalfOfUserId: ALICE, home, claude: "key" })),
      ).toMatchObject({
        code: "connected-account-unsupported",
        message: expect.stringContaining(words),
      });
      expect(world.ran).toEqual([]);
      const partial = succeeded(
        await world.put({
          onBehalfOfUserId: ALICE,
          home,
          claude: "key",
          github: "default",
          partial: true,
        }),
      );
      expect(partial.skipped).toEqual([
        {
          provider: "claude",
          code: "connected-account-unsupported",
          message: expect.stringContaining(words),
        },
      ]);
      expect(world.ran).toHaveLength(1);
      expect(world.ran[0]?.payloads).toEqual([expect.stringContaining("gho_alice")]);
    }
    const beside = newWorld();
    beside.state.saved = { workingDirectory: "/workspace/repo", harnessHome: "/captured" };
    expect(
      succeeded(await beside.put({ onBehalfOfUserId: ALICE, claude: "key" })).home.placements,
    ).toEqual([expect.objectContaining({ accountId: aliceClaudeKey.id })]);
  });

  it("refuses a Codex key as pi's login, with words and nothing written", async () => {
    const world = newWorld();
    expect(failed(await world.put({ onBehalfOfUserId: ALICE, pi: "key" }))).toMatchObject({
      code: "connected-account-unsupported",
      provider: "codex",
    });
    expect(world.ran).toEqual([]);
  });

  it("a partial put writes what is connected, in one exec, and says what it left out", async () => {
    const world = newWorld();
    const answer = succeeded(
      await world.put({
        onBehalfOfUserId: ALICE,
        claude: "default",
        github: "nope",
        // Alice's default Codex account is not a ChatGPT login.
        pi: "default",
        partial: true,
      }),
    );
    expect(answer.home.accounts).toEqual({
      claude: { connectedAccountId: aliceClaude.id, name: "default" },
    });
    expect(answer.skipped).toEqual([
      {
        provider: "github",
        code: "connected-account-missing",
        message: 'No github connected account matches "nope".',
      },
      {
        provider: "pi",
        code: "connected-account-unsupported",
        message: expect.stringContaining("not a ChatGPT login"),
      },
    ]);
    expect(world.ran).toHaveLength(1);
    expect(world.ran[0]?.payloads).toHaveLength(1);
  });

  it("a partial put removes a held login whose account is now refused", async () => {
    const world = newWorld();
    succeeded(await world.put({ onBehalfOfUserId: ALICE, claude: "default", github: "default" }));
    const answer = succeeded(
      await world.put({
        onBehalfOfUserId: ALICE,
        claude: "default",
        github: "gone",
        partial: true,
      }),
    );
    expect(answer.home.accounts.github).toBeUndefined();
    expect(answer.skipped).toEqual([
      expect.objectContaining({ provider: "github", code: "connected-account-missing" }),
    ]);
    expect(world.ran[1]?.script).toContain('rm -f "$home/.config/gh/hosts.yml"');
    expect(heldLogins(world)).toEqual([{ provider: "claude", connectedAccountId: aliceClaude.id }]);
  });

  it("a partial put leaves out an opencode file it cannot write there, and still writes and removes the rest", async () => {
    const world = newWorld();
    succeeded(await world.put({ onBehalfOfUserId: ALICE, claude: "default", github: "default" }));
    // The first script finds opencode's auth.json really outside the home; the retry succeeds.
    world.exits.push(85, 0);
    const answer = succeeded(
      await world.put({
        onBehalfOfUserId: ALICE,
        claude: "default",
        github: "gone",
        opencode: "chatgpt",
        partial: true,
      }),
    );
    expect(answer.skipped).toEqual([
      expect.objectContaining({ provider: "github", code: "connected-account-missing" }),
      expect.objectContaining({ provider: "opencode", code: "login-file-unusable" }),
    ]);
    // The retry wrote claude only and removed the stale GitHub login.
    const retry = world.ran[world.ran.length - 1];
    expect(retry?.payloads).toHaveLength(1);
    expect(retry?.script).toContain('rm -f "$home/.config/gh/hosts.yml"');
    expect(heldLogins(world)).toEqual([{ provider: "claude", connectedAccountId: aliceClaude.id }]);
    // A whole put fails on the same file, naming it.
    const whole = newWorld();
    whole.exits.push(85);
    expect(failed(await whole.put({ onBehalfOfUserId: ALICE, opencode: "chatgpt" }))).toMatchObject(
      { code: "home-unusable" },
    );
  });

  it("a partial put leaves out a Claude, Codex or GitHub file with another hard link, and writes the rest", async () => {
    for (const [exit, provider] of [
      [86, "claude"],
      [87, "codex"],
      [88, "github"],
    ] as const) {
      const world = newWorld();
      succeeded(await world.put({ onBehalfOfUserId: ALICE, codex: null }));
      world.exits.push(exit, 0);
      const answer = succeeded(
        await world.put({
          onBehalfOfUserId: ALICE,
          claude: "default",
          codex: "default",
          github: "default",
          partial: true,
        }),
      );
      expect(answer.skipped).toEqual([
        expect.objectContaining({ provider, code: "login-file-unusable" }),
      ]);
      const retry = world.ran[world.ran.length - 1];
      expect(retry?.payloads).toHaveLength(2);
      expect(heldLogins(world).map((entry) => entry.provider)).toEqual(
        ["claude", "codex", "github"].filter((name) => name !== provider),
      );
    }
  });

  it("a partial put still fails on anything but a refused account, and a whole put answers no skips", async () => {
    const world = newWorld();
    succeeded(await world.put({ onBehalfOfUserId: ALICE, claude: "default" }));
    expect(
      failed(await world.put({ onBehalfOfUserId: BOB, claude: "default", partial: true })),
    ).toMatchObject({ code: "home-held" });
    const whole = succeeded(await newWorld().put({ onBehalfOfUserId: ALICE, claude: "default" }));
    expect(whole.skipped).toBeUndefined();
  });

  it("refuses a path that is not a home", async () => {
    for (const home of ["relative", "/workspace/harness-home", "/home/../etc", "/home/x/"]) {
      const world = newWorld();
      expect(
        failed(await world.put({ onBehalfOfUserId: ALICE, home, claude: "default" })),
      ).toMatchObject({ _tag: "WorkspaceBadRequestError" });
      expect(world.ran).toEqual([]);
    }
  });

  it("refuses /root while the launch's own logins are there", async () => {
    const world = newWorld(
      instanceRow("ready", [
        { provider: "claude", connectedAccountId: "cacc_owner", injection: "file", copy: true },
      ]),
    );
    expect(
      failed(await world.put({ onBehalfOfUserId: ALICE, home: "/root", claude: "default" })),
    ).toMatchObject({ _tag: "WorkspaceConflictError", code: "home-held" });
    expect(world.ran).toEqual([]);

    // A launch that wrote its logins into a named home leaves /root to the fallback: the owner's.
    const fallback = newWorld();
    expect(
      failed(await fallback.put({ onBehalfOfUserId: ALICE, home: "/root", claude: "default" })),
    ).toMatchObject({ _tag: "WorkspaceConflictError", code: "home-held" });
    expect(fallback.ran).toEqual([]);
  });

  it("answers home-unusable when the home is missing or reached through a link", async () => {
    const world = newWorld();
    world.exits.push(74);
    expect(failed(await world.put({ onBehalfOfUserId: ALICE, claude: "default" }))).toMatchObject({
      _tag: "WorkspaceConflictError",
      code: "home-unusable",
    });
    expect([...world.homes.placementRows.values()].some((row) => row.state === "ready")).toBe(
      false,
    );
  });

  it("releases a first take's marker when its owner's half refuses a link, so the home can be taken again", async () => {
    const world = newWorld();
    world.exits.push(73);
    expect(failed(await world.put({ onBehalfOfUserId: ALICE, opencode: "chatgpt" }))).toMatchObject(
      {
        _tag: "WorkspaceConflictError",
        code: "home-unusable",
      },
    );
    // The take ran, then its release, fenced by the take's own generation.
    expect(world.ran).toHaveLength(2);
    const generation = world.ran[0]?.script.match(/printf '%s' '([^']+)' > "\$m.tmp"/)?.[1];
    expect(generation).toBeDefined();
    expect(world.ran[1]?.script).toContain(`'${generation ?? ""}'`);
    expect(world.ran[1]?.script).toContain('rm -f "$m"');
    expect([...world.homes.placementRows.values()].some((row) => row.state === "ready")).toBe(
      false,
    );
  });

  it("answers an unusable or outside pi/opencode file as home-unusable, naming it, and clears the take", async () => {
    for (const [exit, file] of [
      [82, ".pi/agent/auth.json"],
      [83, ".local/share/opencode/auth.json"],
      [84, ".pi/agent/auth.json"],
      [85, ".local/share/opencode/auth.json"],
    ] as const) {
      const world = newWorld();
      world.exits.push(exit);
      const refusal = failed(
        await world.put({ onBehalfOfUserId: ALICE, pi: "chatgpt", opencode: "chatgpt" }),
      );
      expect(refusal).toMatchObject({ _tag: "WorkspaceConflictError", code: "home-unusable" });
      expect(refusal.message).toContain(`${HOME}/${file}`);
      expect(refusal.message).not.toContain("symbolic link");
      // The take's release followed.
      expect(world.ran).toHaveLength(2);
      expect([...world.homes.placementRows.values()].some((row) => row.state === "ready")).toBe(
        false,
      );
    }
  });

  it("answers a whole-file login with another hard link as home-unusable, naming it, and clears the take", async () => {
    for (const [exit, file] of [
      [86, ".claude/.credentials.json"],
      [87, ".codex/auth.json"],
      [88, ".config/gh/hosts.yml"],
    ] as const) {
      const world = newWorld();
      world.exits.push(exit);
      const refusal = failed(
        await world.put({
          onBehalfOfUserId: ALICE,
          claude: "default",
          codex: "default",
          github: "default",
        }),
      );
      expect(refusal).toMatchObject({ _tag: "WorkspaceConflictError", code: "home-unusable" });
      expect(refusal.message).toContain(`${HOME}/${file}`);
      expect(refusal.message).toContain("hard link");
      // The take's release followed.
      expect(world.ran).toHaveLength(2);
      expect([...world.homes.placementRows.values()].some((row) => row.state === "ready")).toBe(
        false,
      );
    }
  });

  it("sends every login on the exec's stdin, never in the script it runs", async () => {
    const world = newWorld();
    succeeded(
      await world.put({
        onBehalfOfUserId: ALICE,
        claude: "default",
        codex: "default",
        github: "default",
        pi: "chatgpt",
        opencode: "chatgpt",
      }),
    );
    succeeded(await world.release());
    expect(world.ran).toHaveLength(2);
    const payloads = world.ran[0]?.payloads ?? [];
    expect(payloads).toHaveLength(5);
    for (const { script } of world.ran) {
      for (const payload of payloads) {
        expect(script).not.toContain(payload);
        expect(script).not.toContain(Buffer.from(payload, "utf8").toString("base64"));
      }
      for (const secret of ["at-alice", "at-codex", "gho_alice", chatgptAccess]) {
        expect(script).not.toContain(secret);
      }
    }
  });

  it("answers no node as home-unusable, and a release without node leaves the home held", async () => {
    const world = newWorld();
    succeeded(await world.put({ onBehalfOfUserId: ALICE, pi: "chatgpt" }));
    world.exits.push(81);
    expect(failed(await world.release())).toMatchObject({ code: "home-unusable" });
    expect(world.homes.rows.get(`run_1 ${HOME}`)?.onBehalfOfUserId).toBe(ALICE);
  });

  it("records nothing, and removes what it may have written, when a first write is unconfirmed", async () => {
    const world = newWorld();
    world.exits.push("throw");
    expect(failed(await world.put({ onBehalfOfUserId: ALICE, claude: "default" }))).toMatchObject({
      _tag: "WorkspaceBadGatewayError",
    });
    expect([...world.homes.placementRows.values()].some((row) => row.state === "ready")).toBe(
      false,
    );
    expect(world.ran).toHaveLength(1);
    expect(world.ran[0]?.payloads).toEqual([]);
    expect(world.ran[0]?.script).toContain(`rm -f "$home/.claude/.credentials.json"`);
    expect(world.ran[0]?.script).toContain(`rm -f "$m"`);
  });

  it("keeps a held home when a later write is unconfirmed, and leaves its slot to removal", async () => {
    const world = newWorld();
    succeeded(await world.put({ onBehalfOfUserId: ALICE, claude: "default" }));
    world.exits.push("throw");
    const failure = failed(await world.put({ onBehalfOfUserId: ALICE, claude: "work" }));
    expect(failure).toMatchObject({ _tag: "WorkspaceBadGatewayError" });
    expect(failure.message).toContain("Core removes whatever of it landed");
    expect(world.homes.rows.get(`run_1 ${HOME}`)).toMatchObject({ onBehalfOfUserId: ALICE });
    expect(
      [...world.homes.placementRows.values()].map((row) => [row.accountId, row.state]),
    ).toEqual([
      [aliceClaude.id, "ready"],
      [aliceWork.id, "pending"],
    ]);
    succeeded(await world.sweep());
    expect(world.ran.at(-1)?.script).toContain('rm -f "$home/.claude/.credentials.json"');
    expect(world.homes.placementRows.size).toBe(0);
    expect(world.homes.rows.get(`run_1 ${HOME}`)).toMatchObject({ onBehalfOfUserId: ALICE });
  });

  it("fences each write by the home's hold: a take makes the marker, later writes check it", async () => {
    const world = newWorld();
    succeeded(await world.put({ onBehalfOfUserId: ALICE, claude: "default" }));
    const generation = world.homes.rows.get(`run_1 ${HOME}`)?.generation ?? "";
    expect(generation).toMatch(/^[0-9a-f]{32}$/);
    // The take clears any login file it does not write (an earlier unconfirmed write's leftovers).
    expect(world.ran[0]?.script).toContain(`printf '%s' '${generation}' > "$m.tmp"`);
    expect(world.ran[0]?.script).toContain(`rm -f "$home/.codex/auth.json"`);
    expect(world.ran[0]?.script).toContain(`rm -f "$home/.config/gh/hosts.yml"`);

    succeeded(await world.put({ onBehalfOfUserId: ALICE, claude: "work" }));
    expect(world.ran[1]?.script).toContain(`!= '${generation}' ]`);
    expect(world.homes.rows.get(`run_1 ${HOME}`)?.generation).toBe(generation);
    // Every exec presents a fencing token issued under the lock, each above the last.
    const tokens = world.ran.map((entry) => Number(entry.script.match(/^token=(\d+)$/m)?.[1]));
    expect(tokens[1]).toBeGreaterThan(tokens[0] ?? Number.POSITIVE_INFINITY);
  });

  it("answers home-held when the home carries another hold's marker, recording nothing", async () => {
    const world = newWorld();
    world.exits.push(76);
    expect(failed(await world.put({ onBehalfOfUserId: ALICE, claude: "default" }))).toMatchObject({
      _tag: "WorkspaceConflictError",
      code: "home-held",
    });
    expect([...world.homes.placementRows.values()].some((row) => row.state === "ready")).toBe(
      false,
    );
  });

  it("makes a home that does not exist yet for the uid and gid it is given", async () => {
    const world = newWorld();
    succeeded(
      await world.put({ onBehalfOfUserId: ALICE, claude: "default", uid: 40001, gid: 40000 }),
    );
    expect(world.ran[0]?.script).toContain(`mkdir -m 700 "$home"`);
    expect(world.ran[0]?.script).toContain(`chown -h 40001:40000 "$home"`);
    expect(
      failed(await world.put({ onBehalfOfUserId: ALICE, claude: "default", uid: 40001 })),
    ).toMatchObject({ _tag: "WorkspaceBadRequestError" });
  });

  it("decrypts the account under the home's lock: a refresh that lands while the put waits is what it writes", async () => {
    const world = newWorld();
    const { promise: holding, resolve: release } = Promise.withResolvers<void>();
    // Another write holds the home's lock.
    const holder = Effect.runPromise(
      world.homes.service.withLockedHome({ runId: "run_1", home: HOME }, () =>
        Effect.promise(() => holding).pipe(
          Effect.as({ result: undefined, outcome: { kind: "keep" as const } }),
        ),
      ),
    );
    const put = world.put({ onBehalfOfUserId: ALICE, claude: "default" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Alice's Claude is refreshed meanwhile: the token the put would have decrypted is revoked.
    const index = world.currentAccounts.findIndex((candidate) => candidate.id === aliceClaude.id);
    const previous = world.currentAccounts[index];
    world.currentAccounts[index] = account({
      id: "cacc_alice_claude",
      encryptedPayload: `sealed:${JSON.stringify({ credentialsJson: claudeFile("at-alice-refreshed") })}`,
    });
    release();
    await holder;
    succeeded(await put);
    if (previous !== undefined) world.currentAccounts[index] = previous;
    expect(world.ran[0]?.payloads[0]).toContain("at-alice-refreshed");
  });

  it("answers home-busy, retryably, when the home stays locked or its lock times out", async () => {
    const world = newWorld();
    world.exits.push(78);
    expect(failed(await world.put({ onBehalfOfUserId: ALICE, claude: "default" }))).toMatchObject({
      _tag: "WorkspaceConflictError",
      code: "home-busy",
    });
  });

  it("refuses a caller that cannot act for both people", async () => {
    for (const principal of [{ kind: "gateway" }, { kind: "bearer" }] as const) {
      const world = newWorld();
      expect(
        failed(await world.put({ onBehalfOfUserId: ALICE, claude: "default" }, principal)),
      ).toMatchObject({ _tag: "WorkspaceForbiddenError" });
      expect(world.ran).toEqual([]);
    }
  });

  it("answers workspace-not-running for a stopped workspace", async () => {
    const world = newWorld(instanceRow("stopped"));
    expect(failed(await world.put({ onBehalfOfUserId: ALICE, claude: "default" }))).toMatchObject({
      _tag: "WorkspaceConflictError",
      code: "workspace-not-running",
    });
  });

  it("serialises two first puts into one home: the second finds the first's person", async () => {
    const world = newWorld();
    const [first, second] = await Promise.all([
      world.put({ onBehalfOfUserId: ALICE, claude: "default" }),
      world.put({ onBehalfOfUserId: BOB, claude: "default" }),
    ]);
    expect(Result.isSuccess(first)).toBe(true);
    expect(failed(second)).toMatchObject({ code: "home-held" });
    expect(world.ran.map(homeOf)).toEqual([HOME]);
  });
});

describe("releaseWorkspaceCredentials", () => {
  it("removes every login file and the record, and is idempotent", async () => {
    const world = newWorld();
    succeeded(await world.put({ onBehalfOfUserId: ALICE, claude: "default" }));

    expect(succeeded(await world.release())).toEqual({
      workspaceId: "wks_1",
      runId: "run_1",
      home: HOME,
      released: true,
    });
    const script = world.ran[1]?.script ?? "";
    for (const file of [".claude/.credentials.json", ".codex/auth.json", ".config/gh/hosts.yml"]) {
      expect(script).toContain(`rm -f "$home/${file}"`);
    }
    expect([...world.homes.placementRows.values()].some((row) => row.state === "ready")).toBe(
      false,
    );
    expect(succeeded(await world.release()).released).toBe(false);
  });

  it("keeps the home held when the removal is not confirmed", async () => {
    const world = newWorld();
    succeeded(await world.put({ onBehalfOfUserId: ALICE, claude: "default" }));
    world.exits.push(1);
    expect(failed(await world.release())).toMatchObject({ _tag: "WorkspaceBadGatewayError" });
    expect(world.homes.rows.size).toBe(1);
  });

  it("deletes only the record once the executor has stopped", async () => {
    const world = newWorld();
    succeeded(await world.put({ onBehalfOfUserId: ALICE, claude: "default" }));
    world.state.instance = instanceRow("stopped");
    expect(succeeded(await world.release()).released).toBe(true);
    expect(world.ran).toHaveLength(1);
  });
});

describe("listWorkspaceCredentials", () => {
  it("lists each home with its person and accounts", async () => {
    const world = newWorld();
    succeeded(await world.put({ onBehalfOfUserId: ALICE, claude: "default" }));
    succeeded(await world.put({ onBehalfOfUserId: BOB, home: CONV, claude: "default" }));
    expect(succeeded(await world.list()).homes).toMatchObject([
      {
        home: HOME,
        onBehalfOfUserId: ALICE,
        accounts: { claude: { connectedAccountId: aliceClaude.id, name: "default" } },
      },
      {
        home: CONV,
        onBehalfOfUserId: BOB,
        accounts: { claude: { connectedAccountId: bobClaude.id, name: "default" } },
      },
    ]);
  });
});

describe("withRunPermit", () => {
  it("bounds the writes of one workspace run, never another's", async () => {
    const hang = Effect.never;
    const held = [
      Effect.runFork(routes.withRunPermit("run_a", "/home/a", hang)),
      Effect.runFork(routes.withRunPermit("run_a", "/home/b", hang)),
    ];
    await new Promise((resolve) => setTimeout(resolve, 10));
    const third = await Effect.runPromise(
      Effect.result(routes.withRunPermit("run_a", "/home/c", Effect.succeed("ran"), "50 millis")),
    );
    expect(failed(third)).toMatchObject({ _tag: "WorkspaceConflictError", code: "home-busy" });
    const otherRun = await Effect.runPromise(
      routes.withRunPermit("run_b", "/home/a", Effect.succeed("ran"), "50 millis"),
    );
    expect(otherRun).toBe("ran");
    for (const fiber of held) await Effect.runPromise(Fiber.interrupt(fiber));
  });
});

describe("placement receipts", () => {
  it("writes ready bytes again, and pins a live provider slot across account and revision changes", async () => {
    const world = newWorld();
    const first = succeeded(await world.put({ onBehalfOfUserId: ALICE, claude: "default" })).home
      .placements?.[0];
    expect(first).toMatchObject({ accountId: aliceClaude.id, revision: 1, pinned: false });
    expect(
      succeeded(await world.put({ onBehalfOfUserId: ALICE, claude: "default" })).home
        .placements?.[0],
    ).toEqual(first);
    expect(world.ran).toHaveLength(2);
    expect(world.ran[1]?.payloads[0]).toContain("at-alice");
    const live = [first?.placementId ?? "missing"];
    expect(
      succeeded(await world.put({ onBehalfOfUserId: ALICE, claude: "work", live })).home
        .placements?.[0],
    ).toEqual({ ...first, pinned: true });
    const selected = world.currentAccounts.find((entry) => entry.id === aliceClaude.id);
    if (selected === undefined) throw new Error("missing fixture account");
    selected.credentialRevision = 2;
    expect(
      succeeded(await world.put({ onBehalfOfUserId: ALICE, claude: "default", live })).home
        .placements?.[0],
    ).toEqual({ ...first, pinned: true });
    expect(world.ran).toHaveLength(2);
    expect(succeeded(await world.list()).homes[0]?.placements?.[0]?.revision).toBe(1);
    expect(
      succeeded(await world.put({ onBehalfOfUserId: ALICE, claude: "default", live: [] })).home
        .placements?.[0],
    ).toMatchObject({ revision: 2, pinned: false });
    expect(world.ran).toHaveLength(3);
  });

  it("null and a partial missing selection cannot remove a live provider's file", async () => {
    const world = newWorld();
    const receipt = succeeded(await world.put({ onBehalfOfUserId: ALICE, claude: "default" })).home
      .placements?.[0];
    const live = [receipt?.placementId ?? "missing"];
    expect(
      succeeded(await world.put({ onBehalfOfUserId: ALICE, claude: null, live })).home
        .placements?.[0],
    ).toMatchObject({ pinned: true });
    succeeded(await world.put({ onBehalfOfUserId: ALICE, claude: "missing", partial: true, live }));
    for (const ran of world.ran.slice(1)) {
      expect(ran.script).not.toContain('rm -f "$home/.claude/.credentials.json"');
    }
    expect(succeeded(await world.list()).homes[0]?.placements).toHaveLength(1);
  });

  it("a receipt that is not ready in this home protects nothing and refuses nothing", async () => {
    const world = newWorld();
    expect(
      succeeded(
        await world.put({ onBehalfOfUserId: ALICE, claude: "default", live: ["cpl_elsewhere"] }),
      ).home.placements?.[0],
    ).toMatchObject({ accountId: aliceClaude.id, pinned: false });
    expect(world.ran).toHaveLength(1);
    succeeded(await world.prune(["cpl_elsewhere"]));
  });

  it("keeps the working login when a put is refused before anything was written", async () => {
    const world = newWorld();
    const working = succeeded(await world.put({ onBehalfOfUserId: ALICE, claude: "default" })).home
      .placements?.[0];
    world.exits.push(86);
    expect(failed(await world.put({ onBehalfOfUserId: ALICE, claude: "work" }))).toMatchObject({
      code: "home-unusable",
    });
    expect([...world.homes.placementRows.values()]).toEqual([
      expect.objectContaining({
        id: working?.placementId,
        accountId: aliceClaude.id,
        state: "ready",
      }),
    ]);
    expect(succeeded(await world.list()).homes[0]?.placements).toEqual([working]);
  });

  it("records no placement for a pi login the person's own login kept", async () => {
    const world = newWorld();
    world.exits.push(91);
    const answer = succeeded(
      await world.put({ onBehalfOfUserId: ALICE, pi: "chatgpt", opencode: "chatgpt" }),
    );
    expect(answer.home.placements?.map((entry) => entry.provider)).toEqual(["opencode"]);
    expect(answer.home.accounts).toEqual({
      opencode: { connectedAccountId: aliceChatGpt.id, name: "chatgpt" },
    });
  });

  it("answers each of two puts racing for one home with the receipt of its own selection", async () => {
    const world = newWorld();
    succeeded(await world.put({ onBehalfOfUserId: ALICE, claude: "default" }));
    world.afterRun.push(world.slowNextRead);
    const first = world.put({ onBehalfOfUserId: ALICE, claude: "work", live: [] });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = world.put({ onBehalfOfUserId: ALICE, claude: "default", live: [] });
    const answers = await Promise.all([first, second]);
    expect(answers.map((answer) => succeeded(answer).home.placements?.[0]?.accountId)).toEqual([
      aliceWork.id,
      aliceClaude.id,
    ]);
  });

  it("prune preserves defaults and live receipts, then removes a stopped process's nondefault", async () => {
    const world = newWorld();
    const placed = succeeded(
      await world.put({ onBehalfOfUserId: ALICE, claude: "work", github: "default" }),
    );
    const live =
      placed.home.placements
        ?.filter((entry) => entry.provider === "claude")
        .map((entry) => entry.placementId) ?? [];
    succeeded(await world.prune(live));
    expect(succeeded(await world.list()).homes[0]?.placements).toHaveLength(2);
    succeeded(await world.prune([]));
    expect(succeeded(await world.list()).homes[0]?.placements).toEqual([
      expect.objectContaining({ accountId: aliceGitHub.id }),
    ]);
    const count = world.ran.length;
    succeeded(await world.prune([]));
    expect(world.ran).toHaveLength(count);
  });

  it("answers no home when pruning one that holds nothing, naming nobody", async () => {
    const world = newWorld();
    expect(succeeded(await world.prune([]))).toEqual({ workspaceId: "wks_1", runId: "run_1" });
  });

  it("releases a first take a crash left unconfirmed, so another person can take the home", async () => {
    const world = newWorld();
    await Effect.runPromise(
      world.homes.placements.transact({ runId: "run_1", home: HOME }, [], () => ({
        result: undefined,
        placements: [],
        insertHome: { onBehalfOfUserId: ALICE, generation: "interrupted_take", releasing: true },
      })),
    );
    expect(failed(await world.put({ onBehalfOfUserId: ALICE, claude: "default" }))).toMatchObject({
      code: "home-busy",
    });
    succeeded(await world.sweep());
    expect(world.homes.rows.size).toBe(0);
    succeeded(await world.put({ onBehalfOfUserId: BOB, claude: "default" }));
    expect(succeeded(await world.list()).homes[0]?.onBehalfOfUserId).toBe(BOB);
  });

  it("the sweep retains failed removals and completes a release when the executor returns", async () => {
    const world = newWorld();
    succeeded(await world.put({ onBehalfOfUserId: ALICE, claude: "default" }));
    world.exits.push("throw");
    const failure = failed(await world.release());
    expect(failure.message).toContain("Core finishes the release once the executor answers");
    expect([...world.homes.placementRows.values()]).toEqual([
      expect.objectContaining({ state: "removing" }),
    ]);
    expect(world.homes.rows.get(`run_1 ${HOME}`)?.releasing).toBe(true);
    world.exits.push("throw");
    succeeded(await world.sweep());
    expect(world.homes.placementRows.size).toBe(1);
    succeeded(await world.sweep());
    expect(world.homes.placementRows.size).toBe(0);
    expect(world.homes.rows.size).toBe(0);
  });

  it("a release the home refuses leaves it held and usable", async () => {
    const world = newWorld();
    succeeded(await world.put({ onBehalfOfUserId: ALICE, claude: "default" }));
    world.exits.push(81);
    expect(failed(await world.release()).message).toContain("the home stays held");
    expect(world.homes.rows.get(`run_1 ${HOME}`)?.releasing).toBe(false);
    expect([...world.homes.placementRows.values()].map((row) => row.state)).toEqual(["ready"]);
    succeeded(await world.put({ onBehalfOfUserId: ALICE, claude: "work" }));
  });
});
