import { Schema } from "effect";

const name = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,62}$/));
const port = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }));
const labels = Schema.Record(Schema.String, Schema.String).check(
  Schema.makeFilter((value) =>
    Object.keys(value).length > 0 ? undefined : "caller pod labels must not be empty",
  ),
);

/** Operator-owned caller endpoints. Requests name an entry, never a container or pod selector. */
export const resourceCallerConfigSchema = Schema.Array(
  Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("docker"),
      name,
      container: name,
      callbackPorts: Schema.Array(port).check(Schema.isMinLength(1)),
    }),
    Schema.Struct({
      kind: Schema.Literal("kubernetes"),
      name,
      namespace: name,
      host: Schema.String.check(Schema.isPattern(/^[a-z0-9.-]+$/)),
      podLabels: labels,
      callbackPorts: Schema.Array(port).check(Schema.isMinLength(1)),
    }),
  ]),
);
/** Parsed once at the composition boundary, shared by API and worker. */
export type ResourceCallerConfig = typeof resourceCallerConfigSchema.Type;
/** Invalid configuration fails startup; no request values appear in diagnostics. */
export const parseResourceCallers = (json: string): ResourceCallerConfig =>
  Schema.decodeUnknownSync(Schema.fromJsonString(resourceCallerConfigSchema))(json, {
    onExcessProperty: "error",
  });

/** Full UUID avoids the truncated identities used by legacy workspace resources. */
export const callerInstanceName = (id: string): string =>
  `coresvc-${id.replace(/^rin:/, "").replaceAll("-", "")}`;
