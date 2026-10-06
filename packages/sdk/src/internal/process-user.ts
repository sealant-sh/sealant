/**
 * A process is asked to run as a Linux user only of a control plane that says it can: an older one
 * decodes the request without the field and would run the process as the workspace's own user.
 * The control plane's answer is read once per client (its index, `features.processUser`).
 */
import { getIndexOp } from "../effect/operations.js";
import { SealantError } from "../errors.js";
import type { SdkContext } from "../facade/context.js";

const answers = new WeakMap<SdkContext["runtime"], Promise<boolean>>();

export const requireProcessUser = async (ctx: SdkContext, user: string): Promise<void> => {
  const cached = answers.get(ctx.runtime);
  const supported =
    cached ??
    ctx.runtime
      .run(getIndexOp())
      .then((index) => index.features?.processUser === true)
      .catch(() => false);
  if (cached === undefined) answers.set(ctx.runtime, supported);
  if (!(await supported)) {
    throw new SealantError(
      `This control plane cannot start a process as the Linux user '${user}' (it does not report the feature); nothing was sent.`,
      { code: "user-unsupported" },
    );
  }
};
