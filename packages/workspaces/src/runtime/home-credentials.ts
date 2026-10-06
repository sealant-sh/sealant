/**
 * Writing a person's logins into one home of a running workspace (docs/connected-accounts-design.md
 * §6c). One home holds one person's logins; the files are owned by the home's owner, mode 0600, so
 * the person's own processes read them and nobody else's are pointed at them. One control-channel
 * exec per call writes and removes every file the call names: payloads go over stdin, never argv.
 */
import { createHash, randomBytes } from "node:crypto";

import type { EventEnvelope } from "@sealant/runtime-protocol";
import { Effect, Option, Stream } from "effect";

import {
  SealantRuntime,
  SealantRuntimeControlLive,
  type SealantTarget,
} from "../sealantd/runtime.js";

/** The providers a home holds logins for. */
export type HomeCredentialProvider = "claude" | "codex" | "github";

/** Where each provider's login lives, relative to the home. */
export const HOME_CREDENTIAL_FILES: Readonly<Record<HomeCredentialProvider, string>> = {
  claude: ".claude/.credentials.json",
  codex: ".codex/auth.json",
  github: ".config/gh/hosts.yml",
};

/** A home's absolute path inside the executor, as the caller names it. */
const HOME_PATTERN = /^(\/[A-Za-z0-9._-]+)+$/;

/**
 * Why `home` cannot be a home, or `undefined` when it can: an absolute, normalised path (no `.`
 * or `..` segment, no empty segment, no trailing slash) of safe characters, never `/` and never
 * under `/workspace` (the worktree and the saved harness home, which captures save).
 */
export const homePathProblem = (home: string): string | undefined => {
  if (!HOME_PATTERN.test(home)) {
    return "A home is an absolute path of letters, digits, '.', '_', '-' and '/'.";
  }
  const segments = home.split("/").slice(1);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return "A home is a normalised path, with no '.' or '..' segment.";
  }
  if (segments[0] === "workspace") {
    return "A home is never under /workspace: everything there is saved with the workspace.";
  }
  return undefined;
};

/** The owner a created home is given (create-time homes; a later write takes the directory's). */
export interface HomeOwner {
  readonly uid: number;
  readonly gid: number;
}

/**
 * Where the executor keeps each home's hold, outside every home and every capture root, root's
 * only: `<dir>/<key>.generation` holds the generation of the hold that wrote it, and
 * `<dir>/<key>.lock` is the lock every write into the home takes. A person cannot remove their own
 * home's marker by cleaning their home, and nobody but root can forge one.
 */
export const HOME_STATE_DIR = "/run/sealant-homes";

/** The file name stem a home's marker and lock share. */
export const homeStateKey = (home: string): string =>
  createHash("sha256").update(home, "utf8").digest("hex").slice(0, 32);

const GENERATION_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/** A fresh generation for a hold. */
export const newHomeGeneration = (): string => randomBytes(16).toString("hex");

/**
 * Which hold a write belongs to, checked against the home's marker in the executor, under the
 * home's lock, together with the write itself: nothing can change the marker between the check and
 * the write, and a write that runs late (a timed-out exec the executor ran anyway) either still
 * belongs to the hold or writes nothing.
 */
export type HomeWriteFence =
  /**
   * The first write of a hold: the home must carry no marker, or this generation's (a launch that
   * is delivered again writes again); this write makes it.
   */
  | { readonly kind: "take"; readonly generation: string }
  /** A write under a hold: the marker must name this generation. */
  | { readonly kind: "held"; readonly generation: string }
  /**
   * A release: removes every login file Core names, and the marker, when the marker is absent or
   * names `generation`. Without one (a home Core holds no record of) it removes them whatever the
   * marker says.
   */
  | { readonly kind: "release"; readonly generation?: string };

export interface HomeCredentialScriptInput {
  readonly home: string;
  readonly fence: HomeWriteFence;
  /**
   * Make the home, owned by this uid and gid with mode 0700 and seeded from the skeleton, when it
   * does not exist. Without it a missing home is refused (`missing`).
   */
  readonly createWithOwner?: HomeOwner;
  /** The directory a created home is seeded from (default `/etc/skel`; absolute, safe characters). */
  readonly skel?: string;
  /** Files to write, each a provider's login (already the copy Core injects), in stdin order. */
  readonly writes: readonly HomeCredentialProvider[];
  /** Providers whose login file is removed (a release removes them all). */
  readonly removes: readonly HomeCredentialProvider[];
  /** How long the script waits for another write into the same home (default 20 s). */
  readonly lockWaitSeconds?: number;
  /** Where markers and locks live (default `HOME_STATE_DIR`; absolute, safe characters). */
  readonly stateDir?: string;
}

/** Exit codes the script answers a refusal with. */
export const HOME_SCRIPT_EXIT = {
  /** A component of the home's path is a link, or a login directory links outside the home. */
  linkOnTheWay: 73,
  /** The home does not exist, or is not a directory. */
  missing: 74,
  /** stdin ended before every payload was read. */
  shortPayload: 75,
  /** The home's marker does not match this write's hold: released or taken since it was issued. */
  fenced: 76,
  /** The image has no `flock`. */
  noLock: 77,
  /** Another write into the home held its lock for too long. */
  busy: 78,
} as const;

const quote = (value: string): string => `'${value}'`;

/** The base64 payload lines a script reads, one per write, in order. */
export const homeScriptStdin = (contents: readonly string[]): string =>
  contents.map((content) => `${Buffer.from(content, "utf8").toString("base64")}\n`).join("");

/**
 * The shell script that writes and removes one home's login files, in one exec. Paths are
 * validated before they reach it (`homePathProblem`; the relative paths are Core's own), so single
 * quotes suffice.
 *
 * 1. Every payload is read before anything is checked: a script whose stdin arrives late decides
 *    only once it has all of it, under the lock.
 * 2. No component of the home's path may be a link.
 * 3. The home's lock (`flock`) is held from the fence check to the last write, so a release or a
 *    take of the home runs wholly before or wholly after this write.
 * 4. In a home that is not root's, a login directory that is a link must lead inside the home (a
 *    dotfiles checkout's `.claude`, say), never out of it into someone else's; root's home keeps the
 *    shared layout's links. A link at a file's own name is removed, never followed.
 * 5. Every directory the script makes, and every file, belongs to the home's owner; files are 0600.
 */
export const buildHomeCredentialScript = (input: HomeCredentialScriptInput): string => {
  const problem = homePathProblem(input.home);
  if (problem !== undefined) {
    throw new Error(`Refusing to write credentials into '${input.home}': ${problem}`);
  }
  const generation = input.fence.generation;
  if (generation !== undefined && !GENERATION_PATTERN.test(generation)) {
    throw new Error("A home's generation is 8 to 64 letters, digits, '_' or '-'.");
  }
  const wait = input.lockWaitSeconds ?? 20;
  if (!Number.isInteger(wait) || wait < 0) {
    throw new Error("A lock wait is a non-negative whole number of seconds.");
  }
  const home = input.home;
  const key = homeStateKey(home);
  const stateDir = input.stateDir ?? HOME_STATE_DIR;
  if (!HOME_PATTERN.test(stateDir)) {
    throw new Error(`A state directory is an absolute path of safe characters: '${stateDir}'.`);
  }
  const lines: string[] = ["set -eu", "umask 077", `home=${quote(home)}`];

  // 1. Every payload first.
  input.writes.forEach((_, index) => {
    lines.push(
      `IFS= read -r p${index} || [ -n "$p${index}" ] || exit ${HOME_SCRIPT_EXIT.shortPayload}`,
    );
  });

  // 2. No link on the way to the home.
  lines.push("p=");
  for (const segment of home.split("/").slice(1)) {
    lines.push(`p="$p/${segment}"; if [ -L "$p" ]; then exit ${HOME_SCRIPT_EXIT.linkOnTheWay}; fi`);
  }

  // 3. The home's lock, held to the end.
  lines.push(
    `command -v flock >/dev/null 2>&1 || exit ${HOME_SCRIPT_EXIT.noLock}`,
    `st=${quote(stateDir)}; (umask 022; mkdir -p "$st"); chmod 700 "$st"`,
    `m="$st/${key}.generation"`,
    `exec 9>"$st/${key}.lock"`,
    `flock -w ${wait} 9 || exit ${HOME_SCRIPT_EXIT.busy}`,
  );

  if (input.createWithOwner === undefined) {
    lines.push(`if [ ! -d "$home" ]; then exit ${HOME_SCRIPT_EXIT.missing}; fi`);
  } else {
    const { uid, gid } = input.createWithOwner;
    if (!Number.isInteger(uid) || uid < 0 || !Number.isInteger(gid) || gid < 0) {
      throw new Error("A home's owner is a non-negative integer uid and gid.");
    }
    const skel = input.skel ?? "/etc/skel";
    if (!HOME_PATTERN.test(skel)) {
      throw new Error(`A skeleton directory is an absolute path of safe characters: '${skel}'.`);
    }
    // `cp -a skel/. home/` also gives the home the skeleton's own mode: 0700 is set after it.
    lines.push(
      `if [ ! -e "$home" ]; then (umask 022; mkdir -p "$(dirname "$home")"); mkdir -m 700 "$home"; if [ -d ${quote(skel)} ]; then cp -a ${quote(skel)}/. "$home"/; fi; chmod 700 "$home"; chown -R ${uid}:${gid} "$home"; fi`,
      `if [ ! -d "$home" ]; then exit ${HOME_SCRIPT_EXIT.missing}; fi`,
    );
  }
  lines.push(`owner=$(stat -c %u:%g "$home")`, `held=; if [ -f "$m" ]; then held=$(cat "$m"); fi`);

  // The fence, under the lock.
  switch (input.fence.kind) {
    case "take":
      lines.push(
        `if [ -n "$held" ] && [ "$held" != ${quote(input.fence.generation)} ]; then exit ${HOME_SCRIPT_EXIT.fenced}; fi`,
      );
      break;
    case "held":
      lines.push(
        `if [ "$held" != ${quote(input.fence.generation)} ]; then exit ${HOME_SCRIPT_EXIT.fenced}; fi`,
      );
      break;
    case "release":
      if (input.fence.generation !== undefined) {
        lines.push(
          `if [ -n "$held" ] && [ "$held" != ${quote(input.fence.generation)} ]; then exit ${HOME_SCRIPT_EXIT.fenced}; fi`,
        );
      }
      break;
  }

  const removes =
    input.fence.kind === "release"
      ? (Object.keys(HOME_CREDENTIAL_FILES) as HomeCredentialProvider[])
      : input.removes.filter((provider) => !input.writes.includes(provider));

  // 4. The login directories: a link leads inside the home, or the home is root's.
  const directories = new Set<string>();
  for (const provider of [...input.writes, ...removes]) {
    const segments = HOME_CREDENTIAL_FILES[provider].split("/").slice(0, -1);
    segments.forEach((_, index) => directories.add(segments.slice(0, index + 1).join("/")));
  }
  for (const directory of [...directories].toSorted()) {
    lines.push(
      `d="$home/${directory}"; if [ -L "$d" ]; then case "$owner" in 0:*) ;; *) t=$(readlink -f "$d" || true); case "$t" in "$home"/*) [ -d "$t" ] || exit ${HOME_SCRIPT_EXIT.linkOnTheWay} ;; *) exit ${HOME_SCRIPT_EXIT.linkOnTheWay} ;; esac ;; esac; fi`,
    );
  }

  if (input.fence.kind === "take") {
    lines.push(`printf '%s' ${quote(input.fence.generation)} > "$m"`);
  }

  // 5. The writes.
  input.writes.forEach((provider, index) => {
    const relative = HOME_CREDENTIAL_FILES[provider];
    let directory = "$home";
    for (const segment of relative.split("/").slice(0, -1)) {
      directory = `${directory}/${segment}`;
      lines.push(
        `if [ ! -e "${directory}" ] && [ ! -L "${directory}" ]; then mkdir -m 700 "${directory}"; chown "$owner" "${directory}"; fi`,
      );
    }
    // Written in place, as a launch writes it: a temporary file beside it could be saved by a
    // capture where the directory is linked into the saved harness home (the shared layout).
    lines.push(
      `f="$home/${relative}"`,
      `if [ -L "$f" ]; then rm -f "$f"; fi`,
      `printf '%s' "$p${index}" | base64 -d > "$f"`,
      `chmod 600 "$f"; chown "$owner" "$f"`,
    );
  });
  for (const provider of removes) {
    lines.push(`rm -f "$home/${HOME_CREDENTIAL_FILES[provider]}"`);
  }
  if (input.fence.kind === "release") {
    lines.push(`rm -f "$m"`);
  }
  return lines.join("\n");
};

/** Which provider's login a path relative to a home is, if it is one Core writes. */
export const homeCredentialProviderOf = (relative: string): HomeCredentialProvider | undefined =>
  (Object.keys(HOME_CREDENTIAL_FILES) as HomeCredentialProvider[]).find(
    (provider) => HOME_CREDENTIAL_FILES[provider] === relative,
  );

/** How a script run ended: its exit code, or `undefined` when no exit was observed. */
export interface HomeScriptExit {
  readonly exitCode: number | undefined;
}

/**
 * Runs one home script in a workspace (the API's put and release, and the refresh push), in the
 * caller's fiber: interrupting it (a timeout) closes the control session, so a script that has not
 * been handed its stdin yet never runs, and one already running is fenced by the home's marker.
 */
export interface HomeCredentialChannel {
  readonly run: (
    target: SealantTarget,
    script: string,
    stdin: string,
  ) => Effect.Effect<HomeScriptExit, unknown>;
}

/** The live channel: one exec over the executor's control connection, payloads on stdin. */
export const liveHomeCredentialChannel: HomeCredentialChannel = {
  run: (target, script, stdin) =>
    Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* SealantRuntime;
        const session = yield* runtime.connect(target);
        const accepted = yield* session.exec({
          executable: "sh",
          args: ["-c", script],
          stdin: true,
        });
        if (stdin.length > 0) {
          yield* session.writeStdin(accepted.processId, Buffer.from(stdin, "utf8"));
        }
        yield* session.closeStdin(accepted.processId);
        const exit = yield* session.events.pipe(
          Stream.filter((event: EventEnvelope) => event.processId === accepted.processId),
          Stream.filter((event: EventEnvelope) => event.payload.case === "processExited"),
          Stream.take(1),
          Stream.runHead,
        );
        return {
          exitCode:
            Option.isSome(exit) && exit.value.payload.case === "processExited"
              ? exit.value.payload.value.exitCode
              : undefined,
        } satisfies HomeScriptExit;
      }),
    ).pipe(Effect.provide(SealantRuntimeControlLive)),
};

/** A refusal the script answered with, in words, or `undefined` for success or another failure. */
export const homeScriptRefusal = (
  home: string,
  exitCode: number | undefined,
): string | undefined => {
  switch (exitCode) {
    case HOME_SCRIPT_EXIT.linkOnTheWay:
      return `A component of ${home} is a symbolic link, or one of its login directories links outside it; Core writes logins only into a home reached without one, and keeps them inside it.`;
    case HOME_SCRIPT_EXIT.missing:
      return `${home} does not exist in the workspace, or is not a directory. Make the home (its user) first.`;
    case HOME_SCRIPT_EXIT.fenced:
      return `${home} carries another hold's marker: it was released or taken since this write was issued, or an earlier write landed there. Release it first.`;
    case HOME_SCRIPT_EXIT.busy:
      return `Another write into ${home} held it for too long; try again.`;
    case HOME_SCRIPT_EXIT.noLock:
      return `The workspace's image has no flock, which every write into a home takes.`;
    default:
      return undefined;
  }
};
