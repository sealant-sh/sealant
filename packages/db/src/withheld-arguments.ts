/**
 * Sealant never stores the arguments a process or session was started with: they can carry
 * secrets (a token a script writes, a file's bytes in base64, `env KEY=value`). What is kept is
 * how many there were and each one's length in UTF-8 bytes. The same rule, in SQL, is
 * `sealant_withhold_process_args` (migration `stored_arguments_withheld`), whose triggers enforce
 * it on `telemetry_events`, `telemetry_timeline`, `runs` and `workspace_sessions` for any writer.
 */
export interface WithheldArguments {
  readonly argCount: number;
  readonly argLengths: readonly number[];
}

/** The count and per-argument byte lengths that stand in for `args`. */
export const describeArguments = (args: readonly unknown[]): WithheldArguments => ({
  argCount: args.length,
  argLengths: args.map((arg) => Buffer.byteLength(String(arg), "utf8")),
});
