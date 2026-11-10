import { Effect, Redacted } from "effect";
import { z } from "zod";

import { SECRET_ENV_FILE_PATH } from "../microvm/agent-contract.js";

const bootEnvSchema = z.record(z.string(), z.string());
const capture = z.strictObject({
  endpoint: z.string().url(),
  token: z.string().min(1),
  worktreeId: z.string().min(1),
  launchId: z.string().min(1),
});

/** A resume continues the kept disk. It never replays setup, startup, dotfiles or the old harness. */
export class BoatParkingLaunchError extends Error {
  readonly _tag = "BoatParkingLaunchError";
  constructor() {
    super("Boat parking resume: invalid capture lineage");
  }
}
/** The boot environment of a restored VM's launch, from the original's; the token travels apart. */
export const parkingResumeLaunch = (
  original: Redacted.Redacted<Readonly<Record<string, string>>>,
  credentials: Redacted.Redacted<z.infer<typeof capture>>,
) =>
  Effect.try({
    try: () => {
      const source = bootEnvSchema.parse(Redacted.value(original));
      const fresh = capture.parse(Redacted.value(credentials));
      if (
        source["SEALANT_WORKSPACE_SOURCE"] !== "capture" ||
        source["SEALANT_CAPTURE_LAUNCH_ID"] !== fresh.launchId ||
        source["SEALANT_CAPTURE_WORKTREE_ID"] !== fresh.worktreeId
      )
        throw new BoatParkingLaunchError();
      const env = Object.fromEntries(
        Object.entries(source).filter(
          ([key]) =>
            key !== "SEALANT_CAPTURE_TOKEN" &&
            !/^(SEALANT_DOTFILES_|SEALANT_HARNESS_|SEALANT_FOREGROUND_|SEALANT_LIFECYCLE_)/.test(
              key,
            ),
        ),
      );
      return Redacted.make<Readonly<Record<string, string>>>({
        ...env,
        SEALANT_CAPTURE_ENDPOINT: fresh.endpoint,
        SEALANT_SECRET_ENV_FILE: SECRET_ENV_FILE_PATH,
        SEALANT_CAPTURE_LAUNCH_ID: fresh.launchId,
        SEALANT_CAPTURE_WORKTREE_ID: fresh.worktreeId,
        SEALANT_LIFECYCLE_SETUP_JSON: "[]",
        SEALANT_LIFECYCLE_STARTUP_JSON: "[]",
        SEALANT_FOREGROUND_COMMAND: "sleep infinity",
      });
    },
    catch: () => new BoatParkingLaunchError(),
  });
