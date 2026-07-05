import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Context, Effect, Layer, Option } from "effect";
import { Flag, GlobalFlag } from "effect/unstable/cli";

import { CliFailure, describeUnknown } from "./errors.js";

/* ------------------------------------------------------------------------------------------------
 * Pure config resolution (unit-tested in config.test.ts)
 * ---------------------------------------------------------------------------------------------- */

export interface CliConfigFile {
  readonly apiUrl?: string;
  readonly ownerUserId?: string;
}

export type SettingSource = "flag" | "env" | "config" | "default";

export interface ResolvedSetting {
  readonly value: string;
  readonly source: SettingSource;
}

export interface ResolvedSettings {
  readonly apiUrl: ResolvedSetting;
  readonly ownerUserId: ResolvedSetting;
}

export const DEFAULT_API_URL = "http://localhost:4000";
export const DEFAULT_OWNER_USER_ID = "usr_local";
export const API_URL_ENV_VAR = "SEALANT_API_URL";
export const OWNER_USER_ID_ENV_VAR = "SEALANT_OWNER_USER_ID";

export const CONFIG_KEYS = ["apiUrl", "ownerUserId"] as const;
export type ConfigKey = (typeof CONFIG_KEYS)[number];

/** `~/.config/sealant/config.json`, honoring `XDG_CONFIG_HOME`. */
export const configFilePath = (
  env: Readonly<Record<string, string | undefined>>,
  homeDirectory: string,
): string => {
  const configHome = env.XDG_CONFIG_HOME?.trim();
  const base =
    configHome !== undefined && configHome !== ""
      ? configHome
      : path.join(homeDirectory, ".config");
  return path.join(base, "sealant", "config.json");
};

export type ParsedConfigFile =
  | { readonly ok: true; readonly config: CliConfigFile }
  | { readonly ok: false; readonly reason: string };

/** Lenient parse: unknown keys are ignored, non-string values are dropped. */
export const parseConfigFile = (contents: string): ParsedConfigFile => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return { ok: false, reason: "not valid JSON" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "expected a JSON object" };
  }
  const record: Record<string, unknown> = { ...parsed };
  const config: { apiUrl?: string; ownerUserId?: string } = {};
  if (typeof record.apiUrl === "string" && record.apiUrl.trim() !== "") {
    config.apiUrl = record.apiUrl.trim();
  }
  if (typeof record.ownerUserId === "string" && record.ownerUserId.trim() !== "") {
    config.ownerUserId = record.ownerUserId.trim();
  }
  return { ok: true, config };
};

const pickSetting = (
  candidates: ReadonlyArray<{ readonly source: SettingSource; readonly value: string | undefined }>,
  fallback: string,
): ResolvedSetting => {
  for (const candidate of candidates) {
    if (typeof candidate.value === "string" && candidate.value.trim() !== "") {
      return { value: candidate.value.trim(), source: candidate.source };
    }
  }
  return { value: fallback, source: "default" };
};

/** Precedence: flag > env > config file > built-in default. */
export const resolveSettings = (input: {
  readonly flags: { readonly apiUrl: string | undefined; readonly ownerUserId: string | undefined };
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly file: CliConfigFile;
}): ResolvedSettings => ({
  apiUrl: pickSetting(
    [
      { source: "flag", value: input.flags.apiUrl },
      { source: "env", value: input.env[API_URL_ENV_VAR] },
      { source: "config", value: input.file.apiUrl },
    ],
    DEFAULT_API_URL,
  ),
  ownerUserId: pickSetting(
    [
      { source: "flag", value: input.flags.ownerUserId },
      { source: "env", value: input.env[OWNER_USER_ID_ENV_VAR] },
      { source: "config", value: input.file.ownerUserId },
    ],
    DEFAULT_OWNER_USER_ID,
  ),
});

/* ------------------------------------------------------------------------------------------------
 * Config store service (contract first, live layer below — house rules)
 * ---------------------------------------------------------------------------------------------- */

export interface CliConfigStore {
  readonly filePath: string;
  readonly read: Effect.Effect<CliConfigFile, CliFailure>;
  readonly write: (patch: Partial<CliConfigFile>) => Effect.Effect<CliConfigFile, CliFailure>;
}

export class CliConfigStoreService extends Context.Service<CliConfigStoreService, CliConfigStore>()(
  "@sealant/cli/CliConfigStoreService",
) {}

const errnoCode = (cause: unknown): string | undefined =>
  cause instanceof Error && "code" in cause && typeof cause.code === "string"
    ? cause.code
    : undefined;

const makeCliConfigStore = (): CliConfigStore => {
  const filePath = configFilePath(process.env, os.homedir());

  const load = async (): Promise<CliConfigFile> => {
    let contents: string;
    try {
      contents = await fs.readFile(filePath, "utf8");
    } catch (cause) {
      if (errnoCode(cause) === "ENOENT") {
        return {};
      }
      throw cause;
    }
    const parsed = parseConfigFile(contents);
    if (!parsed.ok) {
      throw new CliFailure({
        message: `Could not read ${filePath}: ${parsed.reason}.`,
        hint: "Fix or delete the file, then re-run.",
      });
    }
    return parsed.config;
  };

  const wrap = <A>(run: () => Promise<A>, action: string): Effect.Effect<A, CliFailure> =>
    Effect.tryPromise({
      try: run,
      catch: (cause) =>
        cause instanceof CliFailure
          ? cause
          : new CliFailure({
              message: `Could not ${action} ${filePath}: ${describeUnknown(cause)}.`,
            }),
    });

  return {
    filePath,
    read: wrap(load, "read"),
    write: (patch) =>
      wrap(async () => {
        const current = await load();
        const next = { ...current, ...patch };
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
        return next;
      }, "write"),
  };
};

export const CliConfigStoreLive: Layer.Layer<CliConfigStoreService> = Layer.sync(
  CliConfigStoreService,
  makeCliConfigStore,
);

/* ------------------------------------------------------------------------------------------------
 * Global flags (--api-url / --owner) + per-invocation settings resolution
 * ---------------------------------------------------------------------------------------------- */

export const ApiUrlFlag = GlobalFlag.setting("api-url")({
  flag: Flag.string("api-url").pipe(
    Flag.optional,
    Flag.withDescription(
      `Control-plane API URL (env ${API_URL_ENV_VAR}; default ${DEFAULT_API_URL})`,
    ),
  ),
});

export const OwnerFlag = GlobalFlag.setting("owner")({
  flag: Flag.string("owner").pipe(
    Flag.optional,
    Flag.withDescription(
      `Owner user id (env ${OWNER_USER_ID_ENV_VAR}; default ${DEFAULT_OWNER_USER_ID})`,
    ),
  ),
});

/** Effective settings for the current invocation: global flags > env > config file > defaults. */
export const currentSettings = Effect.gen(function* () {
  const store = yield* CliConfigStoreService;
  const apiUrlFlag = yield* ApiUrlFlag;
  const ownerFlag = yield* OwnerFlag;
  const file = yield* store.read;
  return resolveSettings({
    flags: {
      apiUrl: Option.getOrUndefined(apiUrlFlag),
      ownerUserId: Option.getOrUndefined(ownerFlag),
    },
    env: process.env,
    file,
  });
});
