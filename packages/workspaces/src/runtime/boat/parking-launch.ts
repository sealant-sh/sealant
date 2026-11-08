import { Effect, Redacted } from "effect";
import { z } from "zod";

const launch = z.strictObject({
  format: z.literal("sealant-daemon-launch-v1"),
  boot_env: z.record(z.string(), z.string()),
});
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
export const parkingResumeLaunch = (
  original: Redacted.Redacted<Uint8Array>,
  credentials: Redacted.Redacted<z.infer<typeof capture>>,
) =>
  Effect.try({
    try: () => {
      const source = launch.parse(
        JSON.parse(Buffer.from(Redacted.value(original)).toString("utf8")),
      );
      const fresh = capture.parse(Redacted.value(credentials));
      if (
        source.boot_env.SEALANT_WORKSPACE_SOURCE !== "capture" ||
        source.boot_env.SEALANT_CAPTURE_LAUNCH_ID !== fresh.launchId ||
        source.boot_env.SEALANT_CAPTURE_WORKTREE_ID !== fresh.worktreeId
      )
        throw new BoatParkingLaunchError();
      const env = Object.fromEntries(
        Object.entries(source.boot_env).filter(
          ([key]) =>
            key !== "SEALANT_CAPTURE_TOKEN" &&
            !/^(SEALANT_DOTFILES_|SEALANT_HARNESS_|SEALANT_FOREGROUND_|SEALANT_LIFECYCLE_)/.test(
              key,
            ),
        ),
      );
      return Redacted.make({
        launch: Buffer.from(
          JSON.stringify({
            format: source.format,
            boot_env: {
              ...env,
              SEALANT_CAPTURE_ENDPOINT: fresh.endpoint,
              SEALANT_SECRET_ENV_FILE: "/run/sealant-inputs/secret-env",
              SEALANT_CAPTURE_LAUNCH_ID: fresh.launchId,
              SEALANT_CAPTURE_WORKTREE_ID: fresh.worktreeId,
              SEALANT_LIFECYCLE_SETUP_JSON: "[]",
              SEALANT_LIFECYCLE_STARTUP_JSON: "[]",
              SEALANT_FOREGROUND_COMMAND: "sleep infinity",
            },
          }),
        ),
        secretEnv: Buffer.from(JSON.stringify({ SEALANT_CAPTURE_TOKEN: fresh.token })),
      });
    },
    catch: () => new BoatParkingLaunchError(),
  });
