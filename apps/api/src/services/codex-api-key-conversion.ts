import {
  apiKeyMetadata,
  codexAuthJsonLogin,
  CredentialCipher,
  parseCodexCredentialPayload,
  placedLoginOf,
  sha256Hex,
} from "@sealant/credentials";
import { ConnectedAccountRepo, CredentialPlacementRepo, type ConnectedAccount } from "@sealant/db";
import { Effect, Layer } from "effect";

import { env } from "../runtime-env.js";

/*
Codex accounts stored before an API key had its own kind hold a key-only auth.json under kind
`auth-json` (`kind_unchecked` marks every Codex auth.json row from then). Each is read once: a key
Sealant takes is stored again as the key alone, kind `api-key`; a ChatGPT login keeps its payload
and loses the mark. A row holding a key Sealant refuses keeps its mark, is placed as it always was,
and is logged at every start. Every write is guarded by the revision it read, so a connect that
landed meanwhile wins, and a second run finds nothing left to do.

A login written into a home from such a row was recorded as a subscription; a key's placements at
the revision read are recorded as the key first, so a crash between the two writes leaves the mark
for the next start.
*/

const convertOne = (account: ConnectedAccount) =>
  Effect.gen(function* () {
    const cipher = yield* CredentialCipher;
    const accounts = yield* ConnectedAccountRepo;
    const stored = parseCodexCredentialPayload(
      JSON.parse(yield* cipher.decrypt(account.encryptedPayload)),
    );
    const login = "authJson" in stored ? codexAuthJsonLogin(stored.authJson) : undefined;
    const placed = yield* Effect.try(() => placedLoginOf("codex", stored)).pipe(
      Effect.orElseSucceed(() => undefined),
    );
    if (placed?.kind === "api-key") {
      yield* (yield* CredentialPlacementRepo).recordLegacyCodexKey({
        accountId: account.id,
        revision: account.credentialRevision,
        login: placed,
      });
    }
    if (login?.login === "api-key" && !login.key.valid) {
      yield* Effect.logWarning(
        `[api] connected accounts: Codex account ${account.id} holds a key in its auth.json that Sealant refuses (${login.key.reason}); it is left as it is.`,
      );
      return "refused" as const;
    }
    if ("apiKey" in stored) {
      const payloadJson = JSON.stringify(stored);
      const sealed = yield* cipher.encrypt(payloadJson);
      const replaced = yield* accounts.replacePayload({
        id: account.id,
        expectedRevision: account.credentialRevision,
        keepStatus: true,
        kind: "api-key",
        encryptedPayload: sealed.sealed,
        encryptionKeyId: sealed.keyId,
        payloadSha256: sha256Hex(payloadJson),
        metadata: { ...account.metadata, ...apiKeyMetadata(stored) },
      });
      return replaced === undefined ? ("superseded" as const) : ("converted" as const);
    }
    const checked = yield* accounts.replacePayload({
      id: account.id,
      expectedRevision: account.credentialRevision,
      keepStatus: true,
      kind: account.kind,
      encryptedPayload: account.encryptedPayload,
      encryptionKeyId: account.encryptionKeyId,
      payloadSha256: account.payloadSha256,
      metadata: account.metadata,
    });
    return checked === undefined ? ("superseded" as const) : ("checked" as const);
  });

export const convertLegacyCodexApiKeys = Effect.gen(function* () {
  const accounts = yield* ConnectedAccountRepo;
  const rows = yield* accounts.listKindUnchecked("codex");
  let converted = 0;
  for (const row of rows) {
    const outcome = yield* convertOne(row).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(
          `[api] connected accounts: Codex account ${row.id} was not checked for a key`,
          cause,
        ).pipe(Effect.as("failed" as const)),
      ),
    );
    if (outcome === "converted") converted += 1;
  }
  return converted;
});

export const CodexApiKeyConversionLive: Layer.Layer<
  never,
  never,
  ConnectedAccountRepo | CredentialPlacementRepo | CredentialCipher
> = Layer.effectDiscard(
  Effect.gen(function* () {
    if ((env.SEALANT_CREDENTIALS_KEY?.trim() ?? "") === "") return;
    const converted = yield* convertLegacyCodexApiKeys;
    if (converted > 0) {
      yield* Effect.logInfo(
        `[api] connected accounts: ${converted} Codex accounts that held an API key in an auth.json now hold the key alone`,
      );
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("[api] connected accounts: the Codex API key conversion failed", cause),
    ),
  ),
);
