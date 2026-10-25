import { randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type {
  PutWorkspaceCredentialsRequest,
  WorkspaceCredentialPlacementReceipt,
} from "@sealant/api-contracts";
import { CredentialCipher, sha256Hex, type CredentialCipherService } from "@sealant/credentials";
import {
  ConnectedAccountRepo,
  ControlPlaneDataAccessLive,
  CredentialPlacementRepo,
  createSealantDB,
  SealantDB,
  user,
  workspaceAttempts,
  WorkspaceCredentialHomeRepo,
  WorkspaceRepo,
  WorkspaceRuntimeInstanceRepo,
  type DB,
} from "@sealant/db";
import { runMigrations } from "@sealant/db/migrate";
import {
  HOME_SCRIPT_EXIT,
  pushCredentialCopy,
  sweepCredentialPlacements,
  type HomeCredentialChannel,
} from "@sealant/workspaces";
import { Deferred, Effect, Fiber, Layer, Result } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let CurrentPrincipal: (typeof import("../../services/service-principals.js"))["CurrentPrincipal"];

process.env["SEALANT_CREDENTIALS_KEY"] = Buffer.alloc(32, 7).toString("base64");
const DATABASE_URL = process.env.SEALANT_TEST_DATABASE_URL;
const cipher: CredentialCipherService = {
  encrypt: (value) => Effect.succeed({ sealed: `sealed:${value}`, keyId: "fake" }),
  decrypt: (value) => Effect.succeed(value.slice(7)),
};
const payload = (label: string, expiresAt = Date.now() + 3_600_000) =>
  JSON.stringify({
    credentialsJson: JSON.stringify({
      claudeAiOauth: {
        accessToken: `fake-${label}`,
        refreshToken: `fake-refresh-${label}`,
        expiresAt,
      },
    }),
  });

const replace = (id: string, value: string) =>
  Effect.flatMap(ConnectedAccountRepo, (repo) =>
    repo.replacePayload({
      id,
      encryptedPayload: `sealed:${value}`,
      encryptionKeyId: "fake",
      payloadSha256: sha256Hex(value),
      metadata: {},
    }),
  );

const executor = () => {
  const files = new Map<string, string>();
  const writes: string[] = [];
  let fail = false;
  const channel: HomeCredentialChannel = {
    run: (_target, script, stdin) =>
      Effect.suspend(() => {
        if (fail) return Effect.fail(new Error("fake executor unavailable"));
        const home = script.match(/home='([^']+)'/)?.[1] ?? "";
        const paths = [...script.matchAll(/f="\$home\/([^"\n]+)"/g)].map(
          (match) => `${home}/${match[1]}`,
        );
        const contents =
          stdin.trim() === ""
            ? []
            : stdin
                .trim()
                .split("\n")
                .map((value) => Buffer.from(value, "base64").toString());
        const cleared = [...script.matchAll(/rm -rf "\$home\/([^"\n]+)"/g)].map(
          (match) => `${home}/${match[1]}/`,
        );
        for (const path of files.keys()) {
          if (cleared.some((dir) => path.startsWith(dir))) files.delete(path);
        }
        paths.forEach((path, i) => {
          files.set(path, contents[i] ?? "");
          writes.push(path);
        });
        for (const path of files.keys()) {
          if (
            path.startsWith(`${home}/`) &&
            script.includes(`rm -f "$home/${path.slice(home.length + 1)}"`)
          )
            files.delete(path);
        }
        return Effect.succeed({ exitCode: 0 });
      }),
  };
  return {
    files,
    writes,
    channel,
    fail: (value: boolean) => {
      fail = value;
    },
  };
};

const keyFiles = (ex: ReturnType<typeof executor>, home: string) =>
  [...ex.files.keys()].filter((path) => path.startsWith(`${home}/.sealant/keys/`));
const pathOf = (receipt: WorkspaceCredentialPlacementReceipt | undefined) =>
  receipt?.login.kind === "api-key" ? (receipt.login.keyPath ?? "") : "";

describe.skipIf(DATABASE_URL === undefined)("credential placements (Postgres)", () => {
  let db: DB;
  let routes: typeof import("./workspace-credentials.js");
  beforeAll(async () => {
    ({ CurrentPrincipal } = await import("../../services/service-principals.js"));
    routes = await import("./workspace-credentials.js");
    db = await createSealantDB(DATABASE_URL ?? "");
  });
  const layer = () =>
    ControlPlaneDataAccessLive.pipe(
      Layer.provideMerge(Layer.succeed(SealantDB, db)),
      Layer.provideMerge(Layer.succeed(CredentialCipher, cipher)),
      Layer.provideMerge(Layer.succeed(CurrentPrincipal, { kind: "service" })),
    );
  const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<ReturnType<typeof layer>>>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer())));
  const fixture = () =>
    run(
      Effect.gen(function* () {
        const owner = `user_placements_${randomUUID()}`;
        const runId = `run_placements_${randomUUID()}`;
        const workspaceId = `wks_placements_${randomUUID()}`;
        yield* db
          .insert(user)
          .values({ id: owner, name: "fake person", email: `${owner}@example.test` });
        yield* db.insert(workspaceAttempts).values({ id: runId, ownerUserId: owner });
        const workspaces = yield* WorkspaceRepo;
        yield* workspaces.createWorkspace({
          id: workspaceId,
          ownerUserId: owner,
          name: "placements",
        });
        yield* workspaces.linkWorkspaceAttempt({ workspaceId, attemptId: runId });
        yield* (yield* WorkspaceRuntimeInstanceRepo).upsertRuntimeInstance({
          runId,
          status: "ready",
          adapter: "docker",
          resourceId: `fake-${runId}`,
          reference: `fake-${runId}`,
          endpoint: `unix:///run/sealant/${runId}.sock`,
          launchCredentialInjections: [],
        });
        const accounts = yield* ConnectedAccountRepo;
        const create = (name: string) =>
          accounts.createConnectedAccount({
            id: `cacc_${randomUUID()}`,
            ownerUserId: owner,
            provider: "claude",
            name,
            kind: "credentials-json",
            encryptedPayload: `sealed:${payload(name)}`,
            encryptionKeyId: "fake",
            payloadSha256: sha256Hex(payload(name, 1)),
            metadata: {},
          });
        const first = yield* create("default");
        const second = yield* create("work");
        yield* accounts.setDefault({
          ownerUserId: owner,
          provider: "claude",
          connectedAccountId: first.id,
        });
        return {
          owner,
          runId,
          workspaceId,
          first,
          second,
          home: `/home/arena_${randomUUID().replaceAll("-", "")}`,
        };
      }),
    );
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  const put = (
    f: Fixture,
    channel: HomeCredentialChannel,
    extra: Partial<PutWorkspaceCredentialsRequest> = {},
  ) =>
    routes.putWorkspaceCredentials({
      workspaceId: f.workspaceId,
      homeChannel: channel,
      payload: {
        ownerUserId: f.owner,
        onBehalfOfUserId: f.owner,
        home: f.home,
        claude: f.first.id,
        ...extra,
      },
    });
  const CLAUDE_KEY = "sk-ant-api03-FAKE-claude-key-for-the-placement-tests-k1";
  const CLAUDE_KEY_2 = "sk-ant-api03-FAKE-claude-key-for-the-placement-tests-k2";
  const CODEX_KEY = "sk-proj-FAKE-codex-key-for-the-placement-tests-cx";
  const keyAccount = (f: Fixture, provider: "claude" | "codex", name: string, apiKey: string) =>
    run(
      Effect.flatMap(ConnectedAccountRepo, (repo) =>
        repo.createConnectedAccount({
          id: `cacc_${randomUUID()}`,
          ownerUserId: f.owner,
          provider,
          name,
          kind: "api-key",
          encryptedPayload: `sealed:${JSON.stringify({ apiKey })}`,
          encryptionKeyId: "fake",
          payloadSha256: sha256Hex(apiKey),
          metadata: { tokenSuffix: apiKey.slice(-4) },
        }),
      ),
    );
  const rows = (f: Fixture) =>
    run(
      Effect.flatMap(CredentialPlacementRepo, (repo) =>
        Effect.map(repo.state(f), (state) => state.placements),
      ),
    );

  it("reuses a ready revision, pins a different live selection, then switches after it stops", async () => {
    const f = await fixture();
    const ex = executor();
    const placed = (await run(put(f, ex.channel))).home.placements?.[0];
    expect(placed).toMatchObject({
      accountId: f.first.id,
      revision: 1,
      login: { kind: "subscription" },
      pinned: false,
    });
    const reused = (await run(put(f, ex.channel))).home.placements?.[0];
    expect(reused).toEqual(placed);
    expect(ex.writes).toHaveLength(2);
    const live = [placed?.placementId ?? "missing"];
    expect(
      (await run(put(f, ex.channel, { claude: f.second.id, live }))).home.placements?.[0],
    ).toEqual({ ...placed, pinned: true });
    expect(ex.writes).toHaveLength(2);
    const next = (await run(put(f, ex.channel, { claude: f.second.id, live: [] }))).home
      .placements?.[0];
    expect(next?.accountId).toBe(f.second.id);
    expect(next?.placementId).not.toBe(placed?.placementId);
    await run(sweepCredentialPlacements({ homeChannel: ex.channel }));
    expect(ex.files.get(`${f.home}/.claude/.credentials.json`)).toContain("fake-work");
    expect(await rows(f)).toHaveLength(1);
  });

  it("archive sees a committed pending put; the late file is removed and never becomes ready", async () => {
    const f = await fixture();
    const ex = executor();
    await run(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const finish = yield* Deferred.make<void>();
        const channel: HomeCredentialChannel = {
          run: (target, script, stdin) =>
            stdin === ""
              ? ex.channel.run(target, script, stdin)
              : Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(finish)),
                  Effect.andThen(ex.channel.run(target, script, stdin)),
                ),
        };
        const writing = yield* put(f, channel).pipe(Effect.result, Effect.forkChild);
        yield* Deferred.await(entered);
        const repo = yield* CredentialPlacementRepo;
        const list = repo.state(f).pipe(Effect.map((state) => state.placements));
        expect(yield* list).toEqual([expect.objectContaining({ state: "pending" })]);
        yield* (yield* ConnectedAccountRepo).archiveAndClearDefault({
          id: f.first.id,
          ownerUserId: f.owner,
        });
        expect(yield* list).toEqual([expect.objectContaining({ state: "removing" })]);
        const sweep = yield* sweepCredentialPlacements({ homeChannel: ex.channel }).pipe(
          Effect.forkChild,
        );
        yield* Deferred.succeed(finish, undefined);
        expect(Result.isFailure(yield* Fiber.join(writing))).toBe(true);
        yield* Fiber.join(sweep);
        expect(ex.files.has(`${f.home}/.claude/.credentials.json`)).toBe(false);
        expect(yield* list).toEqual([]);
      }),
    );
  });

  it("release commits removal work even when the executor fails, and the sweep retries", async () => {
    const f = await fixture();
    const ex = executor();
    await run(put(f, ex.channel));
    ex.fail(true);
    expect(
      Result.isFailure(
        await run(
          routes
            .releaseWorkspaceCredentials({
              workspaceId: f.workspaceId,
              query: { ownerUserId: f.owner, home: f.home },
              homeChannel: ex.channel,
            })
            .pipe(Effect.result),
        ),
      ),
    ).toBe(true);
    expect(await rows(f)).toEqual([expect.objectContaining({ state: "removing" })]);
    await run(sweepCredentialPlacements({ homeChannel: ex.channel }));
    expect(await rows(f)).toHaveLength(1);
    ex.fail(false);
    await run(sweepCredentialPlacements({ homeChannel: ex.channel }));
    expect(await rows(f)).toEqual([]);
    expect(ex.files.size).toBe(0);
    expect(
      await run(Effect.flatMap(WorkspaceCredentialHomeRepo, (repo) => repo.listByRunId(f.runId))),
    ).toEqual([]);
    expect(
      (
        await run(
          routes.releaseWorkspaceCredentials({
            workspaceId: f.workspaceId,
            query: { ownerUserId: f.owner, home: f.home },
            homeChannel: ex.channel,
          }),
        )
      ).released,
    ).toBe(false);
  });

  it("prune retains live and default ready placements, and is idempotent", async () => {
    const f = await fixture();
    const ex = executor();
    const extra = await run(
      Effect.gen(function* () {
        const repo = yield* ConnectedAccountRepo;
        const codex = yield* repo.createConnectedAccount({
          id: `cacc_${randomUUID()}`,
          ownerUserId: f.owner,
          provider: "codex",
          name: "work",
          kind: "auth-json",
          encryptedPayload: `sealed:${JSON.stringify({ authJson: JSON.stringify({ tokens: { access_token: "fake-codex", refresh_token: "fake-refresh" } }) })}`,
          encryptionKeyId: "fake",
          payloadSha256: "fake",
          metadata: {},
        });
        const github = yield* repo.createConnectedAccount({
          id: `cacc_${randomUUID()}`,
          ownerUserId: f.owner,
          provider: "github",
          name: "work",
          kind: "gh-cli-token",
          encryptedPayload: `sealed:${JSON.stringify({ token: "fake-github" })}`,
          encryptionKeyId: "fake",
          payloadSha256: "fake",
          metadata: {},
        });
        return { codex, github };
      }),
    );
    const placed = await run(
      put(f, ex.channel, { codex: extra.codex.id, github: extra.github.id }),
    );
    const live =
      placed.home.placements
        ?.filter((row) => row.provider === "codex")
        .map((row) => row.placementId) ?? [];
    expect(live).toHaveLength(1);
    const prune = (kept: readonly string[]) =>
      routes.pruneWorkspaceCredentials({
        workspaceId: f.workspaceId,
        payload: { ownerUserId: f.owner, home: f.home, live: kept },
        homeChannel: ex.channel,
      });
    for (let i = 0; i < 2; i++) await run(prune(live));
    expect((await rows(f)).map((row) => row.accountId).toSorted()).toEqual(
      [f.first.id, extra.codex.id].toSorted(),
    );
    expect(ex.files.has(`${f.home}/.config/gh/hosts.yml`)).toBe(false);
    await run(prune([]));
    expect(await rows(f)).toEqual([
      expect.objectContaining({ accountId: f.first.id, state: "ready" }),
    ]);
    expect(ex.files.has(`${f.home}/.codex/auth.json`)).toBe(false);
    expect(ex.files.has(`${f.home}/.claude/.credentials.json`)).toBe(true);
  });

  it("pushes a refresh to every ready placement and carries its new revision", async () => {
    const f = await fixture();
    const ex = executor();
    await run(put(f, ex.channel));
    await run(put(f, ex.channel, { home: `${f.home}_other` }));
    const fresh = payload("refreshed");
    await run(replace(f.first.id, fresh));
    const summary = await run(
      pushCredentialCopy({
        connectedAccountId: f.first.id,
        provider: "claude",
        copyJson: "stale",
        credentialCipher: cipher,
        homeChannel: ex.channel,
      }),
    );
    expect(summary).toMatchObject({ written: 2, failed: 0 });
    expect(ex.files.get(`${f.home}/.claude/.credentials.json`)).toContain("fake-refreshed");
    expect(ex.files.get(`${f.home}_other/.claude/.credentials.json`)).toContain("fake-refreshed");
    expect(await rows(f)).toEqual([expect.objectContaining({ revision: 2 })]);
  });

  it("a receipt archive or prune retired protects nothing and refuses nothing", async () => {
    const f = await fixture();
    const ex = executor();
    const work = (await run(put(f, ex.channel, { claude: f.second.id }))).home.placements?.[0];
    await run(
      Effect.flatMap(ConnectedAccountRepo, (repo) =>
        repo.archiveAndClearDefault({ id: f.second.id, ownerUserId: f.owner }),
      ),
    );
    const live = [work?.placementId ?? "missing"];
    const placed = (await run(put(f, ex.channel, { live }))).home.placements?.[0];
    expect(placed).toMatchObject({ accountId: f.first.id, pinned: false });
    expect(ex.files.get(`${f.home}/.claude/.credentials.json`)).toContain("fake-default");
    await run(
      routes.pruneWorkspaceCredentials({
        workspaceId: f.workspaceId,
        payload: { ownerUserId: f.owner, home: f.home, live },
        homeChannel: ex.channel,
      }),
    );
    expect(await rows(f)).toEqual([
      expect.objectContaining({ id: placed?.placementId, state: "ready" }),
    ]);
  });

  it("writes the stored bytes again when a refresh moves the account during the write", async () => {
    const f = await fixture();
    const ex = executor();
    const fresh = payload("refreshed");
    let held = true;
    const channel: HomeCredentialChannel = {
      run: (target, script, stdin) =>
        Effect.gen(function* () {
          if (stdin !== "" && held) {
            held = false;
            yield* Effect.promise(() => run(replace(f.first.id, fresh)));
          }
          return yield* ex.channel.run(target, script, stdin);
        }),
    };
    const placed = (await run(put(f, channel))).home.placements?.[0];
    expect(placed).toMatchObject({ accountId: f.first.id, revision: 2, pinned: false });
    expect(ex.files.get(`${f.home}/.claude/.credentials.json`)).toContain("fake-refreshed");
    expect(await rows(f)).toEqual([
      expect.objectContaining({ id: placed?.placementId, revision: 2, state: "ready" }),
    ]);
  });

  it("a put the home refuses keeps the working login, its file and its ready placement", async () => {
    const f = await fixture();
    const ex = executor();
    const working = (await run(put(f, ex.channel))).home.placements?.[0];
    const refusing: HomeCredentialChannel = {
      run: () => Effect.succeed({ exitCode: HOME_SCRIPT_EXIT.claudeLoginUnusable }),
    };
    expect(
      Result.isFailure(await run(put(f, refusing, { claude: f.second.id }).pipe(Effect.result))),
    ).toBe(true);
    expect(ex.files.get(`${f.home}/.claude/.credentials.json`)).toContain("fake-default");
    expect(await rows(f)).toEqual([
      expect.objectContaining({ id: working?.placementId, accountId: f.first.id, state: "ready" }),
    ]);
  });

  it("a put writes a deleted login file again unless a live placement of another login holds it", async () => {
    const f = await fixture();
    const ex = executor();
    const placed = (await run(put(f, ex.channel))).home.placements?.[0];
    const file = `${f.home}/.claude/.credentials.json`;
    ex.files.delete(file);
    const live = [placed?.placementId ?? "missing"];
    expect((await run(put(f, ex.channel, { live }))).home.placements?.[0]).toEqual(placed);
    expect(ex.files.get(file)).toContain("fake-default");
    ex.files.delete(file);
    await run(put(f, ex.channel, { claude: f.second.id, live }));
    expect(ex.files.has(file)).toBe(false);
  });

  it("a partial put whose other login file is refused leaves a live login in place", async () => {
    const f = await fixture();
    const ex = executor();
    const live = [(await run(put(f, ex.channel))).home.placements?.[0]?.placementId ?? "missing"];
    const github = await run(
      Effect.gen(function* () {
        const repo = yield* ConnectedAccountRepo;
        yield* repo.markInvalid({ id: f.first.id });
        return yield* repo.createConnectedAccount({
          id: `cacc_${randomUUID()}`,
          ownerUserId: f.owner,
          provider: "github",
          name: "work",
          kind: "gh-cli-token",
          encryptedPayload: `sealed:${JSON.stringify({ token: "fake-github" })}`,
          encryptionKeyId: "fake",
          payloadSha256: "fake",
          metadata: {},
        });
      }),
    );
    const refusing: HomeCredentialChannel = {
      run: (target, script, stdin) =>
        script.includes(".config/gh/hosts.yml") && stdin !== ""
          ? Effect.succeed({ exitCode: HOME_SCRIPT_EXIT.githubLoginUnusable })
          : ex.channel.run(target, script, stdin),
    };
    const answer = await run(put(f, refusing, { github: github.id, partial: true, live }));
    expect(answer.skipped?.map((skip) => skip.provider).toSorted()).toEqual(["claude", "github"]);
    expect(answer.home.placements).toEqual([
      expect.objectContaining({ placementId: live[0], pinned: true }),
    ]);
    expect(ex.files.get(`${f.home}/.claude/.credentials.json`)).toContain("fake-default");
  });

  it("puts a Claude key into a file of its own; a subscription put adds its own file and another key coexists", async () => {
    const f = await fixture();
    const ex = executor();
    const key = await keyAccount(f, "claude", "key", CLAUDE_KEY);
    const first = (await run(put(f, ex.channel, { claude: key.id }))).home.placements ?? [];
    expect(first).toEqual([
      {
        provider: "claude",
        placementId: expect.any(String),
        accountId: key.id,
        revision: 1,
        login: {
          kind: "api-key",
          suffix: CLAUDE_KEY.slice(-4),
          keyPath: `${f.home}/.sealant/keys/${first[0]?.placementId ?? ""}`,
        },
        pinned: false,
      },
    ]);
    const keyPath = `${f.home}/.sealant/keys/${first[0]?.placementId ?? ""}`;
    expect(ex.files.get(keyPath)).toBe(CLAUDE_KEY);
    expect(ex.files.has(`${f.home}/.claude/.credentials.json`)).toBe(false);

    const live = first.map((row) => row.placementId);
    await run(put(f, ex.channel, { live }));
    expect(ex.files.get(`${f.home}/.claude/.credentials.json`)).toContain("fake-default");
    expect(ex.files.get(keyPath)).toBe(CLAUDE_KEY);

    const second = await keyAccount(f, "claude", "key-2", CLAUDE_KEY_2);
    const after = (await run(put(f, ex.channel, { claude: second.id, live }))).home.placements;
    expect(after?.map((row) => [row.accountId, row.login.kind, row.pinned])).toEqual([
      [key.id, "api-key", false],
      [f.first.id, "subscription", false],
      [second.id, "api-key", false],
    ]);
    expect(
      keyFiles(ex, f.home)
        .map((path) => ex.files.get(path))
        .toSorted(),
    ).toEqual([CLAUDE_KEY, CLAUDE_KEY_2].toSorted());
    expect((await run(put(f, ex.channel, { claude: key.id, live }))).home.placements).toEqual(
      after,
    );
  });

  it("a repeat put of a live key left in doubt never removes that key", async () => {
    const f = await fixture();
    const ex = executor();
    const key = await keyAccount(f, "claude", "key", CLAUDE_KEY);
    const placed = (await run(put(f, ex.channel, { claude: key.id }))).home.placements?.[0];
    const live = [placed?.placementId ?? "missing"];
    ex.fail(true);
    expect(
      Result.isFailure(await run(put(f, ex.channel, { claude: key.id, live }).pipe(Effect.result))),
    ).toBe(true);
    ex.fail(false);
    const ready = [expect.objectContaining({ id: placed?.placementId, state: "ready" })];
    expect(await rows(f)).toEqual(ready);
    await run(sweepCredentialPlacements({ homeChannel: ex.channel }));
    expect(ex.files.get(pathOf(placed))).toBe(CLAUDE_KEY);
    expect((await run(put(f, ex.channel, { claude: key.id, live }))).home.placements).toEqual([
      placed,
    ]);
    expect(await rows(f)).toEqual(ready);
    expect(keyFiles(ex, f.home)).toEqual([pathOf(placed)]);
  });

  it("prune removes only a key file nothing live holds; archive leaves a key for the sweep; release removes every one", async () => {
    const f = await fixture();
    const ex = executor();
    const first = await keyAccount(f, "claude", "key", CLAUDE_KEY);
    const second = await keyAccount(f, "claude", "key-2", CLAUDE_KEY_2);
    const placed = async (account: { readonly id: string }) =>
      (await run(put(f, ex.channel, { claude: account.id }))).home.placements?.find(
        (row) => row.accountId === account.id,
      );
    const one = await placed(first);
    const two = await placed(second);
    await run(put(f, ex.channel));
    await run(
      routes.pruneWorkspaceCredentials({
        workspaceId: f.workspaceId,
        payload: { ownerUserId: f.owner, home: f.home, live: [two?.placementId ?? "missing"] },
        homeChannel: ex.channel,
      }),
    );
    expect(ex.files.has(pathOf(one))).toBe(false);
    expect(ex.files.get(pathOf(two))).toBe(CLAUDE_KEY_2);
    expect(ex.files.get(`${f.home}/.claude/.credentials.json`)).toContain("fake-default");

    await run(
      Effect.flatMap(ConnectedAccountRepo, (repo) =>
        repo.archiveAndClearDefault({ id: second.id, ownerUserId: f.owner }),
      ),
    );
    expect((await rows(f)).find((row) => row.id === two?.placementId)?.state).toBe("removing");
    expect(ex.files.get(pathOf(two))).toBe(CLAUDE_KEY_2);
    await run(sweepCredentialPlacements({ homeChannel: ex.channel }));
    expect(ex.files.has(pathOf(two))).toBe(false);
    expect((await rows(f)).map((row) => row.accountId)).toEqual([f.first.id]);

    const again = await placed(first);
    expect(ex.files.get(pathOf(again))).toBe(CLAUDE_KEY);
    await run(
      routes.releaseWorkspaceCredentials({
        workspaceId: f.workspaceId,
        query: { ownerUserId: f.owner, home: f.home },
        homeChannel: ex.channel,
      }),
    );
    expect(ex.files.size).toBe(0);
    expect(await rows(f)).toEqual([]);
  });

  it("a Codex key's placement reads api-key, and the refresh push leaves key placements alone", async () => {
    const f = await fixture();
    const ex = executor();
    const codex = await keyAccount(f, "codex", "key", CODEX_KEY);
    const claude = await keyAccount(f, "claude", "key", CLAUDE_KEY);
    const placed = (await run(put(f, ex.channel, { claude: claude.id, codex: codex.id }))).home
      .placements;
    expect(placed?.map((row) => [row.provider, row.login]).toSorted()).toEqual([
      ["claude", expect.objectContaining({ kind: "api-key", suffix: CLAUDE_KEY.slice(-4) })],
      ["codex", { kind: "api-key", suffix: CODEX_KEY.slice(-4) }],
    ]);
    const before = new Map(ex.files);
    await run(replace(claude.id, payload("now-a-subscription")));
    await run(
      replace(
        codex.id,
        JSON.stringify({
          authJson: JSON.stringify({
            tokens: { access_token: "fake-codex", refresh_token: "fake-refresh" },
          }),
        }),
      ),
    );
    for (const [provider, account] of [
      ["claude", claude],
      ["codex", codex],
    ] as const) {
      const summary = await run(
        pushCredentialCopy({
          connectedAccountId: account.id,
          provider,
          copyJson: "stale",
          credentialCipher: cipher,
          homeChannel: ex.channel,
        }),
      );
      expect(summary).toMatchObject({ written: 0, failed: 0 });
    }
    expect(ex.files).toEqual(before);
    expect(
      (await rows(f)).map((row) => [row.provider, row.revision, row.login.kind]).toSorted(),
    ).toEqual([
      ["claude", 1, "api-key"],
      ["codex", 1, "api-key"],
    ]);
  });
});

const migrationsFolder = join(
  dirname(createRequire(import.meta.url).resolve("@sealant/db/migrate")),
  "..",
  "drizzle",
);
const PLACEMENTS_MIGRATION = readdirSync(migrationsFolder).find((entry) =>
  entry.endsWith("_credential_placements"),
);

const placement = (
  runId: string,
  home: string,
  provider: string,
  accountId: string,
  revision: number,
  file: string,
  state: string,
) => ({
  run_id: runId,
  home,
  provider,
  account_id: accountId,
  revision,
  path: `${home}/${file}`,
  state,
});

const migrationsWhere = (keep: (name: string) => boolean) => {
  const folder = mkdtempSync(join(tmpdir(), "sealant-migrations-"));
  for (const entry of readdirSync(migrationsFolder).filter(keep)) {
    cpSync(join(migrationsFolder, entry), join(folder, entry), { recursive: true });
  }
  return folder;
};

describe.skipIf(DATABASE_URL === undefined)("the placements migration (Postgres)", () => {
  const databaseName = `sealant_placements_${randomUUID().replaceAll("-", "")}`;
  const admin = new URL(DATABASE_URL ?? "postgresql://unused");
  const fresh = new URL(admin);
  fresh.pathname = `/${databaseName}`;
  let adminDb: DB;
  let db: DB;

  beforeAll(async () => {
    adminDb = await createSealantDB(admin.toString());
    await Effect.runPromise(adminDb.execute(`CREATE DATABASE "${databaseName}"`));
    const earlier = migrationsWhere((entry) => entry < (PLACEMENTS_MIGRATION ?? ""));
    await runMigrations({
      databaseUrl: fresh.toString(),
      migrationsFolder: earlier,
      log: () => {},
    });
    rmSync(earlier, { recursive: true, force: true });
    db = await createSealantDB(fresh.toString());
  }, 120_000);

  afterAll(async () => {
    await Effect.runPromise(
      adminDb.execute(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`),
    );
  });

  it("records every login an existing home holds, and leaves gone accounts' for removal", async () => {
    const statements = [
      `insert into "user" (id, name, email, email_verified, created_at, updated_at)
         values ('alice', 'alice', 'alice@example.test', false, now(), now())`,
      `insert into connected_accounts (id, owner_user_id, provider, name, kind, status,
         encrypted_payload, encryption_key_id, payload_sha256, metadata, credential_revision,
         archived_at, created_at, updated_at)
       values ('cacc_claude', 'alice', 'claude', 'default', 'credentials-json', 'active', 'sealed',
         'k', 'sha', '{}'::jsonb, 4, null, now(), now()),
         ('cacc_codex', 'alice', 'codex', 'default', 'auth-json', 'active', 'sealed', 'k', 'sha',
         '{}'::jsonb, 1, null, now(), now()),
         ('cacc_archived', 'alice', 'codex', 'old', 'auth-json', 'archived', 'sealed', 'k', 'sha',
         '{}'::jsonb, 2, now(), now(), now())`,
      `insert into workspace_attempts (id, owner_user_id, queued_at, created_at, updated_at)
         values ('run_old', 'alice', now(), now(), now())`,
      `insert into workspace_runtime_instances (run_id, status, launch_credential_injections,
         created_at, updated_at)
       values ('run_old', 'ready', null, now(), now())`,
      `insert into workspace_credential_homes (run_id, home, on_behalf_of_user_id, generation,
         accounts, created_at, updated_at)
       values ('run_old', '/home/m4lice000', 'alice', 'gen-a',
         '[{"provider":"claude","connectedAccountId":"cacc_claude"},
           {"provider":"codex","connectedAccountId":"cacc_codex"},
           {"provider":"pi","connectedAccountId":"cacc_codex"}]'::jsonb, now(), now()),
         ('run_old', '/run/mend/conv/ses_1', 'alice', 'gen-b',
         '[{"provider":"claude","connectedAccountId":"cacc_gone"},
           {"provider":"codex","connectedAccountId":"cacc_archived"}]'::jsonb, now(), now())`,
    ];
    for (const statement of statements) await Effect.runPromise(db.execute(statement));

    const through = migrationsWhere((entry) => entry <= (PLACEMENTS_MIGRATION ?? ""));
    const { applied } = await runMigrations({
      databaseUrl: fresh.toString(),
      migrationsFolder: through,
      log: () => {},
    });
    rmSync(through, { recursive: true, force: true });
    expect(applied).toEqual([PLACEMENTS_MIGRATION]);

    const placements = await Effect.runPromise(
      db.execute<{
        readonly run_id: string;
        readonly home: string;
        readonly provider: string;
        readonly account_id: string;
        readonly revision: number;
        readonly path: string;
        readonly state: string;
      }>(
        `select run_id, home, provider, account_id, revision, path, state
           from workspace_credential_placements order by run_id, home, provider`,
        "objects",
      ),
    );
    expect(placements.map((row) => ({ ...row }))).toEqual([
      placement(
        "run_old",
        "/home/m4lice000",
        "claude",
        "cacc_claude",
        4,
        ".claude/.credentials.json",
        "ready",
      ),
      placement(
        "run_old",
        "/home/m4lice000",
        "codex",
        "cacc_codex",
        1,
        ".codex/auth.json",
        "ready",
      ),
      placement(
        "run_old",
        "/home/m4lice000",
        "pi",
        "cacc_codex",
        1,
        ".pi/agent/auth.json",
        "ready",
      ),
      placement(
        "run_old",
        "/run/mend/conv/ses_1",
        "claude",
        "cacc_gone",
        1,
        ".claude/.credentials.json",
        "removing",
      ),
      placement(
        "run_old",
        "/run/mend/conv/ses_1",
        "codex",
        "cacc_archived",
        2,
        ".codex/auth.json",
        "removing",
      ),
    ]);
    const homes = await Effect.runPromise(
      db.execute<{ readonly run_id: string; readonly home: string; readonly generation: string }>(
        `select run_id, home, generation from workspace_credential_homes order by run_id, home`,
        "objects",
      ),
    );
    expect(homes.map((row) => ({ ...row }))).toEqual([
      { run_id: "run_old", home: "/home/m4lice000", generation: "gen-a" },
      { run_id: "run_old", home: "/run/mend/conv/ses_1", generation: "gen-b" },
    ]);
    const columns = await Effect.runPromise(
      db.execute<{ readonly column_name: string }>(
        `select column_name from information_schema.columns
           where table_name = 'workspace_credential_homes' and column_name = 'accounts'`,
        "objects",
      ),
    );
    expect(columns).toEqual([]);
  });
});

describe.skipIf(DATABASE_URL === undefined)("the placement logins migration (Postgres)", () => {
  const databaseName = `sealant_placement_logins_${randomUUID().replaceAll("-", "")}`;
  const admin = new URL(DATABASE_URL ?? "postgresql://unused");
  const fresh = new URL(admin);
  fresh.pathname = `/${databaseName}`;
  let adminDb: DB;
  let db: DB;

  beforeAll(async () => {
    adminDb = await createSealantDB(admin.toString());
    await Effect.runPromise(adminDb.execute(`CREATE DATABASE "${databaseName}"`));
    const earlier = migrationsWhere((entry) => entry < (LOGINS_MIGRATION ?? ""));
    await runMigrations({
      databaseUrl: fresh.toString(),
      migrationsFolder: earlier,
      log: () => {},
    });
    rmSync(earlier, { recursive: true, force: true });
    db = await createSealantDB(fresh.toString());
  }, 120_000);

  afterAll(async () => {
    await Effect.runPromise(
      adminDb.execute(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`),
    );
  });

  it("records a Codex placement of a key account at its revision as that key, and nothing else", async () => {
    const statements = [
      `insert into "user" (id, name, email, email_verified, created_at, updated_at)
         values ('alice', 'alice', 'alice@example.test', false, now(), now())`,
      `insert into connected_accounts (id, owner_user_id, provider, name, kind, status,
         encrypted_payload, encryption_key_id, payload_sha256, metadata, credential_revision,
         created_at, updated_at)
       values ('cacc_key', 'alice', 'codex', 'key', 'api-key', 'active', 'sealed', 'k', 'sha',
         '{"tokenSuffix":"wxyz"}'::jsonb, 3, now(), now()),
         ('cacc_sub', 'alice', 'codex', 'default', 'auth-json', 'active', 'sealed', 'k', 'sha',
         '{}'::jsonb, 1, now(), now())`,
      `insert into workspace_attempts (id, owner_user_id, queued_at, created_at, updated_at)
         values ('run_old', 'alice', now(), now(), now())`,
      `insert into workspace_runtime_instances (run_id, status, created_at, updated_at)
         values ('run_old', 'ready', now(), now())`,
      `insert into workspace_credential_homes (run_id, home, on_behalf_of_user_id, generation,
         created_at, updated_at)
       values ('run_old', '/home/a', 'alice', 'gen-a', now(), now()),
         ('run_old', '/home/b', 'alice', 'gen-b', now(), now()),
         ('run_old', '/home/c', 'alice', 'gen-c', now(), now())`,
      `insert into workspace_credential_placements (id, run_id, home, provider, account_id,
         revision, path, login, state, created_at)
       values ('cpl_key', 'run_old', '/home/a', 'codex', 'cacc_key', 3, '/home/a/.codex/auth.json',
         '{"kind":"subscription"}'::jsonb, 'ready', now()),
         ('cpl_older', 'run_old', '/home/b', 'codex', 'cacc_key', 2, '/home/b/.codex/auth.json',
         '{"kind":"subscription"}'::jsonb, 'ready', now()),
         ('cpl_sub', 'run_old', '/home/c', 'codex', 'cacc_sub', 1, '/home/c/.codex/auth.json',
         '{"kind":"subscription"}'::jsonb, 'ready', now())`,
    ];
    for (const statement of statements) await Effect.runPromise(db.execute(statement));

    const through = migrationsWhere((entry) => entry <= (LOGINS_MIGRATION ?? ""));
    const { applied } = await runMigrations({
      databaseUrl: fresh.toString(),
      migrationsFolder: through,
      log: () => {},
    });
    rmSync(through, { recursive: true, force: true });
    expect(applied).toEqual([LOGINS_MIGRATION]);
    const logins = await Effect.runPromise(
      db.execute<{ readonly id: string; readonly login: unknown }>(
        `select id, login from workspace_credential_placements order by id`,
        "objects",
      ),
    );
    expect(logins.map((row) => ({ ...row }))).toEqual([
      { id: "cpl_key", login: { kind: "api-key", suffix: "wxyz" } },
      { id: "cpl_older", login: { kind: "subscription" } },
      { id: "cpl_sub", login: { kind: "subscription" } },
    ]);
  });
});

const LOGINS_MIGRATION = readdirSync(migrationsFolder).find((entry) =>
  entry.endsWith("_placement_logins"),
);
