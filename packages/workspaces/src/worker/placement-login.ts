import { EndpointUrl, endpointHostOf, type CredentialPlacementLogin } from "@sealant/api-contracts";
import type {
  CredentialCipherError,
  CredentialCipherService,
  PlacedLogin,
} from "@sealant/credentials";
import type { WorkspaceCredentialPlacementLogin } from "@sealant/db";
import { Effect, Schema } from "effect";

/**
 * A placed login as its placement row keeps it: an endpoint's URL sealed with the credential key,
 * as the account's payload is, beside its host. Anyone reading the database without that key sees
 * the host and nothing more.
 */
export const sealPlacedLogin = (
  cipher: CredentialCipherService,
  login: PlacedLogin,
): Effect.Effect<WorkspaceCredentialPlacementLogin, CredentialCipherError> => {
  if (login.kind === "subscription") return Effect.succeed({ kind: "subscription" });
  const { suffix, baseUrl } = login;
  if (baseUrl === undefined) return Effect.succeed({ kind: "api-key", suffix });
  return cipher.encrypt(baseUrl).pipe(
    Effect.map(
      ({ sealed }): WorkspaceCredentialPlacementLogin => ({
        kind: "api-key",
        suffix,
        endpoint: { host: endpointHostOf(baseUrl), sealed },
      }),
    ),
  );
};

const decodeEndpointUrl = Schema.decodeUnknownEffect(EndpointUrl);

/**
 * What a placement's receipt says it spends: a key's endpoint URL unsealed, and a Claude key's
 * file path when it has one.
 */
export const receiptLoginOf = (
  cipher: CredentialCipherService,
  login: WorkspaceCredentialPlacementLogin,
  keyPath?: string,
): Effect.Effect<CredentialPlacementLogin, CredentialCipherError | Schema.SchemaError> => {
  if (login.kind === "subscription") return Effect.succeed({ kind: "subscription" });
  const key: Extract<CredentialPlacementLogin, { readonly kind: "api-key" }> = {
    kind: "api-key",
    suffix: login.suffix,
    ...(keyPath === undefined ? {} : { keyPath }),
  };
  if (login.endpoint === undefined) return Effect.succeed(key);
  return cipher.decrypt(login.endpoint.sealed).pipe(
    Effect.flatMap(decodeEndpointUrl),
    Effect.map((baseUrl) => ({ ...key, baseUrl })),
  );
};
