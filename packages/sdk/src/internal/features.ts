/**
 * What the control plane says it can do (its index, `features`), read once per client and kept a
 * few minutes, so a client feature-detects instead of reading a version (a self-built control
 * plane reports `0.0.0`). A control plane from before a feature does not name it: `false`.
 */
import type { SystemIndexResponse } from "@sealant/api-contracts";

import { getIndexOp } from "../effect/operations.js";
import type { SdkContext } from "../facade/context.js";
import type { SealantFeatures } from "../types.js";

/** How long an answer is kept: an upgraded control plane is noticed within this. */
const ANSWER_TTL_MS = 5 * 60_000;
/** How long a failed read is kept before it is tried again. */
const FAILURE_TTL_MS = 15_000;

const answers = new WeakMap<
  SdkContext["runtime"],
  { readonly features: Promise<SealantFeatures>; expiresAt: number }
>();

/** The index's `features` as the SDK reports them: every flag named, absent ones `false`. */
export const toFeatures = (index: SystemIndexResponse): SealantFeatures => {
  const features = index.features;
  return {
    // Only the as-user routes' flag: `processUser` is the flag SDKs from before them read, and
    // this control plane reports it false (see `features.processUser` in the contract).
    processUserRoutes: features?.processUserRoutes === true,
    dotfilesApply: features?.dotfilesApply === true,
    credentialsPartialPut: features?.credentialsPartialPut === true,
    credentialsPiOpencode: features?.credentialsPiOpencode === true,
    captureOwnerMap: features?.captureOwnerMap === true,
  };
};

/**
 * The control plane's features, from this client's kept answer or a fresh read. Rejects when the
 * index could not be read; the failure is kept briefly, then the index is asked again.
 */
export const readFeatures = (ctx: SdkContext): Promise<SealantFeatures> => {
  const now = Date.now();
  const cached = answers.get(ctx.runtime);
  if (cached !== undefined && cached.expiresAt > now) return cached.features;
  const fresh = {
    expiresAt: now + ANSWER_TTL_MS,
    features: ctx.runtime.run(getIndexOp()).then(toFeatures, (error: unknown) => {
      // Not known: this read fails, and the index is asked again soon, not for the client's life.
      fresh.expiresAt = Date.now() + FAILURE_TTL_MS;
      throw error;
    }),
  };
  answers.set(ctx.runtime, fresh);
  return fresh.features;
};
