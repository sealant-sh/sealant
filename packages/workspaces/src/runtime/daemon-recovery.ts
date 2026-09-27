/**
 * Whether an executor's daemon can be restarted IN RECOVERY MODE on its own disk (review 3 #8).
 *
 * Recovery restarts a retained executor — one that ended with work its daemon never confirmed
 * saved — and asks sealantd for its recovery boot (`SEALANT_RECOVERY=1`, or the `/.sealantd-recovery`
 * marker): resume its own staging without materializing over it, no dotfiles, no lifecycle step,
 * no harness, admission closed. A daemon built before that boot existed ignores the request and
 * runs its ORDINARY boot: it restores the store's head over captures it staged and never shipped
 * and edits it never snapped, and runs the lifecycle steps and the harness again. Restarting such
 * an executor destroys exactly the work it was kept for.
 *
 * So the capability is recorded at launch, from the build of the daemon the workspace image
 * copied in (`COPY --from=<sealantd image> /usr/local/bin/sealantd`), and recovery restarts an
 * executor in place only when it is known to have the recovery boot. Unknown is not recoverable
 * in place (decision 9: fail closed): the executor is kept and reported.
 *
 * Every released sealantd reports `0.0.0` as its own version over the control protocol, so the
 * daemon cannot be asked; the image reference is the build identity. A released image
 * (`ghcr.io/sealant-sh/sealantd:X.Y.Z`) has the recovery boot from
 * `SEALANTD_RECOVERY_BOOT_MIN_VERSION` on. Any other image (a development build set with
 * `SEALANT_SEALANTD_IMAGE`) is known to have it only when the operator declares it, by listing it
 * in `SEALANT_SEALANTD_RECOVERY_BOOT_IMAGES` (comma-separated image references).
 */

/**
 * The first released sealantd with the recovery boot: the release of the sealantd capture stack
 * (#100) that carries `BootConfig::recovery` — the minor after 0.18.2.
 */
export const SEALANTD_RECOVERY_BOOT_MIN_VERSION = { major: 0, minor: 19, patch: 0 } as const;

const RELEASED_SEALANTD_IMAGE =
  /^ghcr\.io\/sealant-sh\/sealantd:(\d+)\.(\d+)\.(\d+)(?:@sha256:[0-9a-f]{64})?$/;

/** The planned Containerfile copies the daemon out of a sealantd image; which one. */
const SEALANTD_COPY =
  /^COPY .*--from=(\S+) \/usr\/local\/bin\/sealantd \/usr\/local\/bin\/sealantd\s*$/m;

/** The sealantd image a planned workspace Containerfile copies its daemon from. */
export const sealantdImageOfContainerfile = (containerfile: string): string | undefined =>
  SEALANTD_COPY.exec(containerfile)?.[1];

/** Image references the operator declares to have the recovery boot. */
export const declaredRecoveryBootImages = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): readonly string[] =>
  (env["SEALANT_SEALANTD_RECOVERY_BOOT_IMAGES"] ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

/**
 * Whether the daemon from `image` has sealantd's recovery boot: `true` / `false` when Core knows,
 * `null` when it cannot tell (no image, or an image that is neither released nor declared).
 */
export const sealantdHasRecoveryBoot = (
  image: string | undefined,
  declared: readonly string[] = declaredRecoveryBootImages(),
): boolean | null => {
  if (image === undefined) {
    return null;
  }
  if (declared.includes(image)) {
    return true;
  }
  const released = RELEASED_SEALANTD_IMAGE.exec(image);
  if (released === null) {
    return null;
  }
  const [major, minor, patch] = [released[1], released[2], released[3]].map(Number);
  const min = SEALANTD_RECOVERY_BOOT_MIN_VERSION;
  if (major === undefined || minor === undefined || patch === undefined) {
    return null;
  }
  if (major !== min.major) {
    return major > min.major;
  }
  if (minor !== min.minor) {
    return minor > min.minor;
  }
  return patch >= min.patch;
};
