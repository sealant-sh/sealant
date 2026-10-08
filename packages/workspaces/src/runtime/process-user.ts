/**
 * A process started as a person's Linux user (Mend's ADR 0016 decision 1; sealantd#147): `user` on
 * an exec or a session goes to sealantd's `ExecArgs.user` / `OpenSessionArgs.user`, and the daemon
 * starts the process as exactly that passwd entry (uid, primary and supplementary groups, `HOME`,
 * `USER`, `LOGNAME`, `SHELL`, umask 0002, a private `TMPDIR` and `XDG_RUNTIME_DIR`), applies the
 * image's `/etc/sealant/person-env`, withholds the daemon's logins and `SEALANT_*` keys, and gives
 * it `CAP_FOWNER` only where no-new-privileges is unset. Core decides only WHETHER a process may be
 * started as the user, before anything starts:
 *
 * 1. **The name** (`processUserProblem`, no I/O): a login name or a decimal uid, never root, and a
 *    uid outside Mend's range is refused before the executor is asked.
 * 2. **The daemon** (`liveProcessUserChannel.check`, one control connection): its capabilities must
 *    name `exec.user`. An older sealantd ignores the field and would run the process as root.
 * 3. **The passwd entry** (the same connection, one exec as root, `buildProcessUserCheckScript`):
 *    the user exists, their uid is in 40001–49999 and their primary group is `mend` (40000). So a
 *    process is never started as root, as an image's own user, or as anyone outside the people Mend
 *    made. Which person is which is Mend's to name; Core keeps every person inside the range.
 *
 * A request without `user` takes none of these steps.
 */
import {
  CAPTURE_OWNER_MAP_GID,
  CAPTURE_OWNER_MAP_UID_RANGE,
} from "@sealant/api-contracts/capture-owner-map";
import type { EventEnvelope } from "@sealant/runtime-protocol";
import { Effect, Option, Stream } from "effect";

import {
  SealantRuntime,
  SealantRuntimeControlLive,
  type SealantTarget,
} from "../sealantd/runtime.js";

/** The capability a daemon names when it starts executions and sessions as a user. */
export const PROCESS_USER_CAPABILITY = "exec.user";

/** The uids a process may be started as: Mend's people (the reserved range less the group's id). */
export const PROCESS_USER_UID_RANGE = CAPTURE_OWNER_MAP_UID_RANGE;

/** The primary group every person has: `mend`. */
export const PROCESS_USER_GID = CAPTURE_OWNER_MAP_GID;

/** A Linux user as the API takes it: a login name or a decimal uid. */
const USER_PATTERN = /^(?:[a-z_][a-z0-9_-]{0,31}|[0-9]{1,10})$/;

const RANGE_TEXT = `${String(PROCESS_USER_UID_RANGE.first)}–${String(PROCESS_USER_UID_RANGE.last)}`;

/** What a process may be started as, in words: the end of every range refusal. */
export const PROCESS_USER_RANGE_RULE = `a process runs as another user only for a uid in ${RANGE_TEXT} whose primary group is mend (${String(PROCESS_USER_GID)}), never root`;

/** Exit codes the check script answers with. */
export const PROCESS_USER_CHECK_EXIT = {
  /** No passwd entry names the user. */
  unknownUser: 90,
  /** The user's uid is outside the range (root included). */
  uidOutOfRange: 95,
  /** The user's primary group is not `mend`. */
  groupNotMend: 96,
  /** The image has no `getent`, so the passwd entry cannot be read the way the daemon reads it. */
  noGetent: 97,
} as const;

/** Why a process is not started as the user. */
export type ProcessUserRefusalReason =
  /** The workspace's runtime has no daemon Core can ask (Cloudflare's sandboxes). */
  | "runtime-unsupported"
  /** The daemon does not report `exec.user`. */
  | "sealantd-unsupported"
  /** The user is root, or their uid or primary group is outside Mend's range. */
  | "not-in-range"
  /** No passwd entry names the user. */
  | "unknown-user"
  /** The image cannot answer the check (no `getent`). */
  | "check-unavailable";

export interface ProcessUserRefusal {
  readonly reason: ProcessUserRefusalReason;
  /** What was found, in words (no trailing period). */
  readonly detail: string;
}

/**
 * Why `user` is refused before the executor is asked; `undefined` when the executor must answer.
 * Root by name or uid, and a uid outside the range, are refused here.
 */
export const processUserProblem = (user: string): ProcessUserRefusal | undefined => {
  if (!USER_PATTERN.test(user)) {
    return {
      reason: "not-in-range",
      detail: "a user is a login name (lower-case letters, digits, '_' and '-') or a decimal uid",
    };
  }
  if (user === "root") {
    return { reason: "not-in-range", detail: "it is root" };
  }
  if (/^[0-9]+$/.test(user)) {
    const uid = Number(user);
    if (uid < PROCESS_USER_UID_RANGE.first || uid > PROCESS_USER_UID_RANGE.last) {
      return { reason: "not-in-range", detail: `uid ${String(uid)} is outside ${RANGE_TEXT}` };
    }
  }
  return undefined;
};

/** Where the check looks for `getent` and `cut`. */
const SYSTEM_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/**
 * The script that checks the user's passwd entry, as root, in one exec: it exists (`getent`, so
 * the same lookup the daemon makes), its uid is in the range and its primary group is `mend`. It
 * answers only with its exit code ({@link PROCESS_USER_CHECK_EXIT}), and prints nothing.
 */
export const buildProcessUserCheckScript = (
  user: string,
  /** For tests: directories searched before the fixed system PATH. */
  options: { readonly prependPath?: string } = {},
): string => {
  const problem = processUserProblem(user);
  if (
    options.prependPath !== undefined &&
    !/^(\/[A-Za-z0-9._/-]+)(:\/[A-Za-z0-9._/-]+)*$/.test(options.prependPath)
  ) {
    throw new Error("A prepended PATH is absolute directories of safe characters.");
  }
  if (problem !== undefined) {
    throw new Error(`Refusing to check '${user}' as a process user: ${problem.detail}.`);
  }
  const E = PROCESS_USER_CHECK_EXIT;
  return [
    "set -eu",
    // A fixed PATH, not whatever root's environment carries: getent and cut from the system.
    `PATH=${options.prependPath === undefined ? "" : `${options.prependPath}:`}${SYSTEM_PATH}`,
    `user=${quote(user)}`,
    // Without getent a failed lookup would read as an unknown user: say what is missing instead.
    `command -v getent >/dev/null 2>&1 || exit ${String(E.noGetent)}`,
    `ent=$(getent passwd "$user") || exit ${String(E.unknownUser)}`,
    `[ -n "$ent" ] || exit ${String(E.unknownUser)}`,
    "uid=$(printf '%s' \"$ent\" | cut -d: -f3); gid=$(printf '%s' \"$ent\" | cut -d: -f4)",
    `case "$uid" in ''|*[!0-9]*) exit ${String(E.uidOutOfRange)};; esac`,
    `if [ "$uid" -lt ${String(PROCESS_USER_UID_RANGE.first)} ] || [ "$uid" -gt ${String(PROCESS_USER_UID_RANGE.last)} ]; then exit ${String(E.uidOutOfRange)}; fi`,
    `[ "$gid" = ${String(PROCESS_USER_GID)} ] || exit ${String(E.groupNotMend)}`,
  ].join("\n");
};

/** What the executor answered: whether its daemon starts processes as a user, and the check. */
export interface ProcessUserCheck {
  /** The daemon's capabilities name `exec.user`; when not, nothing was run. */
  readonly supported: boolean;
  /** The check script's exit code, or `undefined` when no exit was observed (or nothing ran). */
  readonly exitCode: number | undefined;
}

/**
 * The refusal an executor's answer means; `undefined` when the user may run (`ok`) or the answer
 * says nothing (`unanswered`: no exit observed, or another exit, which the caller reports as the
 * executor not confirming the check).
 */
export const processUserCheckOutcome = (
  check: ProcessUserCheck,
): ProcessUserRefusal | "ok" | "unanswered" => {
  if (!check.supported) {
    return {
      reason: "sealantd-unsupported",
      detail: `its sealantd does not report ${PROCESS_USER_CAPABILITY}`,
    };
  }
  switch (check.exitCode) {
    case 0:
      return "ok";
    case PROCESS_USER_CHECK_EXIT.unknownUser:
      return { reason: "unknown-user", detail: "no passwd entry names it: make the user first" };
    case PROCESS_USER_CHECK_EXIT.uidOutOfRange:
      return { reason: "not-in-range", detail: `its uid is outside ${RANGE_TEXT}` };
    case PROCESS_USER_CHECK_EXIT.groupNotMend:
      return {
        reason: "not-in-range",
        detail: `its primary group is not mend (${String(PROCESS_USER_GID)})`,
      };
    case PROCESS_USER_CHECK_EXIT.noGetent:
      return {
        reason: "check-unavailable",
        detail: "its image has no getent, so Core cannot read the user's passwd entry",
      };
    default:
      return "unanswered";
  }
};

/** The check over the executor's control connection, in the caller's fiber. */
export interface ProcessUserChannel {
  readonly check: (target: SealantTarget, user: string) => Effect.Effect<ProcessUserCheck, unknown>;
}

/** The live channel: one connection per call; the capability read and the check share it. */
export const liveProcessUserChannel: ProcessUserChannel = {
  check: (target, user) =>
    Effect.scoped(
      Effect.gen(function* () {
        const script = buildProcessUserCheckScript(user);
        const runtime = yield* SealantRuntime;
        const session = yield* runtime.connect(target);
        const capabilities = yield* session.capabilities;
        if (!capabilities.supports.includes(PROCESS_USER_CAPABILITY)) {
          return { supported: false, exitCode: undefined } satisfies ProcessUserCheck;
        }
        const accepted = yield* session.exec({ executable: "sh", args: ["-c", script] });
        const exit = yield* session.events.pipe(
          Stream.filter((event: EventEnvelope) => event.processId === accepted.processId),
          Stream.filter((event: EventEnvelope) => event.payload.case === "processExited"),
          Stream.take(1),
          Stream.runHead,
        );
        const exitCode =
          Option.isSome(exit) && exit.value.payload.case === "processExited"
            ? exit.value.payload.value.exitCode
            : undefined;
        return { supported: true, exitCode } satisfies ProcessUserCheck;
      }),
    ).pipe(Effect.provide(SealantRuntimeControlLive)),
};
