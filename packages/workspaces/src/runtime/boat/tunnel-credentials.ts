import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { CredentialCipher } from "@sealant/credentials";
import {
  BoatTunnelRepo,
  boatTunnelRepoLayer,
  type BoatTunnelStoreError,
  type SealantDB,
} from "@sealant/db";
import {
  boatWireGuardKeySchema,
  type BoatTunnelBinding,
  type BoatTunnelMaterial,
  type BoatTunnelReservation,
} from "@sealant/validators";
import { Context, Effect, Layer, Redacted } from "effect";
import { z } from "zod";

/** Safe errors never include plaintext, ciphertext or parser diagnostics. */
export class BoatTunnelCredentialsError extends Error {
  readonly _tag = "BoatTunnelCredentialsError";
  constructor(readonly code: "keys-unavailable" | "seal-context-mismatch") {
    super(`Boat tunnel credentials: ${code}`);
  }
}
/** Only the gateway/guest I/O owners may unwrap their respective private key. */
export interface BoatTunnelCredentials {
  readonly binding: BoatTunnelBinding;
  readonly reservationId: string;
  readonly listenPort: number;
  readonly gateway: { readonly publicKey: string; readonly privateKey: Redacted.Redacted };
  readonly guest: { readonly publicKey: string; readonly privateKey: Redacted.Redacted };
}
/** Preparation persists custody before exposing keys. It does not configure a peer or authorize admission. */
export interface BoatTunnelCredentialsService {
  readonly prepare: (
    binding: BoatTunnelBinding,
  ) => Effect.Effect<BoatTunnelCredentials, BoatTunnelStoreError | BoatTunnelCredentialsError>;
}
/** Stable per-execution WireGuard material and host UDP reservation. */
export class BoatTunnelCredentialsOwner extends Context.Service<
  BoatTunnelCredentialsOwner,
  BoatTunnelCredentialsService
>()("@sealant/workspaces/boat/BoatTunnelCredentialsOwner") {}

const privateKeys = z.strictObject({
  gateway: boatWireGuardKeySchema,
  guest: boatWireGuardKeySchema,
});
const context = (
  record: BoatTunnelReservation,
  material: Omit<BoatTunnelMaterial, "sealedKeys">,
) => ({
  format: "sealant-boat-tunnel-keys-v1",
  binding: record.binding,
  reservationId: record.reservationId,
  listenPort: record.listenPort,
  gatewayPublicKey: material.gatewayPublicKey,
  guestPublicKey: material.guestPublicKey,
});
const generate = () => {
  const pair = generateKeyPairSync("x25519");
  return {
    publicKey: pair.publicKey
      .export({ format: "der", type: "spki" })
      .subarray(-32)
      .toString("base64"),
    privateKey: pair.privateKey
      .export({ format: "der", type: "pkcs8" })
      .subarray(-32)
      .toString("base64"),
  };
};
const publicKey = (key: string) =>
  createPublicKey(
    createPrivateKey({
      key: Buffer.concat([
        Buffer.from("302e020100300506032b656e04220420", "hex"),
        Buffer.from(key, "base64"),
      ]),
      format: "der",
      type: "pkcs8",
    }),
  )
    .export({ format: "der", type: "spki" })
    .subarray(-32)
    .toString("base64");

const make: Effect.Effect<
  BoatTunnelCredentialsOwner["Service"],
  never,
  BoatTunnelRepo | CredentialCipher
> = Effect.gen(function* () {
  const repo = yield* BoatTunnelRepo;
  const cipher = yield* CredentialCipher;
  const prepare = Effect.fn("BoatTunnelCredentialsOwner.prepare")(function* (
    binding: BoatTunnelBinding,
  ) {
    let record = yield* repo.reserve(binding, randomUUID());
    if (record.material === null) {
      const keys = yield* Effect.try({
        try: () => ({ gateway: generate(), guest: generate() }),
        catch: () => new BoatTunnelCredentialsError("keys-unavailable"),
      });
      const material = {
        gatewayPublicKey: keys.gateway.publicKey,
        guestPublicKey: keys.guest.publicKey,
      };
      const sealed = yield* cipher
        .encrypt(
          JSON.stringify({
            context: context(record, material),
            keys: { gateway: keys.gateway.privateKey, guest: keys.guest.privateKey },
          }),
        )
        .pipe(Effect.mapError(() => new BoatTunnelCredentialsError("keys-unavailable")));
      record = yield* repo.install(record, { ...material, sealedKeys: sealed.sealed });
    }
    const material = record.material;
    if (material === null)
      return yield* Effect.fail(new BoatTunnelCredentialsError("keys-unavailable"));
    const raw = yield* cipher
      .decrypt(material.sealedKeys)
      .pipe(Effect.mapError(() => new BoatTunnelCredentialsError("keys-unavailable")));
    return yield* Effect.try({
      try: (): BoatTunnelCredentials => {
        const opened = z
          .strictObject({ context: z.unknown(), keys: privateKeys })
          .parse(JSON.parse(raw));
        if (
          !isDeepStrictEqual(opened.context, context(record, material)) ||
          publicKey(opened.keys.gateway) !== material.gatewayPublicKey ||
          publicKey(opened.keys.guest) !== material.guestPublicKey
        )
          throw new Error();
        return {
          binding: record.binding,
          reservationId: record.reservationId,
          listenPort: record.listenPort,
          gateway: {
            publicKey: material.gatewayPublicKey,
            privateKey: Redacted.make(opened.keys.gateway),
          },
          guest: {
            publicKey: material.guestPublicKey,
            privateKey: Redacted.make(opened.keys.guest),
          },
        };
      },
      catch: () => new BoatTunnelCredentialsError("seal-context-mismatch"),
    });
  });
  return BoatTunnelCredentialsOwner.of({ prepare });
});

/** Open assembly for faithful repository/cipher implementations. */
export const boatTunnelCredentialsLayerNoDeps: Layer.Layer<
  BoatTunnelCredentialsOwner,
  never,
  BoatTunnelRepo | CredentialCipher
> = Layer.effect(BoatTunnelCredentialsOwner, make);
/** Owns its repository; worker composition must supply PostgreSQL and the existing credential cipher. */
export const boatTunnelCredentialsLayer: Layer.Layer<
  BoatTunnelCredentialsOwner,
  never,
  SealantDB | CredentialCipher
> = boatTunnelCredentialsLayerNoDeps.pipe(Layer.provide(boatTunnelRepoLayer));
