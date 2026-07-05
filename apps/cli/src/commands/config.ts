import { Console, Effect } from "effect";
import { Argument, Command } from "effect/unstable/cli";

import { CliConfigStoreService, CONFIG_KEYS, currentSettings } from "../config.js";
import { CliFailure } from "../errors.js";
import { isColorEnabled, makePalette, renderTable } from "../render.js";

const isHttpUrl = (value: string): boolean => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
};

const configSetCommand = Command.make(
  "set",
  {
    key: Argument.choice("key", CONFIG_KEYS),
    value: Argument.string("value"),
  },
  ({ key, value }) =>
    Effect.gen(function* () {
      const store = yield* CliConfigStoreService;
      const palette = makePalette(isColorEnabled());

      const trimmed = value.trim();
      if (trimmed === "") {
        return yield* Effect.fail(new CliFailure({ message: `${key} cannot be empty.` }));
      }
      if (key === "apiUrl" && !isHttpUrl(trimmed)) {
        return yield* Effect.fail(
          new CliFailure({
            message: `"${trimmed}" is not a valid http(s) URL.`,
            hint: "Example: sealant config set apiUrl http://localhost:4000",
          }),
        );
      }

      yield* store.write(key === "apiUrl" ? { apiUrl: trimmed } : { ownerUserId: trimmed });
      yield* Console.log(`${palette.green("✓")} Set ${palette.bold(key)} = ${trimmed}`);
      yield* Console.log(palette.dim(store.filePath));
    }),
).pipe(Command.withDescription("Set apiUrl or ownerUserId in the config file"));

const configShowCommand = Command.make("show", {}, () =>
  Effect.gen(function* () {
    const store = yield* CliConfigStoreService;
    const settings = yield* currentSettings;
    const palette = makePalette(isColorEnabled());

    // Nothing here is secret — this file only holds the API URL and owner user id.
    yield* Console.log(
      renderTable(
        ["KEY", "VALUE", "SOURCE"],
        [
          ["apiUrl", settings.apiUrl.value, palette.dim(settings.apiUrl.source)],
          ["ownerUserId", settings.ownerUserId.value, palette.dim(settings.ownerUserId.source)],
        ],
        palette,
      ),
    );
    yield* Console.log(palette.dim(`config file: ${store.filePath}`));
  }),
).pipe(Command.withDescription("Show the effective configuration and where each value comes from"));

export const configCommand = Command.make("config").pipe(
  Command.withDescription("Read and write the CLI configuration"),
  Command.withSubcommands([configSetCommand, configShowCommand]),
);
