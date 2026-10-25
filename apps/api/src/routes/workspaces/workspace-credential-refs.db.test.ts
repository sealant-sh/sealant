import { randomUUID } from "node:crypto";

import { CredentialCipher, type CredentialCipherService } from "@sealant/credentials";
import {
  ConnectedAccountRepo,
  ConnectedAccountRepoLive,
  createSealantDB,
  ProfileRepo,
  ProfileRepoLive,
  SealantDB,
  user,
  type DB,
} from "@sealant/db";
import { Effect, Layer } from "effect";
import { beforeAll, describe, expect, it } from "vitest";

process.env["SEALANT_CREDENTIALS_KEY"] = Buffer.alloc(32, 7).toString("base64");

const DATABASE_URL = process.env.SEALANT_TEST_DATABASE_URL;

let workspaces: typeof import("./workspaces.module.js");

const fakeCipher: CredentialCipherService = {
  encrypt: (plaintext) => Effect.succeed({ sealed: `sealed:${plaintext}`, keyId: "k-test" }),
  decrypt: (sealed) => Effect.succeed(sealed.slice("sealed:".length)),
};

describe.skipIf(DATABASE_URL === undefined)("a workspace's logins at create (Postgres)", () => {
  let db: DB;

  beforeAll(async () => {
    workspaces = await import("./workspaces.module.js");
    db = await createSealantDB(DATABASE_URL ?? "");
  });

  const layer = () =>
    Layer.mergeAll(
      ConnectedAccountRepoLive,
      ProfileRepoLive,
      Layer.succeed(CredentialCipher, fakeCipher),
    ).pipe(Layer.provide(Layer.succeed(SealantDB, db)));
  const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<ReturnType<typeof layer>>>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer())));

  const personWith = async (
    provider: "claude" | "codex",
    kind: string,
    payload: unknown,
    profileId?: string,
  ) => {
    const owner = `user_refs_${randomUUID()}`;
    await Effect.runPromise(
      db.insert(user).values({ id: owner, name: "refs", email: `${owner}@example.test` }),
    );
    const plaintext = JSON.stringify(payload);
    await run(
      Effect.flatMap(ConnectedAccountRepo, (accounts) =>
        Effect.gen(function* () {
          const created = yield* accounts.createConnectedAccount({
            id: `cacc_${randomUUID()}`,
            ownerUserId: owner,
            provider,
            name: "default",
            kind,
            encryptedPayload: `sealed:${plaintext}`,
            encryptionKeyId: "k-test",
            payloadSha256: randomUUID(),
            metadata: {},
          });
          yield* accounts.setDefault({
            ownerUserId: owner,
            provider,
            connectedAccountId: created.id,
          });
          if (profileId === undefined) return;
          const profiles = yield* ProfileRepo;
          yield* profiles.createProfile({
            id: profileId,
            ownerUserId: owner,
            slug: profileId,
            name: profileId,
          });
          yield* accounts.setProfileBinding({
            profileId,
            provider,
            connectedAccountId: created.id,
          });
        }),
      ),
    );
    return owner;
  };

  it("refuses a Claude key with words, and takes a Codex key", async () => {
    const claudeOwner = await personWith("claude", "api-key", {
      apiKey: "sk-ant-api03-FAKEclaudekeyforthetests000000wxyz",
    });
    const refused = await run(
      Effect.flip(
        workspaces.resolveWorkspaceCredentialRefs({
          ownerUserId: claudeOwner,
          credentials: { claude: "default" },
        }),
      ),
    );
    expect(refused).toMatchObject({
      _tag: "WorkspaceConflictError",
      code: "connected-account-unsupported",
      provider: "claude",
      message: expect.stringContaining("only through a credentials put into a person's home"),
    });

    const codexOwner = await personWith("codex", "api-key", {
      apiKey: "sk-proj-FAKEcodexkeyforthetests0000wxyz",
    });
    const refs = await run(
      workspaces.resolveWorkspaceCredentialRefs({
        ownerUserId: codexOwner,
        credentials: { codex: "default" },
      }),
    );
    expect(refs).toEqual([
      { provider: "codex", ref: expect.stringMatching(/^connected-account:cacc_/) },
    ]);
  });

  it("skips a profile's Claude key as it skips any unusable binding, and creates", async () => {
    const profileId = `prof_${randomUUID()}`;
    const owner = await personWith(
      "claude",
      "api-key",
      { apiKey: "sk-ant-api03-FAKEclaudekeyforthetests000000wxyz" },
      profileId,
    );
    expect(
      await run(
        workspaces.resolveWorkspaceCredentialRefs({
          ownerUserId: owner,
          credentials: { profileId },
        }),
      ),
    ).toEqual([]);
  });

  it("reads the payload, not the kind, to tell a Claude key", async () => {
    const owner = await personWith("claude", "credentials-json", {
      apiKey: "sk-ant-api03-FAKEclaudekeyforthetests000000wxyz",
    });
    expect(
      await run(
        Effect.flip(
          workspaces.resolveWorkspaceCredentialRefs({
            ownerUserId: owner,
            credentials: { claude: "default" },
          }),
        ),
      ),
    ).toMatchObject({ code: "connected-account-unsupported" });
  });
});
