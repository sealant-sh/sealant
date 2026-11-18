/**
 * pacman's fall back to the next mirror covers a package but not its signature. When a package
 * download stalls (less than 1 byte/s for 10 seconds) or fails, pacman resumes it from the next
 * `Server` line. When the package arrives, pacman fetches `<that URL>.sig` from the mirror that
 * just served it, with no other server to fall back to. If that mirror stalls on the signature,
 * the transaction fails before it installs anything: "failed retrieving file '….sig' from
 * dk.mirror.archlinuxarm.org : Operation too slow", then "failed to commit transaction" (CI on
 * arm64, November 2026). Every mirror at the head of the list serves most signatures, so its stall
 * fails every build until it recovers. pacman 7.1 behaves the same with `XferCommand`, and no
 * pacman.conf option changes it.
 *
 * A failed transaction is therefore run again with the first mirror moved to the end. The files
 * that did arrive are in the pacman cache, so the next attempt fetches only what is missing; a
 * cached package without its signature is fetched again with it. The mirrorlist is put back as it
 * was once the transaction succeeds, so the image ships the list it was built with.
 */

export const PACMAN_MIRRORLIST = "/etc/pacman.d/mirrorlist";

export interface PacmanMirrorFallbackOptions {
  /** The mirrorlist pacman reads. */
  readonly mirrorlist: string;
  /** How many times the transaction may run, the first mirror moved last after each failure. */
  readonly attempts: number;
}

const DEFAULT_FALLBACK: PacmanMirrorFallbackOptions = {
  mirrorlist: PACMAN_MIRRORLIST,
  // An image's mirrorlist names several mirrors: three attempts start from three different ones.
  attempts: 3,
};

/**
 * `transaction` (shell running one or more pacman commands), run until it succeeds or has failed
 * {@link PacmanMirrorFallbackOptions.attempts} times; then the shell exits 1. One brace group, so
 * it chains with `&&` in a `RUN`.
 */
export const renderPacmanWithMirrorFallback = (
  transaction: string,
  options: Partial<PacmanMirrorFallbackOptions> = {},
): string => {
  const { mirrorlist, attempts } = { ...DEFAULT_FALLBACK, ...options };
  const saved = `${mirrorlist}.sealant`;
  const next = `${mirrorlist}.sealant-next`;
  return [
    `{ cp ${mirrorlist} ${saved} && attempt=1 && until ${transaction}; do`,
    `if [ "$attempt" -ge ${attempts} ]; then echo "sealant: pacman failed ${attempts} times, each from a different first mirror" >&2; exit 1; fi;`,
    `attempt=$((attempt + 1));`,
    `echo "sealant: pacman failed; attempt $attempt starts from the next mirror, $(grep -m1 '^Server' ${mirrorlist}) moved last" >&2;`,
    `awk '/^Server/ && first == "" { first = $0; next } { print } END { if (first != "") print first }' ${mirrorlist} > ${next} && cat ${next} > ${mirrorlist} && rm ${next};`,
    `done && cat ${saved} > ${mirrorlist} && rm ${saved}; }`,
  ].join(" ");
};
