import { Console, Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";

import {
  ControlPlaneClientService,
  toApiSettings,
  type ApiSettings,
  type ControlPlaneClient,
} from "../api-client.js";
import { currentSettings } from "../config.js";
import { CliFailure } from "../errors.js";
import {
  accountDetails,
  isColorEnabled,
  makePalette,
  renderTable,
  statusCell,
  type Palette,
} from "../render.js";
import {
  CONNECTED_ACCOUNT_PROVIDERS,
  connectedAccountProviderSchema,
  type ConnectedAccountProvider,
  type ProfileCredentialBinding,
  type ProfileSummary,
} from "../schemas.js";

const NO_BINDING = "-";

/* ------------------------------ pure helpers (unit-tested) ------------------------------ */

export type ParsedClearList =
  | { readonly ok: true; readonly providers: ReadonlyArray<ConnectedAccountProvider> }
  | { readonly ok: false; readonly reason: string };

/** Parse `--clear claude,codex` into a deduplicated provider list. */
export const parseClearList = (raw: string): ParsedClearList => {
  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  if (entries.length === 0) {
    return { ok: false, reason: "--clear needs at least one provider (claude, codex, github)." };
  }
  const providers: Array<ConnectedAccountProvider> = [];
  for (const entry of entries) {
    const parsed = connectedAccountProviderSchema.safeParse(entry);
    if (!parsed.success) {
      return {
        ok: false,
        reason: `Unknown provider "${entry}" in --clear (expected claude, codex, or github).`,
      };
    }
    if (!providers.includes(parsed.data)) {
      providers.push(parsed.data);
    }
  }
  return { ok: true, providers };
};

/* ------------------------------------- shared pieces ------------------------------------- */

const resolveProfile = (
  profiles: ReadonlyArray<ProfileSummary>,
  reference: string,
): ProfileSummary | undefined =>
  profiles.find((profile) => profile.slug === reference || profile.profileId === reference);

const bindingsTable = (
  bindings: ReadonlyArray<ProfileCredentialBinding>,
  palette: Palette,
): string => {
  const rows = CONNECTED_ACCOUNT_PROVIDERS.map((provider) => {
    const binding = bindings.find((candidate) => candidate.provider === provider);
    return binding === undefined
      ? [provider, NO_BINDING, "", ""]
      : [
          provider,
          binding.account.name,
          statusCell(binding.account.status, palette),
          accountDetails(binding.account),
        ];
  });
  return renderTable(["PROVIDER", "ACCOUNT", "STATUS", "DETAILS"], rows, palette);
};

const profilesListCommand = Command.make("list", {}, () =>
  Effect.gen(function* () {
    const settings = yield* currentSettings;
    const client = yield* ControlPlaneClientService;
    const palette = makePalette(isColorEnabled());
    const api = toApiSettings(settings);

    const profiles = yield* client.listProfiles(api);
    if (profiles.length === 0) {
      yield* Console.log("No profiles yet.");
      yield* Console.log(
        palette.dim("Create one from the Sealant web app, then bind accounts here."),
      );
      return;
    }

    // One extra request per profile — fine at CLI scale.
    const rows: Array<Array<string>> = [];
    for (const profile of profiles) {
      const bindings = yield* client.listProfileCredentialBindings(api, profile.profileId);
      const byProvider = (provider: ConnectedAccountProvider): string => {
        const binding = bindings.find((candidate) => candidate.provider === provider);
        return binding === undefined ? NO_BINDING : binding.account.name;
      };
      rows.push([
        profile.name,
        profile.slug,
        statusCell(profile.status, palette),
        byProvider("claude"),
        byProvider("codex"),
        byProvider("github"),
      ]);
    }
    yield* Console.log(
      renderTable(["NAME", "SLUG", "STATUS", "CLAUDE", "CODEX", "GITHUB"], rows, palette),
    );
  }),
).pipe(Command.withDescription("List profiles and their credential bindings"));

const accountNameFlag = (provider: ConnectedAccountProvider) =>
  Flag.string(provider).pipe(
    Flag.optional,
    Flag.withDescription(`Name of the ${provider} account to bind`),
  );

const bindProvider = (
  client: ControlPlaneClient,
  api: ApiSettings,
  input: {
    readonly profileId: string;
    readonly provider: ConnectedAccountProvider;
    readonly accountName: string;
    readonly accounts: ReadonlyArray<{
      readonly connectedAccountId: string;
      readonly provider: ConnectedAccountProvider;
      readonly name: string;
      readonly status: string;
    }>;
  },
): Effect.Effect<unknown, CliFailure> => {
  const account = input.accounts.find(
    (candidate) =>
      candidate.provider === input.provider &&
      candidate.name === input.accountName &&
      candidate.status !== "archived",
  );
  if (account === undefined) {
    return Effect.fail(
      new CliFailure({
        message: `No ${input.provider} account named "${input.accountName}".`,
        hint: `Connect it first: sealant auth ${input.provider} --name ${input.accountName}`,
      }),
    );
  }
  return client.setProfileCredentialBinding(api, {
    profileId: input.profileId,
    provider: input.provider,
    connectedAccountId: account.connectedAccountId,
  });
};

const profilesBindCommand = Command.make(
  "bind",
  {
    profile: Argument.string("profile").pipe(
      Argument.withDescription("Profile slug or id (prof_…)"),
    ),
    claude: accountNameFlag("claude"),
    codex: accountNameFlag("codex"),
    github: accountNameFlag("github"),
    clear: Flag.string("clear").pipe(
      Flag.optional,
      Flag.withDescription("Comma-separated providers to unbind (e.g. --clear claude,codex)"),
    ),
  },
  ({ claude, clear, codex, github, profile }) =>
    Effect.gen(function* () {
      const settings = yield* currentSettings;
      const client = yield* ControlPlaneClientService;
      const palette = makePalette(isColorEnabled());
      const api = toApiSettings(settings);

      const requested: Array<{
        readonly provider: ConnectedAccountProvider;
        readonly accountName: string;
      }> = [];
      const flagByProvider = { claude, codex, github };
      for (const provider of CONNECTED_ACCOUNT_PROVIDERS) {
        const accountName = Option.getOrUndefined(flagByProvider[provider]);
        if (accountName !== undefined) {
          requested.push({ provider, accountName });
        }
      }

      let clears: ReadonlyArray<ConnectedAccountProvider> = [];
      const clearRaw = Option.getOrUndefined(clear);
      if (clearRaw !== undefined) {
        const parsed = parseClearList(clearRaw);
        if (!parsed.ok) {
          return yield* Effect.fail(new CliFailure({ message: parsed.reason }));
        }
        clears = parsed.providers;
      }

      if (requested.length === 0 && clears.length === 0) {
        return yield* Effect.fail(
          new CliFailure({
            message: "Nothing to do.",
            hint: "Pass at least one of --claude/--codex/--github <name>, or --clear <providers>.",
          }),
        );
      }
      const overlap = requested.find((entry) => clears.includes(entry.provider));
      if (overlap !== undefined) {
        return yield* Effect.fail(
          new CliFailure({
            message: `--${overlap.provider} and --clear ${overlap.provider} conflict — pick one.`,
          }),
        );
      }

      const profiles = yield* client.listProfiles(api);
      const target = resolveProfile(profiles, profile);
      if (target === undefined) {
        const slugs = profiles.map((candidate) => candidate.slug);
        return yield* Effect.fail(
          new CliFailure({
            message: `No profile matches "${profile}".`,
            hint:
              slugs.length > 0
                ? `Available profiles: ${slugs.join(", ")}.`
                : "No profiles exist yet — create one from the Sealant web app.",
          }),
        );
      }

      if (requested.length > 0) {
        const accounts = yield* client.listConnectedAccounts(api);
        for (const entry of requested) {
          yield* bindProvider(client, api, {
            profileId: target.profileId,
            provider: entry.provider,
            accountName: entry.accountName,
            accounts,
          });
        }
      }
      for (const provider of clears) {
        yield* client.setProfileCredentialBinding(api, {
          profileId: target.profileId,
          provider,
          connectedAccountId: null,
        });
      }

      const bindings = yield* client.listProfileCredentialBindings(api, target.profileId);
      yield* Console.log(
        `${palette.green("✓")} Updated bindings for ${palette.bold(target.name)} (${target.slug})`,
      );
      yield* Console.log(bindingsTable(bindings, palette));
    }),
).pipe(Command.withDescription("Bind connected accounts to a profile (one per provider)"));

export const profilesCommand = Command.make("profiles").pipe(
  Command.withDescription("Manage profiles and their credential bindings"),
  Command.withSubcommands([profilesListCommand, profilesBindCommand]),
);
