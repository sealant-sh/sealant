/**
 * Configuration for the BuildKit-Job image builder. Separate from the runtime adapter's config:
 * builds may live in another namespace, with their own ServiceAccount and budget, and an operator
 * may run Kubernetes workspaces with an external build service later without touching this.
 */
import { z } from "zod";

const dnsLabel = z
  .string()
  .trim()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/, "must be a DNS-1123 label");
const dnsSubdomain = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(
    /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/,
    "must be a DNS-1123 subdomain",
  );
const quantity = z
  .string()
  .trim()
  .regex(/^[0-9]+(\.[0-9]+)?(m|k|M|G|T|P|E|Ki|Mi|Gi|Ti|Pi|Ei)?$/, "must be a Kubernetes quantity");

export const DEFAULT_BUILDKIT_IMAGE = "moby/buildkit:v0.20.2-rootless";

export const kubernetesBuildConfigSchema = z.strictObject({
  namespace: dnsLabel,
  serviceAccount: dnsSubdomain.default("sealant-build"),
  /** Rootless BuildKit image. Pin it; builds run with the privileges this image needs. */
  buildkitImage: z.string().trim().min(1).default(DEFAULT_BUILDKIT_IMAGE),
  /** Registry the Job pushes to (`host[:port]`), same value the worker's registry client uses. */
  pushRegistry: z.string().trim().min(1),
  /** True for an in-cluster plain-HTTP registry (the self-host zot default). */
  registryInsecure: z.boolean().default(false),
  registryCredentials: z
    .strictObject({ username: z.string().min(1), password: z.string().min(1) })
    .optional(),
  resources: z.strictObject({
    requests: z.strictObject({ cpu: quantity, memory: quantity }),
    limits: z.strictObject({ cpu: quantity, memory: quantity }),
  }),
  /** How long a Job may run before it is failed and cleaned up. */
  timeoutMs: z
    .number()
    .int()
    .min(60_000)
    .default(30 * 60_000),
  /** `ttlSecondsAfterFinished` — how long finished Jobs (and their logs) stay for inspection. */
  ttlSecondsAfterFinished: z.number().int().min(0).default(3600),
  imagePullSecret: dnsSubdomain.optional(),
  /** Development/test only: kubeconfig instead of in-cluster configuration. */
  kubeconfigPath: z.string().trim().min(1).optional(),
  managedBy: dnsLabel.default("sealant"),
});

export type KubernetesBuildConfig = z.infer<typeof kubernetesBuildConfigSchema>;

export interface KubernetesBuildEnvLike {
  readonly SEALANT_K8S_NAMESPACE?: string | undefined;
  readonly SEALANT_K8S_BUILD_NAMESPACE?: string | undefined;
  readonly SEALANT_K8S_BUILD_SERVICE_ACCOUNT?: string | undefined;
  readonly SEALANT_K8S_BUILDKIT_IMAGE?: string | undefined;
  readonly SEALANT_K8S_BUILD_CPU_REQUEST?: string | undefined;
  readonly SEALANT_K8S_BUILD_MEMORY_REQUEST?: string | undefined;
  readonly SEALANT_K8S_BUILD_CPU_LIMIT?: string | undefined;
  readonly SEALANT_K8S_BUILD_MEMORY_LIMIT?: string | undefined;
  readonly SEALANT_K8S_BUILD_TIMEOUT_MS?: number | undefined;
  readonly SEALANT_K8S_BUILD_TTL_SECONDS?: number | undefined;
  readonly SEALANT_K8S_REGISTRY_INSECURE?: boolean | undefined;
  readonly SEALANT_K8S_IMAGE_PULL_SECRET?: string | undefined;
  readonly SEALANT_K8S_KUBECONFIG?: string | undefined;
  readonly REGISTRY_PUSH_REGISTRY: string;
  readonly REGISTRY_USERNAME?: string | undefined;
  readonly REGISTRY_PASSWORD?: string | undefined;
}

export class KubernetesBuildConfigError extends Error {
  override readonly name = "KubernetesBuildConfigError";
}

/** Undefined unless the worker is configured for Kubernetes (`SEALANT_K8S_NAMESPACE`). */
export const kubernetesBuildConfigFromEnv = (
  env: KubernetesBuildEnvLike,
): KubernetesBuildConfig | undefined => {
  const namespace = env.SEALANT_K8S_BUILD_NAMESPACE ?? env.SEALANT_K8S_NAMESPACE;
  if (namespace === undefined) {
    return undefined;
  }
  const parsed = kubernetesBuildConfigSchema.safeParse({
    namespace,
    ...(env.SEALANT_K8S_BUILD_SERVICE_ACCOUNT === undefined
      ? {}
      : { serviceAccount: env.SEALANT_K8S_BUILD_SERVICE_ACCOUNT }),
    ...(env.SEALANT_K8S_BUILDKIT_IMAGE === undefined
      ? {}
      : { buildkitImage: env.SEALANT_K8S_BUILDKIT_IMAGE }),
    pushRegistry: env.REGISTRY_PUSH_REGISTRY,
    ...(env.SEALANT_K8S_REGISTRY_INSECURE === undefined
      ? {}
      : { registryInsecure: env.SEALANT_K8S_REGISTRY_INSECURE }),
    ...(env.REGISTRY_USERNAME !== undefined && env.REGISTRY_PASSWORD !== undefined
      ? {
          registryCredentials: { username: env.REGISTRY_USERNAME, password: env.REGISTRY_PASSWORD },
        }
      : {}),
    resources: {
      requests: {
        cpu: env.SEALANT_K8S_BUILD_CPU_REQUEST ?? "1",
        memory: env.SEALANT_K8S_BUILD_MEMORY_REQUEST ?? "2Gi",
      },
      limits: {
        cpu: env.SEALANT_K8S_BUILD_CPU_LIMIT ?? "4",
        memory: env.SEALANT_K8S_BUILD_MEMORY_LIMIT ?? "8Gi",
      },
    },
    ...(env.SEALANT_K8S_BUILD_TIMEOUT_MS === undefined
      ? {}
      : { timeoutMs: env.SEALANT_K8S_BUILD_TIMEOUT_MS }),
    ...(env.SEALANT_K8S_BUILD_TTL_SECONDS === undefined
      ? {}
      : { ttlSecondsAfterFinished: env.SEALANT_K8S_BUILD_TTL_SECONDS }),
    ...(env.SEALANT_K8S_IMAGE_PULL_SECRET === undefined
      ? {}
      : { imagePullSecret: env.SEALANT_K8S_IMAGE_PULL_SECRET }),
    ...(env.SEALANT_K8S_KUBECONFIG === undefined
      ? {}
      : { kubeconfigPath: env.SEALANT_K8S_KUBECONFIG }),
  });
  if (!parsed.success) {
    throw new KubernetesBuildConfigError(
      `Kubernetes build configuration is invalid: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  return parsed.data;
};
