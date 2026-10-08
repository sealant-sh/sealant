/**
 * A person's dotfiles applied into their home of a RUNNING workspace, as their Linux user
 * (docs/connected-accounts-design.md §6g; Mend's ADR 0016 decision 11). sealantd's `dotfiles.apply`
 * does the applying: the repository clone, chezmoi, stow or copy, then each tree's bootstrap
 * (`./install.sh`) as one managed process of that user. Core does what comes before it and after:
 *
 * 1. **The check and the staging, in one exec as root** (`buildDotfilesStageScript`): the user must
 *    exist, must not be root (uid 0) or in root's group, and their passwd home must be the home the
 *    caller named, an existing directory of theirs reached without a symbolic link. Archives are
 *    then written into a fresh directory under `/run/sealant-dotfiles`, root's only (0700), as the
 *    manifest and `<index>.tar.gz` files `dotfiles.apply` reads (the same contract as a launch's
 *    `SEALANT_DOTFILES_ARCHIVE_DIR`). The bytes go over stdin, never argv.
 * 2. **The apply** (the worker, `dotfiles.apply` with the run's id as the execution, so the
 *    bootstrap's output is recorded in that run).
 * 3. **The cleanup** (`buildDotfilesCleanupScript`): the staged directory is removed once the apply
 *    answers. A staged directory older than an hour (a job that never ran) goes at the next stage.
 *
 * sealantd itself refuses root, a user in root's group and, from 0.20.0-next.154 (sealantd#151,
 * #152), anyone who is neither one of its owner map's people nor in Mend's reserved range (a uid in
 * 40001–49999 whose primary group is 40000), and applies only into the user's passwd
 * home. The clone, chezmoi, stow, the `copy` manager and the bootstrap run as the user
 * (`sealant_process::identity`), and every read and write inside the home is the user's
 * (sealantd#149, 0.20.0-next.152 and later): root unpacks each archive, without owners, into a
 * root-only directory outside every home, after refusing a member that is not a file, a directory
 * or a link or that leaves the archive, and hands each file to a writer that runs as the user. A
 * link the person planted (`~/.config -> /home/other/.config`) is followed as them, so it reaches
 * only what they can write; a link into another person's 0700 home fails the apply. An archive that
 * unpacks to more than 256 MiB, or 64 MiB in one file, is refused (sealantd#150).
 */
import type { EventEnvelope } from "@sealant/runtime-protocol";
import { Effect, Option, Stream } from "effect";

import {
  SealantRuntime,
  SealantRuntimeControlLive,
  type SealantSession,
  type SealantTarget,
} from "../sealantd/runtime.js";
import { homePathProblem } from "./home-credentials.js";
import { buildDotfilesArchiveManifest } from "./launch-material.js";

/** The capability a daemon names when it applies dotfiles as a user (`dotfiles.apply`). */
export const DOTFILES_USER_CAPABILITY = "dotfiles.user";

/** Where staged archives live in the executor, root's only, outside every home and capture root. */
export const DOTFILES_STAGE_DIR = "/run/sealant-dotfiles";

/** A Linux user as the API takes it: a login name or a decimal uid. */
const USER_PATTERN = /^(?:[a-z_][a-z0-9_-]{0,31}|[0-9]{1,10})$/;

/** A staging directory's name: the run's id. */
const STAGE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Exit codes the stage script answers a refusal with. */
export const DOTFILES_STAGE_EXIT = {
  /** stdin ended before every payload was read. */
  shortPayload: 75,
  /** No passwd entry names the user. */
  unknownUser: 90,
  /** The user is root (uid 0) or their primary group is root's. */
  rootUser: 91,
  /** The user's passwd home is not the home the caller named. */
  homeMismatch: 92,
  /** The home does not exist, is not a directory, is not the user's, or a link is on the way. */
  homeUnusable: 93,
  /** The staging directory is a link or not root's. */
  stageUnusable: 94,
} as const;

/** One archive as the stage script writes it: what the manifest says about it, and its bytes. */
export interface DotfilesStageArchive {
  /** base64 of a `.tar.gz`. */
  readonly data: string;
  readonly manager?: "auto" | "chezmoi" | "stow" | "copy";
  readonly target?: "home" | "config";
  readonly bootstrap: boolean;
  readonly bootstrapCommand?: string;
}

export interface DotfilesStageScriptInput {
  /** The user to apply as (a login name or a decimal uid). */
  readonly user: string;
  /** The home the caller expects: it must be the user's passwd home. */
  readonly home: string;
  /** The staging directory's name (the run's id); required when there are archives. */
  readonly stageId?: string;
  /** How many archives stdin carries (the manifest first, then each archive), in order. */
  readonly archiveCount: number;
  /** Where staged archives live (default `DOTFILES_STAGE_DIR`; absolute, safe characters). */
  readonly stageDir?: string;
  /** For tests: the uid a staging directory must belong to (default 0, root). */
  readonly stageOwnerUid?: number;
}

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/** Why `user` cannot be applied as, before anything reaches the executor; `undefined` when it can. */
export const dotfilesUserProblem = (user: string): string | undefined => {
  if (!USER_PATTERN.test(user)) {
    return "A user is a login name (lower-case letters, digits, '_' and '-') or a decimal uid.";
  }
  if (user === "root" || /^0+$/.test(user)) {
    return "Dotfiles are never applied as root: name the person's own user.";
  }
  return undefined;
};

/** The base64 lines the stage script reads: the manifest, then each archive's bytes, in order. */
export const dotfilesStageStdin = (archives: readonly DotfilesStageArchive[]): string => {
  if (archives.length === 0) return "";
  const manifest = `${JSON.stringify(
    buildDotfilesArchiveManifest(
      archives.map((archive) => ({
        // The manifest needs only the metadata; the data rides its own line.
        data: "",
        ...(archive.manager === undefined ? {} : { manager: archive.manager }),
        ...(archive.target === undefined ? {} : { target: archive.target }),
        bootstrap: archive.bootstrap,
        ...(archive.bootstrapCommand === undefined
          ? {}
          : { bootstrapCommand: archive.bootstrapCommand }),
      })),
    ),
  )}\n`;
  return [Buffer.from(manifest, "utf8").toString("base64"), ...archives.map((a) => a.data)]
    .map((line) => `${line}\n`)
    .join("");
};

/**
 * The script that checks the user and the home and stages the archives, as root, in one exec. It
 * reads stdin whole into the staging directory first (a line of several MB is read faster from a
 * file than by `read`), then splits it.
 */
export const buildDotfilesStageScript = (input: DotfilesStageScriptInput): string => {
  const userProblem = dotfilesUserProblem(input.user);
  if (userProblem !== undefined) {
    throw new Error(`Refusing to apply dotfiles as '${input.user}': ${userProblem}`);
  }
  const homeProblem = homePathProblem(input.home);
  if (homeProblem !== undefined) {
    throw new Error(`Refusing to apply dotfiles into '${input.home}': ${homeProblem}`);
  }
  if (!Number.isInteger(input.archiveCount) || input.archiveCount < 0 || input.archiveCount > 4) {
    throw new Error("A dotfiles apply stages 0 to 4 archives.");
  }
  const stageDir = input.stageDir ?? DOTFILES_STAGE_DIR;
  if (!/^(\/[A-Za-z0-9._-]+)+$/.test(stageDir)) {
    throw new Error(`A staging directory is an absolute path of safe characters: '${stageDir}'.`);
  }
  if (
    input.archiveCount > 0 &&
    (input.stageId === undefined || !STAGE_ID_PATTERN.test(input.stageId))
  ) {
    throw new Error("Staged archives need a staging id of letters, digits, '_' or '-'.");
  }
  const stageOwner = input.stageOwnerUid ?? 0;
  if (!Number.isInteger(stageOwner) || stageOwner < 0) {
    throw new Error("A staging owner is a non-negative integer uid.");
  }
  const E = DOTFILES_STAGE_EXIT;
  const lines: string[] = [
    "set -eu",
    "umask 077",
    `user=${quote(input.user)}`,
    `home=${quote(input.home)}`,
    // The user: their passwd entry, never root, and their home the one named.
    `ent=$(getent passwd "$user") || exit ${E.unknownUser}`,
    `[ -n "$ent" ] || exit ${E.unknownUser}`,
    `uid=$(printf '%s' "$ent" | cut -d: -f3); gid=$(printf '%s' "$ent" | cut -d: -f4); dir=$(printf '%s' "$ent" | cut -d: -f6)`,
    `if [ "$uid" = 0 ] || [ "$gid" = 0 ]; then exit ${E.rootUser}; fi`,
    `[ "$dir" = "$home" ] || exit ${E.homeMismatch}`,
  ];
  // The home: no link on the way, a directory, and the user's own.
  lines.push("p=");
  for (const segment of input.home.split("/").slice(1)) {
    lines.push(`p="$p/${segment}"; if [ -L "$p" ]; then exit ${E.homeUnusable}; fi`);
  }
  lines.push(
    `[ -d "$home" ] || exit ${E.homeUnusable}`,
    `[ "$(stat -c %u "$home")" = "$uid" ] || exit ${E.homeUnusable}`,
  );
  if (input.archiveCount > 0 && input.stageId !== undefined) {
    lines.push(
      `st=${quote(stageDir)}`,
      `if [ -L "$st" ]; then exit ${E.stageUnusable}; fi`,
      `(umask 077; mkdir -p "$st")`,
      `[ "$(stat -c %u "$st")" = ${stageOwner} ] || exit ${E.stageUnusable}`,
      `chmod 700 "$st"`,
      // What a job that never ran left behind.
      `find "$st" -mindepth 1 -maxdepth 1 -mmin +60 -exec rm -rf {} + 2>/dev/null || true`,
      `d="$st/${input.stageId}"`,
      `rm -rf "$d"; mkdir -m 700 "$d"`,
      `cat > "$d/stdin"`,
      `[ "$(wc -l < "$d/stdin")" -ge ${input.archiveCount + 1} ] || { rm -rf "$d"; exit ${E.shortPayload}; }`,
      `sed -n 1p "$d/stdin" | base64 -d > "$d/manifest.json"`,
    );
    for (let index = 0; index < input.archiveCount; index += 1) {
      lines.push(`sed -n ${index + 2}p "$d/stdin" | base64 -d > "$d/${index}.tar.gz"`);
    }
    lines.push(`rm -f "$d/stdin"`);
  }
  return lines.join("\n");
};

/** The staged directory a run's archives are in, as `dotfiles.apply` takes it. */
export const dotfilesStagePath = (
  stageId: string,
  stageDir: string = DOTFILES_STAGE_DIR,
): string => {
  if (!STAGE_ID_PATTERN.test(stageId)) {
    throw new Error("A staging id is letters, digits, '_' or '-'.");
  }
  return `${stageDir}/${stageId}`;
};

/** Removes a staged directory (idempotent). */
export const buildDotfilesCleanupScript = (
  stageId: string,
  stageDir: string = DOTFILES_STAGE_DIR,
): string => `rm -rf -- ${quote(dotfilesStagePath(stageId, stageDir))}`;

/** A refusal the stage script answered with, in words, or `undefined` for success or another failure. */
export const dotfilesStageRefusal = (
  input: { readonly user: string; readonly home: string },
  exitCode: number | undefined,
): { readonly code: DotfilesStageRefusalCode; readonly message: string } | undefined => {
  switch (exitCode) {
    case DOTFILES_STAGE_EXIT.unknownUser:
      return {
        code: "user-unknown",
        message: `No user '${input.user}' exists in the workspace. Make the user first.`,
      };
    case DOTFILES_STAGE_EXIT.rootUser:
      return {
        code: "user-root",
        message: `'${input.user}' is root, or in root's group: dotfiles are applied only as a person's own user.`,
      };
    case DOTFILES_STAGE_EXIT.homeMismatch:
      return {
        code: "home-mismatch",
        message: `${input.home} is not '${input.user}'s home in the workspace: dotfiles go only into the user's own passwd home.`,
      };
    case DOTFILES_STAGE_EXIT.homeUnusable:
      return {
        code: "home-unusable",
        message: `${input.home} does not exist, is not a directory, is not '${input.user}'s, or is reached through a symbolic link.`,
      };
    case DOTFILES_STAGE_EXIT.stageUnusable:
      return {
        code: "home-unusable",
        message: `The workspace's ${DOTFILES_STAGE_DIR} is a symbolic link or not root's; nothing was staged.`,
      };
    default:
      return undefined;
  }
};

export type DotfilesStageRefusalCode =
  | "user-unknown"
  | "user-root"
  | "home-mismatch"
  | "home-unusable";

/** What staging found: whether the daemon applies dotfiles as a user, and the script's exit. */
export interface DotfilesStageResult {
  /** The daemon's capabilities name `dotfiles.user`; when not, nothing was run. */
  readonly supported: boolean;
  /** The stage script's exit code, or `undefined` when no exit was observed (or nothing ran). */
  readonly exitCode: number | undefined;
}

/**
 * Staging and cleanup over the executor's control connection (the API's apply, the worker's
 * cleanup), in the caller's fiber: interrupting it closes the connection.
 */
export interface DotfilesStageChannel {
  readonly stage: (
    target: SealantTarget,
    script: string,
    stdin: string,
  ) => Effect.Effect<DotfilesStageResult, unknown>;
  readonly run: (
    target: SealantTarget,
    script: string,
  ) => Effect.Effect<number | undefined, unknown>;
}

/** stdin goes in pieces well under the control channel's 8 MiB frame. */
const STDIN_CHUNK_BYTES = 1024 * 1024;

const runScript = (session: SealantSession, script: string, stdin: string) =>
  Effect.gen(function* () {
    const bytes = Buffer.from(stdin, "utf8");
    const accepted = yield* session.exec({
      executable: "sh",
      args: ["-c", script],
      stdin: bytes.length > 0,
    });
    if (bytes.length > 0) {
      // A refusal exits before it reads stdin: a write or close the daemon answers for a process
      // that has already exited is not a failure, the exit code below is the answer.
      const feed = Effect.gen(function* () {
        for (let offset = 0; offset < bytes.length; offset += STDIN_CHUNK_BYTES) {
          yield* session.writeStdin(
            accepted.processId,
            bytes.subarray(offset, Math.min(bytes.length, offset + STDIN_CHUNK_BYTES)),
          );
        }
        yield* session.closeStdin(accepted.processId);
      });
      yield* feed.pipe(Effect.catchTag("SealantControlError", () => Effect.void));
    }
    const exit = yield* session.events.pipe(
      Stream.filter((event: EventEnvelope) => event.processId === accepted.processId),
      Stream.filter((event: EventEnvelope) => event.payload.case === "processExited"),
      Stream.take(1),
      Stream.runHead,
    );
    return Option.isSome(exit) && exit.value.payload.case === "processExited"
      ? exit.value.payload.value.exitCode
      : undefined;
  });

/** The live channel: one connection per call; the capability read and the stage share it. */
export const liveDotfilesStageChannel: DotfilesStageChannel = {
  stage: (target, script, stdin) =>
    Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* SealantRuntime;
        const session = yield* runtime.connect(target);
        const capabilities = yield* session.capabilities;
        if (!capabilities.supports.includes(DOTFILES_USER_CAPABILITY)) {
          return { supported: false, exitCode: undefined } satisfies DotfilesStageResult;
        }
        const exitCode = yield* runScript(session, script, stdin);
        return { supported: true, exitCode } satisfies DotfilesStageResult;
      }),
    ).pipe(Effect.provide(SealantRuntimeControlLive)),
  run: (target, script) =>
    Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* SealantRuntime;
        const session = yield* runtime.connect(target);
        return yield* runScript(session, script, "");
      }),
    ).pipe(Effect.provide(SealantRuntimeControlLive)),
};
