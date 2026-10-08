/**
 * A process is asked to run as a Linux user only of a control plane that reports the as-user
 * routes (`features.processUserRoutes`), and only on them: a control plane from before them answers
 * `404` there, never runs the process as the workspace's own user. `features.processUser`, the flag
 * older SDKs read, is never consulted. The answer is read once per client (`readFeatures`).
 * Whether the workspace itself can is decided by the control plane, which asks the workspace's
 * sealantd and refuses (`409`, `user-unsupported`) where it cannot.
 */
import { SealantError } from "../errors.js";
import type { SdkContext } from "../facade/context.js";
import { readFeatures } from "./features.js";

export const requireProcessUser = async (ctx: SdkContext, user: string): Promise<void> => {
  const supported = await readFeatures(ctx).then(
    (features) => features.processUserRoutes,
    () => false,
  );
  if (!supported) {
    throw new SealantError(
      `This control plane cannot start a process as the Linux user '${user}' (it does not report the feature, or could not be asked); nothing was sent.`,
      { code: "user-unsupported" },
    );
  }
};
