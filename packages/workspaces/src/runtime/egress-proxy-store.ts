/**
 * A workspace's egress proxy as sealant stores it, turned into what its proxy is told: the sealed
 * brokered values and CA key opened with the credential key, the policy document rebuilt from the
 * stored policy, revocations and host facts, and the pushes and revocations a control-plane
 * process without Docker (the API) sends straight to the proxy's admin socket. The worker's sweep
 * covers what such a push could not confirm (`egress-proxy-sweep.ts`).
 */
import type { BrokeredSecret, NetworkPolicy } from "@sealant/api-contracts";
import type { CredentialCipherError, CredentialCipherService } from "@sealant/credentials";
import {
  tombstonesOf,
  type WorkspaceEgressPolicy,
  type WorkspaceEgressProxy,
  type WorkspaceEgressRevocation,
} from "@sealant/db";
import { Effect, Redacted, Schema } from "effect";

import { buildProxyPolicyDocument } from "./egress-proxy-policy.js";
import {
  createProxyAdminClient,
  ProxyAdminRefusedError,
  type ProxyAdminClient,
  type ProxyPolicyDocument,
} from "./proxy-admin-client.js";

export class EgressProxyStoreError extends Schema.TaggedError<EgressProxyStoreError>()(
  "EgressProxyStoreError",
  { message: Schema.String },
) {}

const valuesSchema = Schema.Record(Schema.String, Schema.String);
const decodeValues = Schema.decodeUnknownEffect(Schema.fromJsonString(valuesSchema));

/** Seal brokered secret values with the credential key: the one form they are stored in. */
export const sealBrokeredValues = (
  cipher: CredentialCipherService,
  values: Readonly<Record<string, string>>,
): Effect.Effect<{ readonly sealed: string; readonly keyId: string }, CredentialCipherError> =>
  cipher.encrypt(JSON.stringify(values));

/** Open stored brokered values; none stored is an empty map. */
export const openBrokeredValues = (
  cipher: CredentialCipherService,
  sealed: string | null | undefined,
): Effect.Effect<
  Redacted.Redacted<Readonly<Record<string, string>>>,
  CredentialCipherError | EgressProxyStoreError
> =>
  sealed === null || sealed === undefined
    ? Effect.succeed(Redacted.make({}))
    : cipher.decrypt(sealed).pipe(
        Effect.flatMap((json) => decodeValues(json)),
        Effect.mapError((error) =>
          error._tag === "CredentialCipherError"
            ? error
            : new EgressProxyStoreError({
                message: "Stored brokered values are not a string map.",
              }),
        ),
        Effect.map((values) => Redacted.make(values)),
      );

/**
 * The run's proxy policy as storage has it now. `undefined` while the launch has not measured
 * the host yet: nothing may be pushed before its first policy.
 */
export const storedProxyPolicyDocument = (input: {
  readonly cipher: CredentialCipherService;
  readonly proxy: WorkspaceEgressProxy;
  readonly policy: WorkspaceEgressPolicy | undefined;
  readonly revocations: readonly WorkspaceEgressRevocation[];
}): Effect.Effect<ProxyPolicyDocument | undefined, CredentialCipherError | EgressProxyStoreError> =>
  Effect.gen(function* () {
    const network = input.proxy.network;
    if (network === null) return undefined;
    const values = yield* openBrokeredValues(input.cipher, input.policy?.brokeredValuesSealed);
    const keyPem = yield* input.cipher.decrypt(input.proxy.caKeySealed);
    const tombstones = tombstonesOf(input.policy?.revocationWatermark ?? 0, input.revocations);
    return yield* Effect.try({
      try: () =>
        buildProxyPolicyDocument({
          networkPolicy: input.policy?.networkPolicy ?? undefined,
          brokeredSecrets: input.policy?.brokeredSecrets ?? [],
          brokeredValues: values,
          ca: { certPem: input.proxy.caCertPem, keyPem: Redacted.make(keyPem) },
          tombstones,
          host: network,
        }),
      catch: (error) =>
        new EgressProxyStoreError({
          message: error instanceof Error ? error.message : "The proxy policy could not be built.",
        }),
    });
  });

/** What a push to a live proxy came to. */
export type EgressPushOutcome =
  | { readonly enforcement: "enforced"; readonly closed: number }
  | { readonly enforcement: "pending"; readonly reason: string };

/**
 * Push `document` straight to the proxy's admin socket. Any failure leaves the change stored and
 * `pending`: the worker's sweep pushes it again, or kills the proxy for a revocation.
 */
export const pushToProxy = (
  proxy: Pick<WorkspaceEgressProxy, "adminSocketPath">,
  document: ProxyPolicyDocument,
  client: ProxyAdminClient = createProxyAdminClient(proxy.adminSocketPath),
): Effect.Effect<EgressPushOutcome> =>
  Effect.promise(() =>
    client.putPolicy(document).then(
      (applied): EgressPushOutcome => ({ enforcement: "enforced", closed: applied.closed }),
      (error: unknown): EgressPushOutcome => ({
        enforcement: "pending",
        reason: error instanceof Error ? error.message : String(error),
      }),
    ),
  );

/**
 * Send a stored revocation straight to the proxy, which answers once every matching stream is
 * closed. A proxy past this watermark (409) took a later policy carrying it.
 */
export const revokeOnProxy = (
  proxy: Pick<WorkspaceEgressProxy, "adminSocketPath">,
  revocation: {
    readonly revocationWatermark: number;
    readonly secretIds: readonly string[];
    readonly hosts: readonly string[];
    readonly all: boolean;
  },
  client: ProxyAdminClient = createProxyAdminClient(proxy.adminSocketPath),
): Effect.Effect<EgressPushOutcome> =>
  Effect.promise(() =>
    client
      .revoke({
        revocationWatermark: revocation.revocationWatermark,
        revokeSecretIds: [...revocation.secretIds],
        revokeHosts: [...revocation.hosts],
        revokeAll: revocation.all,
      })
      .then(
        (revoked): EgressPushOutcome => ({ enforcement: "enforced", closed: revoked.closed }),
        (error: unknown): EgressPushOutcome =>
          error instanceof ProxyAdminRefusedError && error.code === "watermark_rollback"
            ? { enforcement: "enforced", closed: 0 }
            : {
                enforcement: "pending",
                reason: error instanceof Error ? error.message : String(error),
              },
      ),
  );

/** The parts of a stored policy row a create or an update writes. */
export interface EgressPolicyInput {
  readonly networkPolicy: NetworkPolicy | undefined;
  readonly brokeredSecrets: readonly BrokeredSecret[];
}
