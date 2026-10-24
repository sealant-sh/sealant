import { randomUUID } from "node:crypto";

import { CredentialCipher, type CredentialCipherService } from "@sealant/credentials";
import {
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
