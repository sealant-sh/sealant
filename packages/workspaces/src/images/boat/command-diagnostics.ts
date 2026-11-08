import { stripVTControlCharacters } from "node:util";

import { z } from "zod";

import type { BoatCommand } from "../../runtime/boat/api.js";
import { boatProviderFailureSchema } from "../../runtime/boat/config.js";

const outputBytes = 4096;
const printable = (raw: string): string =>
  stripVTControlCharacters(raw).replace(/[\p{Cc}\p{Cf}]/gu, (character) =>
    character === "\n" || character === "\t" ? character : "",
  );
const safeTail = (raw: string): string => {
  const text = printable(raw)
    .replace(
      /-----BEGIN [^-\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\n]*PRIVATE KEY-----|$)/g,
      "[REDACTED]",
    )
    .replace(/\b(?:https?|ssh|git):\/\/[^\s<>"']+/gi, "[REDACTED_URL]")
    .replace(/\b(?:Bearer|Basic)\s+[^\s,"']+/gi, "[REDACTED_AUTH]")
    .replace(
      /(["']?[\w.-]{0,128}(?:token|password|passwd|secret|credential|api[_-]?key|authorization)[\w.-]{0,128}["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi,
      "$1[REDACTED]",
    );
  const bytes = Buffer.from(text);
  let start = Math.max(0, bytes.length - outputBytes);
  while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString("utf8");
};

/** Fixed operation names, never command text; only bounded redacted output crosses this boundary. */
export const nativeCommandFailureSchema = z.object({
  step: z.enum([
    "stage-directory",
    "install-asset",
    "bind-source",
    "install-recipe",
    "verify-assets",
    "read-image-probe",
    "read-guest-evidence",
    "install-receipt",
    "remove-build-records",
  ]),
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  stdoutTail: z.string().transform(safeTail),
  stderrTail: z.string().transform(safeTail),
});
export type NativeCommandFailure = z.infer<typeof nativeCommandFailureSchema>;

/** Native construction receives no launch credentials. Scrub supplied environment values as well. */
export const nativeCommandFailure = (
  step: NativeCommandFailure["step"],
  output: BoatCommand,
  redactions: readonly string[],
): NativeCommandFailure => {
  const redact = (text: string) => {
    text = printable(text);
    for (const value of [...new Set(redactions)]
      .map(printable)
      .filter((candidate) => candidate.length >= 8)
      .toSorted((a, b) => b.length - a.length)) {
      text = text.split(value).join("[REDACTED]");
    }
    return text;
  };
  return nativeCommandFailureSchema.parse({
    step,
    exitCode: output.exitCode,
    timedOut: output.timedOut,
    stdoutTail: redact(output.stdout),
    stderrTail: redact(output.stderr),
  });
};

/** Transport failures have no command result. Retain safe provider context and the known local step. */
export const nativeProviderFailureSchema = boatProviderFailureSchema.extend({
  step: nativeCommandFailureSchema.shape.step.optional(),
});
export type NativeProviderFailure = z.infer<typeof nativeProviderFailureSchema>;
