/**
 * Writing a person's logins into one home of a running workspace (docs/connected-accounts-design.md
 * §6c). One home holds one person's logins; the files are owned by the home's owner, mode 0600, so
 * the person's own processes read them and nobody else's are pointed at them. One control-channel
 * exec per call writes and removes every file the call names: payloads go over stdin, never argv.
 */
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

export interface HomeCredentialScriptInput {
  readonly home: string;
  /**
   * Make the home, owned by this uid and gid with mode 0700, when it does not exist. Without it a
   * missing home is refused (`home-missing`): a home is made by whoever made its user.
   */
  readonly createWithOwner?: HomeOwner;
  /** Files to write, each a provider's login (already the copy Core injects). */
  readonly writes: readonly {
    readonly provider: HomeCredentialProvider;
    readonly content: string;
  }[];
  /** Providers whose login file is removed. */
  readonly removes: readonly HomeCredentialProvider[];
}

/** The script, and the stdin it reads its payloads from (one base64 line per write, in order). */
export interface HomeCredentialScript {
  readonly script: string;
  readonly stdin: string;
}

/** Exit codes the script answers a refusal with. */
export const HOME_SCRIPT_EXIT = {
  /** A component of the home's path is a symbolic link. */
  linkOnTheWay: 73,
  /** The home does not exist, or is not a directory. */
  missing: 74,
  /** stdin ended before every payload was read. */
  shortPayload: 75,
} as const;

const quote = (value: string): string => `'${value}'`;

/**
 * The shell script that writes and removes one home's login files. Paths are validated before they
 * reach it (`homePathProblem`; the relative paths are Core's own), so single quotes suffice.
 *
 * - No component of the home's path may be a symbolic link: a root write through one could land
 *   anywhere. Inside the home, an existing directory is used as it is (the shared layout links
 *   `~/.claude`), and a link at the file's own name is removed before the write, never followed.
 * - Every directory the script makes, and every file, belongs to the home's owner; files are 0600.
 */
export const buildHomeCredentialScript = (
  input: HomeCredentialScriptInput,
): HomeCredentialScript => {
  const problem = homePathProblem(input.home);
  if (problem !== undefined) {
    throw new Error(`Refusing to write credentials into '${input.home}': ${problem}`);
  }
  const home = input.home;
  const lines: string[] = ["set -eu", "umask 077", `home=${quote(home)}`, "p="];
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
    lines.push(
      `if [ ! -e "$home" ]; then mkdir -p "$(dirname "$home")"; mkdir -m 700 "$home"; chown ${uid}:${gid} "$home"; fi`,
      `if [ ! -d "$home" ]; then exit ${HOME_SCRIPT_EXIT.missing}; fi`,
    );
  }
  lines.push(`owner=$(stat -c %u:%g "$home")`);

  const stdin: string[] = [];
  for (const write of input.writes) {
    const relative = HOME_CREDENTIAL_FILES[write.provider];
    const directories = relative.split("/").slice(0, -1);
    let directory = "$home";
    for (const segment of directories) {
      directory = `${directory}/${segment}`;
      lines.push(
        `if [ ! -e "${directory}" ] && [ ! -L "${directory}" ]; then mkdir -m 700 "${directory}"; chown "$owner" "${directory}"; fi`,
      );
    }
    // Written in place, as a launch writes it: a temporary file beside it could be saved by a
    // capture where the directory is linked into the saved harness home (the shared layout).
    lines.push(
      `IFS= read -r payload || exit ${HOME_SCRIPT_EXIT.shortPayload}`,
      `f="$home/${relative}"`,
      `if [ -L "$f" ]; then rm -f "$f"; fi`,
      `printf '%s' "$payload" | base64 -d > "$f"`,
      `chmod 600 "$f"; chown "$owner" "$f"`,
    );
    stdin.push(Buffer.from(write.content, "utf8").toString("base64"));
  }
  for (const provider of input.removes) {
    lines.push(`rm -f "$home/${HOME_CREDENTIAL_FILES[provider]}"`);
  }
  return { script: lines.join("\n"), stdin: stdin.map((line) => `${line}\n`).join("") };
};

/** How a script run ended: its exit code, or `undefined` when no exit was observed. */
export interface HomeScriptExit {
  readonly exitCode: number | undefined;
}

/** Runs one home script in a workspace (the API's put and release, and the refresh push). */
export interface HomeCredentialChannel {
  readonly run: (target: SealantTarget, script: HomeCredentialScript) => Promise<HomeScriptExit>;
}

/** The live channel: one exec over the executor's control connection, payloads on stdin. */
export const liveHomeCredentialChannel: HomeCredentialChannel = {
  run: (target, script) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* SealantRuntime;
          const session = yield* runtime.connect(target);
          const accepted = yield* session.exec({
            executable: "sh",
            args: ["-c", script.script],
            stdin: true,
          });
          if (script.stdin.length > 0) {
            yield* session.writeStdin(accepted.processId, Buffer.from(script.stdin, "utf8"));
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
    ),
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
    default:
      return undefined;
  }
};
