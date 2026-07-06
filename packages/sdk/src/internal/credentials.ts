/**
 * Lowers the public `WorkspaceCredentialsOptions` onto the control-plane's workspace-create payload
 * shape. Pure and side-effect free so it is unit-testable on its own; `buildCreateWorkspaceRequest`
 * calls it and folds the result into the request it builds.
 *
 * SECURITY: this only ever moves account **references** (booleans/names/ids) — never token values or
 * other secret material. `true` resolves to the literal account name `"default"`; a string passes
 * through as the named account; `profile` becomes `profileId`.
 */
import type { WorkspaceCredentialsOptions } from "../types.js";

const DEFAULT_ACCOUNT_NAME = "default";

/** The control-plane's workspace-create payload shape for connected-account credentials. */
export interface WorkspaceCredentialsPayload {
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
 * Maps `WorkspaceCredentialsOptions` to the API payload shape, or `undefined` when no credentials were
 * requested (omitted entirely, rather than serialized as an empty object).
 */
export const mapWorkspaceCredentials = (
  options: WorkspaceCredentialsOptions | undefined,
): WorkspaceCredentialsPayload | undefined => {
  if (options === undefined) {
    return undefined;
  }

  const claude = mapAccountRef(options.claude);
  const codex = mapAccountRef(options.codex);
  const github = mapAccountRef(options.github);

  const payload: WorkspaceCredentialsPayload = {
    ...(options.profile === undefined ? {} : { profileId: options.profile }),
    ...(claude === undefined ? {} : { claude }),
    ...(codex === undefined ? {} : { codex }),
    ...(github === undefined ? {} : { github }),
  };

  return Object.keys(payload).length > 0 ? payload : undefined;
};
