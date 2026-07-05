/**
 * Lowers the public `SandboxCredentialsOptions` onto the control-plane's sandbox-create payload
 * shape. Pure and side-effect free so it is unit-testable on its own; `buildCreateSandboxRequest`
 * calls it and folds the result into the request it builds.
 *
 * SECURITY: this only ever moves account **references** (booleans/names/ids) — never token values or
 * other secret material. `true` resolves to the literal account name `"default"`; a string passes
 * through as the named account; `profile` becomes `profileId`.
 */
import type { SandboxCredentialsOptions } from "../types.js";

const DEFAULT_ACCOUNT_NAME = "default";

/** The control-plane's sandbox-create payload shape for connected-account credentials. */
export interface SandboxCredentialsPayload {
  readonly profileId?: string;
  readonly claude?: string;
  readonly codex?: string;
  readonly github?: string;
}

const mapAccountRef = (value: boolean | string | undefined): string | undefined => {
  if (value === undefined || value === false) {
    return undefined;
  }
  return value === true ? DEFAULT_ACCOUNT_NAME : value;
};

/**
 * Maps `SandboxCredentialsOptions` to the API payload shape, or `undefined` when no credentials were
 * requested (omitted entirely, rather than serialized as an empty object).
 */
export const mapSandboxCredentials = (
  options: SandboxCredentialsOptions | undefined,
): SandboxCredentialsPayload | undefined => {
  if (options === undefined) {
    return undefined;
  }

  const claude = mapAccountRef(options.claude);
  const codex = mapAccountRef(options.codex);
  const github = mapAccountRef(options.github);

  const payload: SandboxCredentialsPayload = {
    ...(options.profile === undefined ? {} : { profileId: options.profile }),
    ...(claude === undefined ? {} : { claude }),
    ...(codex === undefined ? {} : { codex }),
    ...(github === undefined ? {} : { github }),
  };

  return Object.keys(payload).length > 0 ? payload : undefined;
};
