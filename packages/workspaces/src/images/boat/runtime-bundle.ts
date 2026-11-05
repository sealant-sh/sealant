import { createHash } from "node:crypto";

import { z } from "zod";

import runtimePin from "./runtime-pin.json" with { type: "json" };

/** Exact distribution verified by the guest acquisition proof, never a development override. */
export const NATIVE_RUNTIME_PIN = Object.freeze(runtimePin);

/** SHA-256 of the exact bytes, rather than a program's reported version. */
export const sha256 = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");

/** Safe failures at the internal native builder boundary. */
export class NativeBuildError extends Error {
  readonly _tag = "NativeBuildError";

  constructor(
    readonly code: string,
    readonly journalPath?: string,
  ) {
    super(
      `Native snapshot failed: ${code}${journalPath === undefined ? "" : `; journal ${journalPath}`}`,
    );
  }
}

/** Expected native planning, provider, and cleanup failures remain explicit to callers. */
export type NativeResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: NativeBuildError };

/** Serialized runtime identity used by recipes, receipts, and attempt journals. */
export const nativeRuntimeIdentitySchema = z.object({
  source: z.literal(NATIVE_RUNTIME_PIN.source),
  platform: z.literal("linux/amd64"),
  manifest: z.literal(NATIVE_RUNTIME_PIN.manifest),
  sealantd: z.literal(NATIVE_RUNTIME_PIN.sealantd),
  socat: z.literal(NATIVE_RUNTIME_PIN.socat),
  relay: z.string().regex(/^[a-f0-9]{64}$/),
});
/** The relay hash covers the bundled local relay and its dependencies. */
export type NativeRuntimeIdentity = z.infer<typeof nativeRuntimeIdentitySchema>;

/** Only exact next180 bytes and checked platform provenance can construct this bundle. */
export class VerifiedRuntimeBundle {
  readonly #daemon: Uint8Array;
  readonly #socat: Uint8Array;
  readonly #relay: Uint8Array;

  private constructor(
    readonly identity: NativeRuntimeIdentity,
    input: {
      readonly sealantd: Uint8Array;
      readonly socat: Uint8Array;
      readonly relay: Uint8Array;
    },
  ) {
    Object.freeze(identity);
    this.#daemon = Uint8Array.from(input.sealantd);
    this.#socat = Uint8Array.from(input.socat);
    this.#relay = Uint8Array.from(input.relay);
  }

  /** Verify a guest-extracted or previously supplied bundle against the measured exact pin. */
  static parse(input: {
    readonly sourceIndex: Uint8Array;
    readonly platformManifest: Uint8Array;
    readonly sealantd: Uint8Array;
    readonly socat: Uint8Array;
    readonly relay: Uint8Array;
  }): NativeResult<VerifiedRuntimeBundle> {
    try {
      const index = z
        .object({
          manifests: z.array(
            z.object({
              digest: z.string(),
              platform: z.object({ architecture: z.string(), os: z.string() }),
            }),
          ),
        })
        .parse(JSON.parse(Buffer.from(input.sourceIndex).toString("utf8")));
      const amd64 = index.manifests.filter(
        (m) => m.platform.os === "linux" && m.platform.architecture === "amd64",
      );
      if (
        sha256(input.sourceIndex) !== NATIVE_RUNTIME_PIN.index ||
        sha256(input.platformManifest) !== NATIVE_RUNTIME_PIN.manifest ||
        amd64.length !== 1 ||
        amd64[0]?.digest !== `sha256:${NATIVE_RUNTIME_PIN.manifest}` ||
        sha256(input.sealantd) !== NATIVE_RUNTIME_PIN.sealantd ||
        sha256(input.socat) !== NATIVE_RUNTIME_PIN.socat ||
        input.relay.length === 0
      )
        return { ok: false, error: new NativeBuildError("native-runtime-provenance-mismatch") };
      return {
        ok: true,
        value: new VerifiedRuntimeBundle(
          {
            source: NATIVE_RUNTIME_PIN.source,
            platform: "linux/amd64",
            manifest: NATIVE_RUNTIME_PIN.manifest,
            sealantd: NATIVE_RUNTIME_PIN.sealantd,
            socat: NATIVE_RUNTIME_PIN.socat,
            relay: sha256(input.relay),
          },
          input,
        ),
      };
    } catch {
      return { ok: false, error: new NativeBuildError("native-runtime-provenance-mismatch") };
    }
  }

  /** Return copies so callers cannot mutate the verified installation bytes. */
  files(): ReadonlyArray<{
    readonly path: string;
    readonly bytes: Uint8Array;
    readonly sha256: string;
  }> {
    return [
      {
        path: "/usr/local/bin/sealantd",
        bytes: Uint8Array.from(this.#daemon),
        sha256: this.identity.sealantd,
      },
      {
        path: "/usr/local/bin/socat",
        bytes: Uint8Array.from(this.#socat),
        sha256: this.identity.socat,
      },
      {
        path: "/usr/local/lib/sealant/control-relay.cjs",
        bytes: Uint8Array.from(this.#relay),
        sha256: this.identity.relay,
      },
    ];
  }
}
