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
  WorkspaceCredentialHomeRepo,
  WorkspaceRepo,
  WorkspaceRuntimeInstanceRepo,
  type ConnectedAccount,
  type ConnectedAccountRepoService,
  type Workspace,
  type WorkspaceLaunchCredentialInjection,
  type WorkspaceRepoService,
  type WorkspaceRuntimeInstance,
  type WorkspaceRuntimeInstanceRepoService,
} from "@sealant/db";
import { makeInMemoryCredentialHomes } from "@sealant/db/testing/credential-homes";
import type { HomeCredentialChannel } from "@sealant/workspaces";
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
  aliceSetupToken,
  bobClaude,
];

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

interface Ran {
  readonly script: string;
  /** The decoded payloads, in order. */
  readonly payloads: readonly string[];
}

const homeOf = (entry: Ran) => entry.script.match(/home='([^']+)'/)?.[1];

const newWorld = (instance: WorkspaceRuntimeInstance = instanceRow()) => {
  const state = { instance };
  const homes = makeInMemoryCredentialHomes(() => [state.instance]);
  const ran: Ran[] = [];
  const exits: Array<number | "throw"> = [];
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
        return Effect.succeed({ exitCode: next });
      }),
  };
  const layer = Layer.mergeAll(
    Layer.succeed(CredentialCipher, fakeCipher),
    Layer.succeed(WorkspaceCredentialHomeRepo, homes.service),
    Layer.succeed(WorkspaceRepo, {
      getWorkspaceById: (id: string) => Effect.succeed(id === workspace.id ? workspace : undefined),
    } as unknown as WorkspaceRepoService),
    Layer.succeed(ConnectedAccountRepo, {
      getById: (id: string) => Effect.succeed(accounts.find((candidate) => candidate.id === id)),
      getByOwnerProviderName: (input: { ownerUserId: string; provider: string; name: string }) =>
        Effect.succeed(
          accounts.find(
            (candidate) =>
              candidate.ownerUserId === input.ownerUserId &&
              candidate.provider === input.provider &&
              candidate.name === input.name &&
              candidate.archivedAt === null,
          ),
        ),
    } as unknown as ConnectedAccountRepoService),
    Layer.succeed(WorkspaceRuntimeInstanceRepo, {
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

  return { state, homes, ran, exits, put, release, list };
};

const succeeded = <A, E>(result: Result.Result<A, E>): A => {
  if (Result.isFailure(result)) throw new Error(`refused: ${JSON.stringify(result.failure)}`);
  return result.success;
};

const failed = <A, E>(result: Result.Result<A, E>): E => {
  if (!Result.isFailure(result)) throw new Error("expected a refusal");
  return result.failure;
};

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

    expect(answer).toEqual({
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
    expect(world.homes.rows.get(`run_1 ${HOME}`)).toMatchObject({
      onBehalfOfUserId: ALICE,
      accounts: [{ provider: "claude", connectedAccountId: aliceClaude.id }],
    });
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
      expect(world.homes.rows.size).toBe(0);
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
    expect(world.homes.rows.size).toBe(0);
  });

  it("records nothing, and removes what it may have written, when a first write is unconfirmed", async () => {
    const world = newWorld();
    world.exits.push("throw");
    expect(failed(await world.put({ onBehalfOfUserId: ALICE, claude: "default" }))).toMatchObject({
      _tag: "WorkspaceBadGatewayError",
    });
    expect(world.homes.rows.size).toBe(0);
    expect(world.ran).toHaveLength(1);
    expect(world.ran[0]?.payloads).toEqual([]);
    expect(world.ran[0]?.script).toContain(`rm -f "$home/.claude/.credentials.json"`);
    expect(world.ran[0]?.script).toContain(`rm -f "$m"`);
  });

  it("keeps a held home's record when a later write is unconfirmed", async () => {
    const world = newWorld();
    succeeded(await world.put({ onBehalfOfUserId: ALICE, claude: "default" }));
    world.exits.push("throw");
    expect(failed(await world.put({ onBehalfOfUserId: ALICE, claude: "work" }))).toMatchObject({
      _tag: "WorkspaceBadGatewayError",
    });
    expect(world.homes.rows.get(`run_1 ${HOME}`)?.accounts).toEqual([
      { provider: "claude", connectedAccountId: aliceClaude.id },
    ]);
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
    expect(world.homes.rows.size).toBe(0);
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
    const index = accounts.findIndex((candidate) => candidate.id === aliceClaude.id);
    const previous = accounts[index];
    accounts[index] = account({
      id: "cacc_alice_claude",
      encryptedPayload: `sealed:${JSON.stringify({ credentialsJson: claudeFile("at-alice-refreshed") })}`,
    });
    release();
    await holder;
    succeeded(await put);
    if (previous !== undefined) accounts[index] = previous;
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
    expect(world.homes.rows.size).toBe(0);
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
    expect(succeeded(await world.list()).homes).toEqual([
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
