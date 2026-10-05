/**
 * Writing a person's logins into one home of a running workspace (docs/connected-accounts-design.md
 * §6c). One home holds one person's logins; the files are owned by the home's owner, mode 0600, so
 * the person's own processes read them and nobody else's are pointed at them. One control-channel
 * exec per call writes and removes every file the call names: payloads go over stdin, never argv.
 */
import { randomBytes } from "node:crypto";

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
 * The marker a held home carries, `<home>/.sealant-logins`: the generation of the hold that wrote
 * it. Every write checks it in the executor, at the moment it runs, so a write that was issued under
 * one hold and arrives late (a timed-out exec the executor ran anyway) never lands in a home that
 * has since been released or taken by someone else.
 */
export const HOME_MARKER_FILE = ".sealant-logins";

const GENERATION_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/** A fresh generation for a hold. */
export const newHomeGeneration = (): string => randomBytes(16).toString("hex");

/** Which hold a write belongs to, checked against the home's marker in the executor. */
export type HomeWriteFence =
  /** The first write of a hold: the home must carry no marker; this write makes it. */
  | { readonly kind: "take"; readonly generation: string }
  /** A write under a hold: the marker must name this generation. */
  | { readonly kind: "held"; readonly generation: string }
  /** A release: removes every login file Core names, and the marker, whatever it says. */
  | { readonly kind: "release" };

export interface HomeCredentialScriptInput {
  readonly home: string;
  readonly fence: HomeWriteFence;
  /**
   * Make the home, owned by this uid and gid with mode 0700 and seeded from `/etc/skel`, when it
   * does not exist. Without it a missing home is refused (`missing`): a home is made by whoever
   * made its user.
   */
  readonly createWithOwner?: HomeOwner;
  /** Files to write, each a provider's login (already the copy Core injects), in stdin order. */
  readonly writes: readonly HomeCredentialProvider[];
  /** Providers whose login file is removed (a release removes them all). */
  readonly removes: readonly HomeCredentialProvider[];
}

/** Exit codes the script answers a refusal with. */
export const HOME_SCRIPT_EXIT = {
  /** A component of the home's path, or a directory Core writes in, is a symbolic link. */
  linkOnTheWay: 73,
  /** The home does not exist, or is not a directory. */
  missing: 74,
  /** stdin ended before every payload was read. */
  shortPayload: 75,
  /** The home's marker does not match this write's hold: released or taken since it was issued. */
  fenced: 76,
} as const;

const quote = (value: string): string => `'${value}'`;

/** The base64 payload lines a script reads, one per write, in order. */
export const homeScriptStdin = (contents: readonly string[]): string =>
  contents.map((content) => `${Buffer.from(content, "utf8").toString("base64")}\n`).join("");

/**
 * The shell script that writes and removes one home's login files. Paths are validated before they
 * reach it (`homePathProblem`; the relative paths are Core's own), so single quotes suffice.
 *
 * - No component of the home's path may be a symbolic link: a root write through one could land
 *   anywhere. Inside a home that is not root's, the directories Core writes in may not be links
 *   either. In root's home (the shared layout links `~/.claude` into the saved harness home) an
 *   existing directory is used as it is. A link at the file's own name is removed, never followed.
 * - The fence is checked before anything is written (see `HOME_MARKER_FILE`).
 * - Every directory the script makes, and every file, belongs to the home's owner; files are 0600.
 */
export const buildHomeCredentialScript = (input: HomeCredentialScriptInput): string => {
  const problem = homePathProblem(input.home);
  if (problem !== undefined) {
    throw new Error(`Refusing to write credentials into '${input.home}': ${problem}`);
  }
  if (input.fence.kind !== "release" && !GENERATION_PATTERN.test(input.fence.generation)) {
    throw new Error("A home's generation is 8 to 64 letters, digits, '_' or '-'.");
  }
  const home = input.home;
  const lines: string[] = [
    "set -eu",
    "umask 077",
    `home=${quote(home)}`,
    `m="$home/${HOME_MARKER_FILE}"`,
    "p=",
  ];
  for (const segment of home.split("/").slice(1)) {
    lines.push(`p="$p/${segment}"; if [ -L "$p" ]; then exit ${HOME_SCRIPT_EXIT.linkOnTheWay}; fi`);
  }
  if (input.createWithOwner === undefined) {
    lines.push(`if [ ! -d "$home" ]; then exit ${HOME_SCRIPT_EXIT.missing}; fi`);
  } else {
    const { uid, gid } = input.createWithOwner;
    if (!Number.isInteger(uid) || uid < 0 || !Number.isInteger(gid) || gid < 0) {
      throw new Error("A home's owner is a non-negative integer uid and gid.");
    }
    // Seeded from /etc/skel as useradd -m would (it copies nothing into a home that exists).
    lines.push(
      `if [ ! -e "$home" ]; then (umask 022; mkdir -p "$(dirname "$home")"); mkdir -m 700 "$home"; if [ -d /etc/skel ]; then cp -a /etc/skel/. "$home"/; fi; chown -R ${uid}:${gid} "$home"; fi`,
      `if [ ! -d "$home" ]; then exit ${HOME_SCRIPT_EXIT.missing}; fi`,
    );
  }
  lines.push(`owner=$(stat -c %u:%g "$home")`);
  switch (input.fence.kind) {
    case "take":
      lines.push(
        `if [ -e "$m" ] || [ -L "$m" ]; then exit ${HOME_SCRIPT_EXIT.fenced}; fi`,
        `printf '%s' ${quote(input.fence.generation)} > "$m"; chown "$owner" "$m"`,
      );
      break;
    case "held":
      lines.push(
        `if [ -L "$m" ] || [ "$(cat "$m" 2>/dev/null || true)" != ${quote(input.fence.generation)} ]; then exit ${HOME_SCRIPT_EXIT.fenced}; fi`,
      );
      break;
    case "release":
      break;
  }

  for (const provider of input.writes) {
    const relative = HOME_CREDENTIAL_FILES[provider];
    const directories = relative.split("/").slice(0, -1);
    let directory = "$home";
    for (const segment of directories) {
      directory = `${directory}/${segment}`;
      lines.push(
        `if [ -L "${directory}" ]; then case "$owner" in 0:*) ;; *) exit ${HOME_SCRIPT_EXIT.linkOnTheWay} ;; esac; elif [ ! -e "${directory}" ]; then mkdir -m 700 "${directory}"; chown "$owner" "${directory}"; fi`,
      );
    }
    // Written in place, as a launch writes it: a temporary file beside it could be saved by a
    // capture where the directory is linked into the saved harness home (the shared layout).
    lines.push(
      // A last payload with no newline after it still reads.
      `IFS= read -r payload || [ -n "$payload" ] || exit ${HOME_SCRIPT_EXIT.shortPayload}`,
      `f="$home/${relative}"`,
      `if [ -L "$f" ]; then rm -f "$f"; fi`,
      `printf '%s' "$payload" | base64 -d > "$f"`,
      `chmod 600 "$f"; chown "$owner" "$f"`,
    );
  }
  const removes =
    input.fence.kind === "release"
      ? (Object.keys(HOME_CREDENTIAL_FILES) as HomeCredentialProvider[])
      : input.removes;
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
      return `A component of ${home} is a symbolic link; Core writes logins only into a home reached without one.`;
    case HOME_SCRIPT_EXIT.missing:
      return `${home} does not exist in the workspace, or is not a directory. Make the home (its user) first.`;
    case HOME_SCRIPT_EXIT.fenced:
      return `${home} carries another hold's marker: it was released or taken since this write was issued, or an earlier write landed there. Release it first.`;
    default:
      return undefined;
  }
};
