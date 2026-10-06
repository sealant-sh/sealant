/**
 * A process is asked to run as a Linux user only of a control plane that says it can: an older one
 * decodes the request without the field and would run the process as the workspace's own user.
 * The control plane's answer is read once per client (its index, `features.processUser`).
 */
import { getIndexOp } from "../effect/operations.js";
import { SealantError } from "../errors.js";
import type { SdkContext } from "../facade/context.js";

/** How long an answer is kept: an upgraded control plane is noticed within this. */
const ANSWER_TTL_MS = 5 * 60_000;
/** How long a failed read is kept before it is tried again. */
const FAILURE_TTL_MS = 15_000;

const answers = new WeakMap<
  SdkContext["runtime"],
  { readonly supported: Promise<boolean>; expiresAt: number }
>();

export const requireProcessUser = async (ctx: SdkContext, user: string): Promise<void> => {
  const now = Date.now();
  const cached = answers.get(ctx.runtime);
  const entry =
    cached !== undefined && cached.expiresAt > now
      ? cached
      : (() => {
          const fresh = {
            expiresAt: now + ANSWER_TTL_MS,
            supported: ctx.runtime.run(getIndexOp()).then(
              (index) => index.features?.processUser === true,
              () => {
                // Not known: refuse this call, and ask again soon rather than for the client's life.
                fresh.expiresAt = Date.now() + FAILURE_TTL_MS;
                return false;
              },
            ),
          };
          answers.set(ctx.runtime, fresh);
          return fresh;
        })();
  if (!(await entry.supported)) {
    throw new SealantError(
      `This control plane cannot start a process as the Linux user '${user}' (it does not report the feature, or could not be asked); nothing was sent.`,
      { code: "user-unsupported" },
    );
  }
};
