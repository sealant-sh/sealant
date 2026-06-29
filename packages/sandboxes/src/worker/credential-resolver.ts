/**
 * Resolve a sandbox spec's `runtime.credentialRefs` into concrete injectables at launch.
 *
 * Each ref carries only an opaque id (`sealant-credential:<id>`) — never the secret. Here, in the
 * trusted worker, we re-scope the credential to its owner, decrypt the active version, and map it to
 * either an env var (tokens) or a 0600 file (subscription credential files), keyed by provider. The
 * caller injects these into the harness process only (see the run-exec injection path) — never the
 * container-wide env, which sealantd strips anyway.
 */
import {
  PrincipalCredentialRepo,
  decryptEnvelopeText,
  type KeyProvider,
  type PrincipalCredentialProvider,
} from "@sealant/db";
import { Effect } from "effect";

const REF_PREFIX = "sealant-credential:";

/** Extract the credential id from a `sealant-credential:<id>` ref, or `undefined` on a prefix miss. */
export const parseCredentialRef = (ref: string): string | undefined =>
  ref.startsWith(REF_PREFIX) ? ref.slice(REF_PREFIX.length) : undefined;

/** Build a ref string from a credential id. */
export const toCredentialRef = (credentialId: string): string => `${REF_PREFIX}${credentialId}`;

export interface CredentialFileInjection {
  readonly path: string;
  readonly mode: string;
  readonly content: string;
}

export interface CredentialInjectables {
  /** Env vars to set on the harness process only. */
  readonly env: Record<string, string>;
  /** 0600 files to materialize before the harness runs. */
  readonly files: CredentialFileInjection[];
}

/** Default env var each provider's token authenticates through (overridable per ref via `targetEnv`). */
const DEFAULT_ENV_VAR: Record<PrincipalCredentialProvider, string> = {
  github: "GH_TOKEN",
  codex: "OPENAI_API_KEY",
  claude: "CLAUDE_CODE_OAUTH_TOKEN",
};

/** Where each provider's `raw_file` credential is materialized (the path the tool reads natively). */
const FILE_TARGET: Record<PrincipalCredentialProvider, { path: string; mode: string }> = {
  codex: { path: "/root/.codex/auth.json", mode: "600" },
  claude: { path: "/root/.claude/.credentials.json", mode: "600" },
  github: { path: "/root/.config/gh/hosts.yml", mode: "600" },
};

export interface ResolveCredentialInjectablesInput {
  readonly refs: ReadonlyArray<{ readonly ref: string; readonly targetEnv?: string | undefined }>;
  readonly ownerUserId: string;
  readonly keyProvider: KeyProvider;
}

export const resolveCredentialInjectables = (input: ResolveCredentialInjectablesInput) =>
  Effect.gen(function* () {
    const repo = yield* PrincipalCredentialRepo;
    const env: Record<string, string> = {};
    const files: CredentialFileInjection[] = [];

    for (const r of input.refs) {
      const id = parseCredentialRef(r.ref);
      if (id === undefined) {
        continue;
      }
      const resolved = yield* repo.getActiveVersionForResolve({
        ownerUserId: input.ownerUserId,
        credentialId: id,
      });
      if (resolved === undefined) {
        // Not found, not owned, or revoked — skip (the harness simply runs unauthenticated for it).
        continue;
      }
      const secret = decryptEnvelopeText(
        resolved.version.envelope,
        `${input.ownerUserId}:${id}`,
        input.keyProvider,
      );
      const provider = resolved.credential.provider;
      if (resolved.version.payloadShape === "raw_file") {
        const target = FILE_TARGET[provider];
        files.push({ path: target.path, mode: target.mode, content: secret });
      } else {
        env[r.targetEnv ?? DEFAULT_ENV_VAR[provider]] = secret;
      }
      yield* repo.recordUsage(id).pipe(Effect.ignore);
    }

    return { env, files } satisfies CredentialInjectables;
  });
