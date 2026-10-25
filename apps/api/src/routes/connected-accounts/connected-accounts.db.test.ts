import { randomUUID } from "node:crypto";

import { CredentialCipher, type CredentialCipherService } from "@sealant/credentials";
import {
  ConnectedAccountRepo,
  ConnectedAccountRepoLive,
  createSealantDB,
  DatabaseTransactionLive,
  ProfileRepoLive,
  schema,
  SealantDB,
  user,
  type DB,
} from "@sealant/db";
import { Effect, Layer } from "effect";
import { beforeAll, describe, expect, it } from "vitest";

import { resolveSelectedConnectedAccount } from "../workspaces/connected-account-selection.js";

process.env["SEALANT_CREDENTIALS_KEY"] = Buffer.alloc(32, 7).toString("base64");

const DATABASE_URL = process.env.SEALANT_TEST_DATABASE_URL;

let accounts: typeof import("./connected-accounts.module.js");
let profileModule: typeof import("../profiles/profiles.module.js");

const fakeCipher: CredentialCipherService = {
  encrypt: (plaintext) => Effect.succeed({ sealed: `sealed:${plaintext}`, keyId: "k-test" }),
  decrypt: (sealed) => Effect.succeed(sealed.slice("sealed:".length)),
};

const resolveDefault = (ownerUserId: string) =>
  resolveSelectedConnectedAccount({ ownerUserId, provider: "claude", selection: "default" });

const token = (label: string) => `sk-ant-oat01-fake-${label}`;

describe.skipIf(DATABASE_URL === undefined)("a person's default login (Postgres)", () => {
  let db: DB;

  beforeAll(async () => {
    accounts = await import("./connected-accounts.module.js");
    profileModule = await import("../profiles/profiles.module.js");
    db = await createSealantDB(DATABASE_URL ?? "");
  });

  const person = async () => {
    const id = `user_default_${randomUUID()}`;
    await Effect.runPromise(
      db.insert(user).values({ id, name: "person", email: `${id}@example.test` }),
    );
    return id;
  };

  const layer = () =>
    Layer.mergeAll(ConnectedAccountRepoLive, ProfileRepoLive, DatabaseTransactionLive).pipe(
      Layer.provideMerge(Layer.succeed(SealantDB, db)),
      Layer.provideMerge(Layer.succeed(CredentialCipher, fakeCipher)),
    );

  const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<ReturnType<typeof layer>>>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer())));
  const refusal = <A, E>(effect: Effect.Effect<A, E, Layer.Success<ReturnType<typeof layer>>>) =>
    run(Effect.flip(effect));

  const connect = (
    ownerUserId: string,
    secret: string,
    target: {
      readonly name?: string;
      readonly accountId?: string;
      readonly makeDefault?: boolean;
    } = {},
  ) =>
    accounts.createConnectedAccount({
      payload: { ownerUserId, provider: "claude", secret, ...target },
    });
  const defaults = async (ownerUserId: string) =>
    (await run(accounts.listConnectedAccounts({ ownerUserId }))).items
      .filter((account) => account.isDefault === true)
      .map((account) => account.connectedAccountId);

  it("names a person's first account default and chooses it", async () => {
    const owner = await person();
    const first = await run(connect(owner, token("one")));
    expect(first).toMatchObject({ name: "default", isDefault: true, credentialRevision: 1 });
    expect((await run(resolveDefault(owner))).id).toBe(first.connectedAccountId);
  });

  it("names a first account default even when the connect named it", async () => {
    const owner = await person();
    const first = await run(connect(owner, token("one"), { name: "work" }));
    expect(first).toMatchObject({ name: "default", isDefault: true });
    expect((await run(resolveDefault(owner))).id).toBe(first.connectedAccountId);
  });

  it("means the chosen default by `default`, not the account named default", async () => {
    const owner = await person();
    const named = await run(connect(owner, token("one")));
    const chosen = await run(connect(owner, token("work"), { name: "work", makeDefault: true }));

    const replaced = await run(connect(owner, token("work-2"), { name: "default" }));
    expect(replaced).toMatchObject({
      connectedAccountId: chosen.connectedAccountId,
      name: "work",
      credentialRevision: 2,
    });
    const untouched = (
      await run(accounts.listConnectedAccounts({ ownerUserId: owner }))
    ).items.find((account) => account.connectedAccountId === named.connectedAccountId);
    expect(untouched).toMatchObject({ name: "default", isDefault: false, credentialRevision: 1 });

    const profileId = `prof_${randomUUID()}`;
    await Effect.runPromise(
      db
        .insert(schema.profiles)
        .values({ id: profileId, ownerUserId: owner, slug: profileId, name: "p" }),
    );
    const bindings = await run(
      profileModule.setProfileCredentialBinding({
        profileId,
        payload: { ownerUserId: owner, provider: "claude", connectedAccountId: "default" },
      }),
    );
    expect(bindings.items).toEqual([
      expect.objectContaining({
        connectedAccountId: chosen.connectedAccountId,
        account: expect.objectContaining({ isDefault: true }),
      }),
    ]);
  });

  it("with no default chosen, `default` names no account", async () => {
    const owner = await person();
    await run(connect(owner, token("one")));
    const work = await run(connect(owner, token("work"), { name: "work", makeDefault: true }));
    await run(
      accounts.archiveConnectedAccount({
        connectedAccountId: work.connectedAccountId,
        ownerUserId: owner,
      }),
    );
    await run(connect(owner, token("other"), { name: "other" }));

    expect(await refusal(connect(owner, token("two"), { name: "default" }))).toMatchObject({
      code: "connected-account-ambiguous",
    });
    expect(await defaults(owner)).toEqual([]);
  });

  it("replaces the only account on a connect without a target, and counts new bytes only", async () => {
    const owner = await person();
    const first = await run(connect(owner, token("one")));
    const again = await run(connect(owner, token("two")));
    expect(again).toMatchObject({
      connectedAccountId: first.connectedAccountId,
      isDefault: true,
      credentialRevision: 2,
    });
    const same = await run(connect(owner, token("two")));
    expect(same.credentialRevision).toBe(2);
  });

  it("with two accounts: refuses a connect without a target, replaces the one named, follows setDefault", async () => {
    const owner = await person();
    const first = await run(connect(owner, token("one")));
    const work = await run(connect(owner, token("work"), { name: "work" }));
    expect(work.isDefault).toBe(false);

    const ambiguous = await refusal(connect(owner, token("three")));
    expect(ambiguous).toMatchObject({ code: "connected-account-ambiguous" });
    expect(
      "candidateAccountIds" in ambiguous
        ? [...(ambiguous.candidateAccountIds ?? [])].toSorted()
        : [],
    ).toEqual([first.connectedAccountId, work.connectedAccountId].toSorted());

    const replaced = await run(
      connect(owner, token("work-2"), { accountId: work.connectedAccountId }),
    );
    expect(replaced).toMatchObject({
      connectedAccountId: work.connectedAccountId,
      isDefault: false,
      credentialRevision: 2,
    });
    expect((await run(resolveDefault(owner))).id).toBe(first.connectedAccountId);

    const chosen = {
      ownerUserId: owner,
      provider: "claude" as const,
      connectedAccountId: work.connectedAccountId,
    };
    expect(await run(accounts.setConnectedAccountDefault(chosen))).toMatchObject({
      isDefault: true,
    });
    await run(accounts.setConnectedAccountDefault(chosen));
    expect((await run(resolveDefault(owner))).id).toBe(work.connectedAccountId);
    expect(await defaults(owner)).toEqual([work.connectedAccountId]);
  });

  it("leaves no default when the default is disconnected, and never picks the other account", async () => {
    const owner = await person();
    const first = await run(connect(owner, token("one")));
    await run(connect(owner, token("work"), { name: "work" }));

    await run(
      accounts.archiveConnectedAccount({
        connectedAccountId: first.connectedAccountId,
        ownerUserId: owner,
      }),
    );
    expect(await defaults(owner)).toEqual([]);
    const pointers = await Effect.runPromise(
      db.execute<{ readonly connected_account_id: string | null }>(
        `select connected_account_id from connected_account_defaults where owner_user_id = '${owner}'`,
        "objects",
      ),
    );
    expect(pointers, "the default row names no account").toEqual([{ connected_account_id: null }]);
    expect(await refusal(resolveDefault(owner))).toMatchObject({
      code: "connected-account-missing",
      provider: "claude",
    });
  });

  it("makes a new account the default when asked to", async () => {
    const owner = await person();
    await run(connect(owner, token("one")));
    const work = await run(connect(owner, token("work"), { name: "work", makeDefault: true }));
    expect(work.isDefault).toBe(true);
    expect((await run(resolveDefault(owner))).id).toBe(work.connectedAccountId);
  });

  it("refuses a default that is invalid or someone else's", async () => {
    const owner = await person();
    const stranger = await person();
    const first = await run(connect(owner, token("one")));
    const theirs = await run(connect(stranger, token("theirs")));

    expect(
      await refusal(
        accounts.setConnectedAccountDefault({
          ownerUserId: owner,
          provider: "claude",
          connectedAccountId: theirs.connectedAccountId,
        }),
      ),
    ).toMatchObject({ _tag: "ConnectedAccountNotFoundError" });

    await run(
      accounts.markConnectedAccountInvalid({
        connectedAccountId: first.connectedAccountId,
        ownerUserId: owner,
      }),
    );
    expect(
      await refusal(
        accounts.setConnectedAccountDefault({
          ownerUserId: owner,
          provider: "claude",
          connectedAccountId: first.connectedAccountId,
        }),
      ),
    ).toMatchObject({ code: "connected-account-invalid" });
  });

  it("marks nothing invalid for a refusal of a credential that was since replaced", async () => {
    const owner = await person();
    const first = await run(connect(owner, token("one")));
    await run(connect(owner, token("two")));

    const stale = await run(
      accounts.markConnectedAccountInvalid({
        connectedAccountId: first.connectedAccountId,
        ownerUserId: owner,
        revision: 1,
      }),
    );
    expect(stale).toMatchObject({ outcome: "superseded", status: "active", credentialRevision: 2 });

    const current = await run(
      accounts.markConnectedAccountInvalid({
        connectedAccountId: first.connectedAccountId,
        ownerUserId: owner,
        revision: 2,
      }),
    );
    expect(current).toMatchObject({ outcome: "marked", status: "invalid", isDefault: true });
  });
});

const claudeKey = (label: string) => `sk-ant-api03-FAKE${label.padEnd(40, "0")}`;
const codexKey = (label: string) => `sk-proj-FAKE${label.padEnd(30, "0")}`;
const chatgptLogin = (label: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    tokens: { access_token: `at-fake-${label}`, refresh_token: `rt-fake-${label}` },
    last_refresh: "2026-10-01T00:00:00.000Z",
    ...extra,
  });

describe.skipIf(DATABASE_URL === undefined)("API-key logins (Postgres)", () => {
  let db: DB;

  beforeAll(async () => {
    accounts = await import("./connected-accounts.module.js");
    db = await createSealantDB(DATABASE_URL ?? "");
  });

  const person = async () => {
    const id = `user_key_${randomUUID()}`;
    await Effect.runPromise(
      db.insert(user).values({ id, name: "person", email: `${id}@example.test` }),
    );
    return id;
  };

  const layer = () =>
    Layer.mergeAll(ConnectedAccountRepoLive, ProfileRepoLive, DatabaseTransactionLive).pipe(
      Layer.provideMerge(Layer.succeed(SealantDB, db)),
      Layer.provideMerge(Layer.succeed(CredentialCipher, fakeCipher)),
    );
  const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<ReturnType<typeof layer>>>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer())));
  const refusal = <A, E>(effect: Effect.Effect<A, E, Layer.Success<ReturnType<typeof layer>>>) =>
    run(Effect.flip(effect));

  const connect = (
    ownerUserId: string,
    provider: "claude" | "codex" | "github",
    secret: string,
    target: {
      readonly name?: string;
      readonly accountId?: string;
      readonly makeDefault?: boolean;
      readonly login?: "subscription" | "api-key";
    } = {},
  ) => accounts.createConnectedAccount({ payload: { ownerUserId, provider, secret, ...target } });
  const list = (ownerUserId: string) => run(accounts.listConnectedAccounts({ ownerUserId }));
  const sealed = async (connectedAccountId: string): Promise<unknown> => {
    const [row] = await Effect.runPromise(
      db.execute<{ readonly encrypted_payload: string }>(
        `select encrypted_payload from connected_accounts where id = '${connectedAccountId}'`,
        "objects",
      ),
    );
    return JSON.parse((row?.encrypted_payload ?? "").slice("sealed:".length));
  };

  it("connects each key shape as an api-key account holding the key alone", async () => {
    const shapes = [
      { provider: "claude", secret: `  ${claudeKey("claude")}\n`, key: claudeKey("claude") },
      { provider: "codex", secret: codexKey("bare"), key: codexKey("bare") },
      {
        provider: "codex",
        secret: JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: codexKey("file") }),
        key: codexKey("file"),
      },
      {
        provider: "codex",
        secret: JSON.stringify({ OPENAI_API_KEY: codexKey("old"), tokens: null }),
        key: codexKey("old"),
      },
      {
        provider: "codex",
        secret: chatgptLogin("both", { auth_mode: "apikey", OPENAI_API_KEY: codexKey("both") }),
        key: codexKey("both"),
      },
    ] as const;
    for (const shape of shapes) {
      const owner = await person();
      const account = await run(connect(owner, shape.provider, shape.secret));
      expect(account).toMatchObject({
        provider: shape.provider,
        name: "default",
        kind: "api-key",
        isDefault: true,
        login: { kind: "api-key", suffix: shape.key.slice(-4) },
        metadata: { tokenSuffix: shape.key.slice(-4) },
      });
      expect(await sealed(account.connectedAccountId)).toEqual({ apiKey: shape.key });
    }
  });

  it("keeps a ChatGPT login a subscription, and refuses what it cannot tell or run", async () => {
    const owner = await person();
    const chatgpt = await run(
      connect(
        owner,
        "codex",
        chatgptLogin("sub", { auth_mode: "chatgpt", OPENAI_API_KEY: codexKey("x") }),
      ),
    );
    expect(chatgpt).toMatchObject({ kind: "auth-json", login: { kind: "subscription" } });

    const refusals: ReadonlyArray<{
      readonly provider: "claude" | "codex";
      readonly secret: string;
      readonly says: string;
    }> = [
      {
        provider: "codex",
        secret: chatgptLogin("both", { OPENAI_API_KEY: codexKey("y") }),
        says: "auth_mode",
      },
      {
        provider: "claude",
        secret: "sk-ant-admin01-FAKE0000000000000000000000000000",
        says: "An Admin API key cannot run a model.",
      },
      { provider: "codex", secret: claudeKey("wrong"), says: "Anthropic key" },
      { provider: "codex", secret: "not a key", says: "OpenAI API key" },
      ...(
        [
          ["sk-admin-FAKEadminkeyforthetests00000", "An Admin API key cannot run a model."],
          [claudeKey("wrapped"), "Anthropic key"],
          ["   ", 'starts with "sk-"'],
          ["abc", 'starts with "sk-"'],
          ["sk-short", "not a whole Codex API key"],
        ] as const
      ).map(([key, says]) => ({
        provider: "codex" as const,
        secret: JSON.stringify({ OPENAI_API_KEY: key }),
        says,
      })),
    ];
    for (const { provider, secret, says } of refusals) {
      const fresh = await person();
      expect(await refusal(connect(fresh, provider, secret))).toMatchObject({
        _tag: "ConnectedAccountBadRequestError",
        message: expect.stringContaining(says),
      });
      expect((await list(fresh)).items).toEqual([]);
    }
  });

  it("adds a key beside a subscription, leaves the default, and replaces only the key after", async () => {
    const owner = await person();
    const subscription = await run(connect(owner, "claude", token("sub")));
    const key = await run(connect(owner, "claude", claudeKey("one")));
    expect(key).toMatchObject({ name: "api-key", isDefault: false, kind: "api-key" });
    expect(key.connectedAccountId).not.toBe(subscription.connectedAccountId);

    const again = await run(connect(owner, "claude", claudeKey("two")));
    expect(again).toMatchObject({
      connectedAccountId: key.connectedAccountId,
      credentialRevision: 2,
      login: { kind: "api-key", suffix: claudeKey("two").slice(-4) },
    });
    const reconnected = await run(connect(owner, "claude", token("sub-2")));
    expect(reconnected).toMatchObject({
      connectedAccountId: subscription.connectedAccountId,
      isDefault: true,
      credentialRevision: 2,
    });
    expect((await list(owner)).items).toHaveLength(2);
  });

  it("names a new account by class, with a number when the name is taken", async () => {
    const owner = await person();
    await run(connect(owner, "codex", chatgptLogin("first")));
    await run(connect(owner, "codex", chatgptLogin("named"), { name: "api-key" }));
    expect(await run(connect(owner, "codex", codexKey("key")))).toMatchObject({
      name: "api-key-2",
      kind: "api-key",
      isDefault: false,
    });

    const keyFirst = await person();
    await run(connect(keyFirst, "codex", codexKey("first")));
    expect(await run(connect(keyFirst, "codex", chatgptLogin("sub")))).toMatchObject({
      name: "subscription",
      kind: "auth-json",
      isDefault: false,
    });
  });

  it("refuses a connect without a target among two subscriptions, naming only those", async () => {
    const owner = await person();
    const first = await run(connect(owner, "claude", token("one")));
    const second = await run(connect(owner, "claude", token("two"), { name: "work" }));
    await run(connect(owner, "claude", claudeKey("key")));

    const ambiguous = await refusal(connect(owner, "claude", token("three")));
    expect(ambiguous).toMatchObject({ code: "connected-account-ambiguous" });
    expect(
      "candidateAccountIds" in ambiguous
        ? [...(ambiguous.candidateAccountIds ?? [])].toSorted()
        : [],
    ).toEqual([first.connectedAccountId, second.connectedAccountId].toSorted());
  });

  it("refuses a secret of the other login class than expected, storing nothing", async () => {
    const owner = await person();
    expect(
      await refusal(connect(owner, "claude", token("sub"), { login: "api-key" })),
    ).toMatchObject({ message: "That is a Claude subscription login, not an API key." });
    expect(
      await refusal(connect(owner, "codex", codexKey("key"), { login: "subscription" })),
    ).toMatchObject({ message: "That is a Codex API key, not a subscription login." });
    expect(
      await refusal(connect(owner, "github", "gho_fake", { login: "subscription" })),
    ).toMatchObject({ _tag: "ConnectedAccountBadRequestError" });
    expect((await list(owner)).items).toEqual([]);

    expect(
      await run(connect(owner, "claude", claudeKey("key"), { login: "api-key" })),
    ).toMatchObject({ kind: "api-key" });
  });

  it("never lets a subscription replace a key stored before keys had a kind", async () => {
    const owner = await person();
    const legacy = await run(
      Effect.flatMap(ConnectedAccountRepo, (repo) =>
        Effect.gen(function* () {
          const plaintext = JSON.stringify({
            authJson: JSON.stringify({ OPENAI_API_KEY: codexKey("legacy"), tokens: null }),
          });
          const created = yield* repo.createConnectedAccount({
            id: `cacc_${randomUUID()}`,
            ownerUserId: owner,
            provider: "codex",
            name: "default",
            kind: "auth-json",
            encryptedPayload: `sealed:${plaintext}`,
            encryptionKeyId: "k-test",
            payloadSha256: randomUUID(),
            metadata: {},
          });
          yield* repo.setDefault({
            ownerUserId: owner,
            provider: "codex",
            connectedAccountId: created.id,
          });
          return created;
        }),
      ),
    );
    const before = await sealed(legacy.id);

    const subscription = await run(connect(owner, "codex", chatgptLogin("sub")));
    expect(subscription).toMatchObject({ name: "subscription", kind: "auth-json" });
    expect(subscription.connectedAccountId).not.toBe(legacy.id);
    expect(await sealed(legacy.id)).toEqual(before);

    const key = await run(connect(owner, "codex", codexKey("new")));
    expect(key).toMatchObject({ connectedAccountId: legacy.id, kind: "api-key" });
  });

  it("keeps a person's key history after their key is replaced with a subscription", async () => {
    const owner = await person();
    const key = await run(connect(owner, "codex", codexKey("key")));
    const replaced = await run(
      connect(owner, "codex", chatgptLogin("sub"), { accountId: key.connectedAccountId }),
    );
    expect(replaced).toMatchObject({
      connectedAccountId: key.connectedAccountId,
      kind: "auth-json",
    });
    expect(await list(owner)).toMatchObject({
      items: [expect.objectContaining({ login: { kind: "subscription" } })],
      hasApiKeyHistory: true,
    });
  });

  it("remembers that a person once connected a key, after it is gone", async () => {
    const owner = await person();
    await run(connect(owner, "codex", chatgptLogin("sub")));
    expect((await list(owner)).hasApiKeyHistory).toBe(false);
    const key = await run(connect(owner, "codex", codexKey("key")));
    expect((await list(owner)).hasApiKeyHistory).toBe(true);
    await run(
      accounts.archiveConnectedAccount({
        connectedAccountId: key.connectedAccountId,
        ownerUserId: owner,
      }),
    );
    const after = await list(owner);
    expect(after.items.map((account) => account.kind)).toEqual(["auth-json"]);
    expect(after.hasApiKeyHistory).toBe(true);
  });
});
