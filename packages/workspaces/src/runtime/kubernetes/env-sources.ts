/**
 * Worker-side resolution of `runtime.envFrom` cluster env sources (cluster-env-sources design,
 * phase 2 of 2). The worker — not kubelet — reads each bound Secret/ConfigMap at workspace
 * creation, so a launch's snapshot survives container crash-restarts and rotation reaches only
 * workspaces created after it.
 *
 * Bindability is enforced here, fail-closed and readable:
 *   - only objects carrying the opt-in label `sealant.sh/workspace-env: "true"` resolve;
 *   - objects the platform itself manages (the managed-by label, or the `ws-…` per-workspace
 *     resource-name prefix) are refused unconditionally — the platform's own per-run Secrets live
 *     in this namespace with predictable names;
 *   - every refusal names the object, because a launch failing minutes after create must still
 *     tell the operator exactly which binding to fix.
 *
 * The one ordered list is last-wins ACROSS kinds; each key's winning source decides its delivery
 * lane. ConfigMap-won keys join the plain env list ahead of caller env (the adapter's last-wins
 * ordering keeps explicit env on top); Secret-won keys ride the `SEALANT_SECRET_ENV_FILE` launch
 * channel as its lowest-precedence layer, so secret-marker names survive sealantd's boot scrub
 * and seed the redactor.
 */
import type { V1ConfigMap, V1Secret } from "@kubernetes/client-node";
import type { WorkspaceEnvFromSource } from "@sealant/validators";

import { LABEL_MANAGED_BY } from "./config.js";

/** Objects must opt in with this label before the worker will resolve them into workspace env. */
export const WORKSPACE_ENV_OPT_IN_LABEL = "sealant.sh/workspace-env";

/** Per-workspace platform resources are named `ws-…` (names.ts); bound names never may be. */
const PLATFORM_NAME_PREFIX = "ws-";

/** Keys must be sane environment names; anything else in a bound object is a configuration bug. */
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class EnvSourceResolutionError extends Error {
  override readonly name = "EnvSourceResolutionError";
  readonly code = "env-source-unresolvable";
}

/** The slice of the cluster API resolution needs (KubernetesApi satisfies it). */
export interface EnvSourceReader {
  readonly namespace: string;
  readonly getSecret: (name: string) => Promise<V1Secret | undefined>;
  readonly getConfigMap: (name: string) => Promise<V1ConfigMap | undefined>;
}

export interface ResolvedEnvSources {
  /** Keys whose winning source is a ConfigMap — the weakest layer of the plain env list. */
  readonly configMapEnv: ReadonlyArray<readonly [string, string]>;
  /** Keys whose winning source is a Secret — the weakest layer of the secret env channel. */
  readonly secretEnv: Readonly<Record<string, string>>;
}

const describe = (source: WorkspaceEnvFromSource): string => `${source.kind}/${source.name}`;

const refuse = (message: string): never => {
  throw new EnvSourceResolutionError(message);
};

const entriesOf = (
  source: WorkspaceEnvFromSource,
  object: V1Secret | V1ConfigMap,
): ReadonlyArray<readonly [string, string]> => {
  const binaryKeys = Object.keys((object as V1ConfigMap).binaryData ?? {});
  if (source.kind === "configmap" && binaryKeys.length > 0) {
    refuse(
      `The bound ${describe(source)} has binaryData keys (${binaryKeys.join(", ")}); only plain data keys can become workspace environment.`,
    );
  }
  const data = object.data ?? {};
  return Object.entries(data).map(([key, value]) => {
    if (!ENV_NAME_PATTERN.test(key)) {
      refuse(
        `The bound ${describe(source)} has key '${key}', which is not a valid environment variable name.`,
      );
    }
    // Secret data is base64 on the wire; ConfigMap data is plain.
    return [key, source.kind === "secret" ? Buffer.from(value, "base64").toString("utf8") : value];
  });
};

/**
 * Resolve every bound object, in order, into the two delivery lanes. Throws
 * `EnvSourceResolutionError` with a message naming the binding on any refusal.
 */
export const resolveEnvSources = async (
  reader: EnvSourceReader,
  options: { readonly managedBy: string },
  envFrom: readonly WorkspaceEnvFromSource[],
): Promise<ResolvedEnvSources> => {
  const merged = new Map<
    string,
    { readonly kind: "secret" | "configmap"; readonly value: string }
  >();
  for (const source of envFrom) {
    if (source.name.startsWith(PLATFORM_NAME_PREFIX)) {
      refuse(
        `The bound ${describe(source)} matches the platform's per-workspace resource names ('${PLATFORM_NAME_PREFIX}…') and cannot be bound.`,
      );
    }
    const object =
      source.kind === "secret"
        ? await reader.getSecret(source.name)
        : await reader.getConfigMap(source.name);
    if (object === undefined) {
      throw new EnvSourceResolutionError(
        `The bound ${describe(source)} was not found in namespace '${reader.namespace}'.`,
      );
    }
    const labels = object.metadata?.labels ?? {};
    if (labels[LABEL_MANAGED_BY] === options.managedBy) {
      refuse(
        `The bound ${describe(source)} is managed by the platform (${LABEL_MANAGED_BY}=${options.managedBy}) and cannot be bound.`,
      );
    }
    if (labels[WORKSPACE_ENV_OPT_IN_LABEL] !== "true") {
      refuse(
        `The bound ${describe(source)} is not opted in for workspace env; label it ${WORKSPACE_ENV_OPT_IN_LABEL}="true" to allow binding.`,
      );
    }
    for (const [key, value] of entriesOf(source, object)) {
      // One ordered list, last-wins across kinds: the winning source decides the delivery lane.
      merged.delete(key);
      merged.set(key, { kind: source.kind, value });
    }
  }
  const configMapEnv: Array<readonly [string, string]> = [];
  const secretEnv: Record<string, string> = {};
  for (const [key, entry] of merged) {
    if (entry.kind === "configmap") {
      configMapEnv.push([key, entry.value]);
    } else {
      secretEnv[key] = entry.value;
    }
  }
  return { configMapEnv, secretEnv };
};
