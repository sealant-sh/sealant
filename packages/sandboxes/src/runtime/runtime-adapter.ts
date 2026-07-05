import { newSandboxSchema } from "@sealant/validators";
import { z } from "zod";

export const runtimeAdapterBlueprintSchema = newSandboxSchema;

export const runtimeAdapterIdSchema = z.enum(["docker", "k8s", "k3s"]);

export const runtimeAdapterSupportFailureReasonSchema = z.enum([
  "unsupported-runtime",
  "unsupported-access-mode",
  "unsupported-runtime-requirement",
  "adapter-unavailable",
]);

export const runtimeAdapterSupportSchema = z.discriminatedUnion("supported", [
  z.strictObject({
    supported: z.literal(true),
  }),
  z.strictObject({
    supported: z.literal(false),
    reason: runtimeAdapterSupportFailureReasonSchema,
    message: z.string().trim().min(1),
  }),
]);

export const publishedImageSchema = z.strictObject({
  repository: z.string().trim().min(1),
  tag: z.string().trim().min(1),
  reference: z.string().trim().min(1),
  digestReference: z.string().trim().min(1),
  digest: z.string().trim().min(1),
});

export const sandboxCloneAuthSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("none"),
  }),
  z.strictObject({
    type: z.literal("file-ref"),
    path: z.string().trim().min(1),
  }),
  z.strictObject({
    type: z.literal("http-token"),
    username: z.string().trim().min(1),
    token: z.string().trim().min(1),
  }),
]);

export const runtimeAdapterSupportInputSchema = z.strictObject({
  blueprint: runtimeAdapterBlueprintSchema,
});

// Connected-account file injection (design doc §6): written AFTER the container is ready via
// `docker exec -i … base64 -d` with the content piped over stdin, so the bytes never appear in
// argv, image layers, or `docker inspect`. The path may contain `$HOME/…` — expansion happens
// inside the container shell.
export const credentialFileInjectionSchema = z.strictObject({
  path: z.string().trim().min(1),
  contentBase64: z.string().min(1),
  mode: z.string().regex(/^[0-7]{3,4}$/),
});

export const runtimeAdapterLaunchInputSchema = z.strictObject({
  blueprint: runtimeAdapterBlueprintSchema,
  publishedImage: publishedImageSchema,
  sandboxCloneAuth: sandboxCloneAuthSchema.optional(),
  // Connected-account env injections (e.g. CLAUDE_CODE_OAUTH_TOKEN); they join the existing `-e`
  // args, sharing the exposure profile of today's clone tokens (plaintext-argv hardening is a
  // tracked, pre-existing item).
  credentialEnv: z.record(z.string(), z.string()).optional(),
  credentialFiles: z.array(credentialFileInjectionSchema).optional(),
  // The run (sandbox attempt) this launch belongs to. When present the docker adapter derives a
  // DETERMINISTIC per-run container name, so a redelivered/reaper-republished or concurrent launch
  // for the same run adopts the existing container instead of spawning a duplicate (#4 double-launch).
  runId: z.string().trim().min(1).optional(),
});

export const runtimeAdapterLaunchResultSchema = z.strictObject({
  adapter: runtimeAdapterIdSchema,
  resourceId: z.string().trim().min(1),
  reference: z.string().trim().min(1),
  status: z.enum(["pending", "running", "ready"]),
  endpoint: z.string().trim().min(1).optional(),
});

export const parseRuntimeAdapterSupport = (input: unknown): RuntimeAdapterSupport => {
  return runtimeAdapterSupportSchema.parse(input);
};

export const parseRuntimeAdapterSupportInput = (input: unknown): RuntimeAdapterSupportInput => {
  return runtimeAdapterSupportInputSchema.parse(input);
};

export const parseRuntimeAdapterLaunchInput = (input: unknown): RuntimeAdapterLaunchInput => {
  return runtimeAdapterLaunchInputSchema.parse(input);
};

export const parseRuntimeAdapterLaunchResult = (input: unknown): RuntimeAdapterLaunchResult => {
  return runtimeAdapterLaunchResultSchema.parse(input);
};

export type RuntimeAdapterId = z.infer<typeof runtimeAdapterIdSchema>;

export type RuntimeAdapterBlueprint = z.infer<typeof runtimeAdapterBlueprintSchema>;

export type RuntimeAdapterSupportFailureReason = z.infer<
  typeof runtimeAdapterSupportFailureReasonSchema
>;

export type RuntimeAdapterSupport = z.infer<typeof runtimeAdapterSupportSchema>;

export type RuntimeAdapterSupportInput = z.infer<typeof runtimeAdapterSupportInputSchema>;

export type PublishedImage = z.infer<typeof publishedImageSchema>;

export type SandboxCloneAuth = z.infer<typeof sandboxCloneAuthSchema>;

export type CredentialFileInjection = z.infer<typeof credentialFileInjectionSchema>;

export type RuntimeAdapterLaunchInput = z.infer<typeof runtimeAdapterLaunchInputSchema>;

export type RuntimeAdapterLaunchResult = z.infer<typeof runtimeAdapterLaunchResultSchema>;

export interface RuntimeAdapter {
  readonly id: RuntimeAdapterId;

  supports(input: RuntimeAdapterSupportInput): RuntimeAdapterSupport;
  launch(input: RuntimeAdapterLaunchInput): Promise<RuntimeAdapterLaunchResult>;
}

const createSelectionError = (code: string, message: string): Error & { code: string } => {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
};

const candidateAdapterIds = (
  blueprint: RuntimeAdapterBlueprint,
  defaultAdapterId: RuntimeAdapterId,
): Array<RuntimeAdapterId> => {
  const requested = blueprint.target.runtime.family;
  const mode = blueprint.target.runtime.mode;

  if (requested === "auto") {
    return [defaultAdapterId];
  }

  if (mode === "require") {
    return [requested];
  }

  return [...new Set([requested, defaultAdapterId])];
};

export interface SelectRuntimeAdapterInput {
  readonly blueprint: RuntimeAdapterBlueprint;
  readonly adapters: readonly RuntimeAdapter[];
  readonly defaultAdapterId: RuntimeAdapterId;
}

export interface RuntimeAdapterSelection {
  readonly adapter: RuntimeAdapter;
  readonly adapterId: RuntimeAdapterId;
}

export const selectRuntimeAdapter = (input: SelectRuntimeAdapterInput): RuntimeAdapterSelection => {
  const supportInput = parseRuntimeAdapterSupportInput({
    blueprint: input.blueprint,
  });

  const attemptedIds = candidateAdapterIds(input.blueprint, input.defaultAdapterId);
  let firstSupportFailure: RuntimeAdapterSupport | undefined;

  for (const adapterId of attemptedIds) {
    const adapter = input.adapters.find((candidate) => candidate.id === adapterId);

    if (adapter === undefined) {
      continue;
    }

    const support = adapter.supports(supportInput);
    if (support.supported) {
      return {
        adapter,
        adapterId,
      };
    }

    if (firstSupportFailure === undefined) {
      firstSupportFailure = support;
    }
  }

  const requestedRuntime = input.blueprint.target.runtime.family;
  const mode = input.blueprint.target.runtime.mode;

  if (firstSupportFailure !== undefined && !firstSupportFailure.supported) {
    throw createSelectionError(firstSupportFailure.reason, firstSupportFailure.message);
  }

  if (requestedRuntime !== "auto" && mode === "require") {
    throw createSelectionError(
      "unsupported-runtime",
      `No runtime adapter is registered for target.runtime.family '${requestedRuntime}'.`,
    );
  }

  throw createSelectionError(
    "unsupported-runtime",
    `No runtime adapter is available for the requested runtime preference. Attempted: ${attemptedIds.join(", ")}.`,
  );
};
