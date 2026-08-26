/**
 * Kubernetes runtime configuration (docs/kubernetes-support-design.md §D5).
 *
 * Everything the adapter needs is validated here, once, from the worker's environment. Nothing in
 * this file touches the cluster. Docker deployments never construct this — the adapter is only
 * built when the worker is configured for Kubernetes.
 */
import { z } from "zod";

/** RFC 1123 label: what namespaces, names and most identifiers must satisfy. */
const dnsLabelSchema = z
  .string()
  .trim()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/, "must be a DNS-1123 label");

/** RFC 1123 subdomain (Secret/PriorityClass/RuntimeClass names allow dots). */
const dnsSubdomainSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(
    /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/,
    "must be a DNS-1123 subdomain",
  );

/** Kubernetes resource quantity (`500m`, `2`, `4Gi`, `1.5G`, `512Mi`). */
const quantitySchema = z
  .string()
  .trim()
  .regex(/^[0-9]+(\.[0-9]+)?(m|k|M|G|T|P|E|Ki|Mi|Gi|Ti|Pi|Ei)?$/, "must be a Kubernetes quantity");

const absoluteNormalizedPath = z
  .string()
  .trim()
  .min(2)
  .refine((value) => value.startsWith("/"), "must be absolute")
  .refine(
    (value) => value.split("/").every((segment) => segment !== "." && segment !== ".."),
    "must not contain '.' or '..' segments",
  )
  .refine((value) => !value.includes("//") && !value.endsWith("/"), "must be normalized");

/** One entry of `SEALANT_K8S_VOLUME_MAPPINGS`. */
export const volumeMappingSchema = z.strictObject({
  /** Canonical absolute root in the runtime-neutral path namespace (e.g. the Mend store root). */
  logicalRoot: absoluteNormalizedPath,
  /** The RWX claim that holds everything under `logicalRoot`. */
  claimName: dnsSubdomainSchema,
  /** Force read-only at the volume level regardless of what intents ask for. Default false. */
  readOnly: z.boolean().default(false),
});

export type VolumeMapping = z.infer<typeof volumeMappingSchema>;

const isDescendant = (candidate: string, root: string): boolean => candidate.startsWith(`${root}/`);

/** Mappings must be unambiguous: no root equal to or nested in another, no claim reused. */
export const volumeMappingsSchema = z
  .array(volumeMappingSchema)
  .min(1)
  .superRefine((mappings, ctx) => {
    for (const [index, mapping] of mappings.entries()) {
      for (const [otherIndex, other] of mappings.entries()) {
        if (index === otherIndex) {
          continue;
        }
        if (mapping.logicalRoot === other.logicalRoot) {
          ctx.addIssue({
            code: "custom",
            message: `logicalRoot '${mapping.logicalRoot}' is listed more than once`,
            path: [index, "logicalRoot"],
          });
        } else if (isDescendant(mapping.logicalRoot, other.logicalRoot)) {
          ctx.addIssue({
            code: "custom",
            message: `logicalRoot '${mapping.logicalRoot}' overlaps '${other.logicalRoot}'`,
            path: [index, "logicalRoot"],
          });
        }
        if (index < otherIndex && mapping.claimName === other.claimName) {
          ctx.addIssue({
            code: "custom",
            message: `claimName '${mapping.claimName}' is mapped to more than one root`,
            path: [otherIndex, "claimName"],
          });
        }
      }
    }
  });

export const certManagerIssuerSchema = z.strictObject({
  name: dnsSubdomainSchema,
  kind: z.enum(["Issuer", "ClusterIssuer"]).default("Issuer"),
  group: z.string().trim().min(1).default("cert-manager.io"),
});

export const resourceRequirementsSchema = z.strictObject({
  requests: z.strictObject({ cpu: quantitySchema, memory: quantitySchema }),
  limits: z.strictObject({ cpu: quantitySchema, memory: quantitySchema }),
});

export const kubernetesRuntimeConfigSchema = z.strictObject({
  /** Where workspace Pods live. The worker's RBAC is scoped to this namespace. */
  namespace: dnsLabelSchema,
  /** ServiceAccount for workspace Pods (token never mounted; see manifests). */
  workspaceServiceAccount: dnsSubdomainSchema.default("sealant-workspace"),
  /**
   * ServiceAccount names a blueprint may explicitly request via
   * `runtime.kubernetes.serviceAccountName` (cluster-env-sources design). Each entry is a trust
   * grant the operator makes deliberately — typically an IRSA/Workload-Identity SA. Empty (the
   * default) means explicit requests are refused; `automountServiceAccountToken` stays false
   * either way.
   */
  allowedWorkspaceServiceAccounts: z.array(dnsSubdomainSchema).default([]),
  /** Logical root → RWX claim. Every mount-sourced path must fall under exactly one root. */
  volumeMappings: volumeMappingsSchema,
  /** Port sealantd's WSS frontend listens on inside the Pod and the Service exposes. */
  controlPort: z.number().int().min(1).max(65535).default(7443),
  /** Optional imagePullSecret for the workspace image registry. */
  imagePullSecret: dnsSubdomainSchema.optional(),
  workspacePriorityClass: dnsSubdomainSchema.optional(),
  hotPoolPriorityClass: dnsSubdomainSchema.optional(),
  /** Applied to every workspace container. */
  resources: resourceRequirementsSchema,
  /** cert-manager issuer that signs per-workspace server certificates. */
  certManagerIssuer: certManagerIssuerSchema,
  /** Only set `runtimeClassName` when the operator enabled a gVisor RuntimeClass. */
  gvisorRuntimeClass: dnsSubdomainSchema.optional(),
  /**
   * Optional RWX claim for launch material too large for a Secret (dotfiles archives). The
   * worker must have the claim mounted at `stagingMountPath`; its logical root must appear in
   * `volumeMappings` so the Pod can mount the per-run subdirectory.
   */
  staging: z
    .strictObject({
      logicalRoot: absoluteNormalizedPath,
      /** Where the worker Pod sees that same claim (usually identical to logicalRoot). */
      mountPath: absoluteNormalizedPath,
    })
    .optional(),
  /** Soft budget for the launch Secret; Kubernetes enforces 1 MiB, we stay well under. */
  launchSecretBudgetBytes: z
    .number()
    .int()
    .min(64 * 1024)
    .max(1024 * 1024)
    .default(768 * 1024),
  readinessTimeoutMs: z.number().int().min(1000).default(300_000),
  /** Spread Pods across nodes; `k3s` defaults this off (single-node is common). */
  topologySpread: z.boolean().default(true),
  /** Pin workspace Pods to a node pool (e.g. `{ "sealant.sh/pool": "workspaces" }`). */
  nodeSelector: z.record(z.string().min(1), z.string()).default({}),
  /** Development/test only: path to a kubeconfig instead of in-cluster configuration. */
  kubeconfigPath: z.string().trim().min(1).optional(),
  /** Stamped on every object; lets operators see which worker created a resource. */
  managedBy: dnsLabelSchema.default("sealant"),
});

export type KubernetesRuntimeConfig = z.infer<typeof kubernetesRuntimeConfigSchema>;

/** Label keys (documented; NetworkPolicies and operators select on them). */
export const LABEL_MANAGED_BY = "app.kubernetes.io/managed-by";
export const LABEL_COMPONENT = "app.kubernetes.io/component";
export const LABEL_WORKSPACE_ID = "sealant.sh/workspace-id";
export const LABEL_RUN_ID = "sealant.sh/run-id";
export const LABEL_ADAPTER = "sealant.sh/runtime-adapter";
export const LABEL_PRINCIPAL = "sealant.sh/principal";
export const LABEL_POOL = "sealant.sh/pool";
export const COMPONENT_WORKSPACE = "workspace";

/**
 * Shape of the raw environment the worker parses; kept separate so `@sealant/validators` owns
 * the env grammar while this package owns the semantic validation above.
 */
export interface KubernetesRuntimeEnvLike {
  readonly SEALANT_K8S_NAMESPACE?: string | undefined;
  readonly SEALANT_K8S_WORKSPACE_SERVICE_ACCOUNT?: string | undefined;
  readonly SEALANT_K8S_ALLOWED_WORKSPACE_SERVICE_ACCOUNTS?: string | undefined;
  readonly SEALANT_K8S_VOLUME_MAPPINGS?: string | undefined;
  readonly SEALANT_K8S_CONTROL_PORT?: number | undefined;
  readonly SEALANT_K8S_IMAGE_PULL_SECRET?: string | undefined;
  readonly SEALANT_K8S_WORKSPACE_PRIORITY_CLASS?: string | undefined;
  readonly SEALANT_K8S_HOT_POOL_PRIORITY_CLASS?: string | undefined;
  readonly SEALANT_K8S_DEFAULT_CPU_REQUEST?: string | undefined;
  readonly SEALANT_K8S_DEFAULT_MEMORY_REQUEST?: string | undefined;
  readonly SEALANT_K8S_DEFAULT_CPU_LIMIT?: string | undefined;
  readonly SEALANT_K8S_DEFAULT_MEMORY_LIMIT?: string | undefined;
  readonly SEALANT_K8S_CERT_ISSUER_NAME?: string | undefined;
  readonly SEALANT_K8S_CERT_ISSUER_KIND?: "Issuer" | "ClusterIssuer" | undefined;
  readonly SEALANT_K8S_GVISOR_RUNTIME_CLASS?: string | undefined;
  readonly SEALANT_K8S_STAGING_LOGICAL_ROOT?: string | undefined;
  readonly SEALANT_K8S_STAGING_MOUNT_PATH?: string | undefined;
  readonly SEALANT_K8S_READINESS_TIMEOUT_MS?: number | undefined;
  readonly SEALANT_K8S_TOPOLOGY_SPREAD?: boolean | undefined;
  readonly SEALANT_K8S_WORKSPACE_NODE_SELECTOR?: string | undefined;
  readonly SEALANT_K8S_KUBECONFIG?: string | undefined;
}

export class KubernetesRuntimeConfigError extends Error {
  override readonly name = "KubernetesRuntimeConfigError";
}

const parseJsonObject = (key: string, raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new KubernetesRuntimeConfigError(
      `${key} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

const parseMappings = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new KubernetesRuntimeConfigError(
      `SEALANT_K8S_VOLUME_MAPPINGS is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

/**
 * Build the runtime config from env. Returns `undefined` when `SEALANT_K8S_NAMESPACE` is unset
 * (the worker is not configured for Kubernetes); throws a readable error when it is set but the
 * rest is incomplete or invalid.
 */
export const kubernetesRuntimeConfigFromEnv = (
  env: KubernetesRuntimeEnvLike,
): KubernetesRuntimeConfig | undefined => {
  if (env.SEALANT_K8S_NAMESPACE === undefined) {
    return undefined;
  }
  const missing = (key: string): never => {
    throw new KubernetesRuntimeConfigError(
      `${key} must be set when SEALANT_K8S_NAMESPACE is configured.`,
    );
  };
  const candidate = {
    namespace: env.SEALANT_K8S_NAMESPACE,
    ...(env.SEALANT_K8S_WORKSPACE_SERVICE_ACCOUNT === undefined
      ? {}
      : { workspaceServiceAccount: env.SEALANT_K8S_WORKSPACE_SERVICE_ACCOUNT }),
    ...(env.SEALANT_K8S_ALLOWED_WORKSPACE_SERVICE_ACCOUNTS === undefined
      ? {}
      : {
          allowedWorkspaceServiceAccounts: env.SEALANT_K8S_ALLOWED_WORKSPACE_SERVICE_ACCOUNTS.split(
            ",",
          )
            .map((name) => name.trim())
            .filter((name) => name.length > 0),
        }),
    volumeMappings: parseMappings(
      env.SEALANT_K8S_VOLUME_MAPPINGS ?? missing("SEALANT_K8S_VOLUME_MAPPINGS"),
    ),
    ...(env.SEALANT_K8S_CONTROL_PORT === undefined
      ? {}
      : { controlPort: env.SEALANT_K8S_CONTROL_PORT }),
    ...(env.SEALANT_K8S_IMAGE_PULL_SECRET === undefined
      ? {}
      : { imagePullSecret: env.SEALANT_K8S_IMAGE_PULL_SECRET }),
    ...(env.SEALANT_K8S_WORKSPACE_PRIORITY_CLASS === undefined
      ? {}
      : { workspacePriorityClass: env.SEALANT_K8S_WORKSPACE_PRIORITY_CLASS }),
    ...(env.SEALANT_K8S_HOT_POOL_PRIORITY_CLASS === undefined
      ? {}
      : { hotPoolPriorityClass: env.SEALANT_K8S_HOT_POOL_PRIORITY_CLASS }),
    resources: {
      requests: {
        cpu: env.SEALANT_K8S_DEFAULT_CPU_REQUEST ?? "500m",
        memory: env.SEALANT_K8S_DEFAULT_MEMORY_REQUEST ?? "1Gi",
      },
      limits: {
        cpu: env.SEALANT_K8S_DEFAULT_CPU_LIMIT ?? "4",
        memory: env.SEALANT_K8S_DEFAULT_MEMORY_LIMIT ?? "8Gi",
      },
    },
    certManagerIssuer: {
      name: env.SEALANT_K8S_CERT_ISSUER_NAME ?? missing("SEALANT_K8S_CERT_ISSUER_NAME"),
      ...(env.SEALANT_K8S_CERT_ISSUER_KIND === undefined
        ? {}
        : { kind: env.SEALANT_K8S_CERT_ISSUER_KIND }),
    },
    ...(env.SEALANT_K8S_GVISOR_RUNTIME_CLASS === undefined
      ? {}
      : { gvisorRuntimeClass: env.SEALANT_K8S_GVISOR_RUNTIME_CLASS }),
    ...(env.SEALANT_K8S_STAGING_LOGICAL_ROOT === undefined
      ? {}
      : {
          staging: {
            logicalRoot: env.SEALANT_K8S_STAGING_LOGICAL_ROOT,
            mountPath: env.SEALANT_K8S_STAGING_MOUNT_PATH ?? env.SEALANT_K8S_STAGING_LOGICAL_ROOT,
          },
        }),
    ...(env.SEALANT_K8S_READINESS_TIMEOUT_MS === undefined
      ? {}
      : { readinessTimeoutMs: env.SEALANT_K8S_READINESS_TIMEOUT_MS }),
    ...(env.SEALANT_K8S_TOPOLOGY_SPREAD === undefined
      ? {}
      : { topologySpread: env.SEALANT_K8S_TOPOLOGY_SPREAD }),
    ...(env.SEALANT_K8S_WORKSPACE_NODE_SELECTOR === undefined
      ? {}
      : {
          nodeSelector: parseJsonObject(
            "SEALANT_K8S_WORKSPACE_NODE_SELECTOR",
            env.SEALANT_K8S_WORKSPACE_NODE_SELECTOR,
          ),
        }),
    ...(env.SEALANT_K8S_KUBECONFIG === undefined
      ? {}
      : { kubeconfigPath: env.SEALANT_K8S_KUBECONFIG }),
  };
  const parsed = kubernetesRuntimeConfigSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new KubernetesRuntimeConfigError(
      `Kubernetes runtime configuration is invalid: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  const config = parsed.data;
  if (
    config.staging !== undefined &&
    !config.volumeMappings.some((mapping) => mapping.logicalRoot === config.staging?.logicalRoot)
  ) {
    throw new KubernetesRuntimeConfigError(
      `SEALANT_K8S_STAGING_LOGICAL_ROOT '${config.staging.logicalRoot}' must also appear in SEALANT_K8S_VOLUME_MAPPINGS so workspace Pods can mount it.`,
    );
  }
  return config;
};
