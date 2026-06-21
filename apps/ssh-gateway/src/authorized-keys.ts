import { createHash, timingSafeEqual } from "node:crypto";

import ssh2 from "ssh2";

const { utils } = ssh2;

type VerifyFunction = (blob: Buffer, signature: Buffer, hashAlgo?: string) => boolean;

export interface AuthorizedKeyEntry {
  readonly algo: string;
  readonly data: Buffer;
  readonly verify: VerifyFunction;
  /**
   * Identifies *who* this key belongs to (gateway-spec §3.4). The API authorizes principal x sandbox;
   * the gateway sends this with the control-target request. Taken from the key's trailing comment, or
   * a stable fingerprint of the key material when no comment is present.
   */
  readonly principalId: string;
}

// Parse a single authorized_keys line into a structure we can compare quickly at auth time.
const toAuthorizedKeyEntry = (line: string): AuthorizedKeyEntry | undefined => {
  const trimmed = line.trim();

  if (trimmed.length === 0 || trimmed.startsWith("#")) {
    return undefined;
  }

  // `<algo> <base64> [comment...]`. The comment (if any) is the principal id.
  const parts = trimmed.split(/\s+/);
  const [algo, encoded] = parts;
  const comment = parts.slice(2).join(" ").trim();

  if (algo === undefined || encoded === undefined) {
    throw new Error(`Invalid authorized_keys entry: '${line}'`);
  }

  const parsedKey = utils.parseKey(`${algo} ${encoded}`);
  if (parsedKey instanceof Error) {
    throw new Error(`Unable to parse authorized_keys entry: ${parsedKey.message}`);
  }

  const key = Array.isArray(parsedKey) ? parsedKey[0] : parsedKey;

  if (key === undefined || typeof key !== "object" || !("verify" in key)) {
    throw new Error("Unable to parse authorized_keys entry into a verifier.");
  }

  const verifier = key.verify.bind(key) as VerifyFunction;
  const data = Buffer.from(encoded, "base64");
  // A comment names the principal; otherwise fall back to a deterministic key fingerprint so every
  // entry still has a stable, distinct identity the API can authorize.
  const principalId =
    comment.length > 0 ? comment : `key:${createHash("sha256").update(data).digest("hex")}`;

  return {
    algo,
    data,
    verify: verifier,
    principalId,
  };
};

export const parseAuthorizedKeys = (input: string): ReadonlyArray<AuthorizedKeyEntry> => {
  // Ignore blanks/comments so operators can annotate key files.
  return input
    .split("\n")
    .map((line) => toAuthorizedKeyEntry(line))
    .flatMap((entry) => (entry === undefined ? [] : [entry]));
};

export const findAuthorizedKey = (
  entries: ReadonlyArray<AuthorizedKeyEntry>,
  input: { algo: string; data: Buffer },
): AuthorizedKeyEntry | undefined => {
  // timingSafeEqual avoids leaking key-match details through timing side channels.
  return entries.find((entry) => {
    if (entry.algo !== input.algo || entry.data.length !== input.data.length) {
      return false;
    }

    return timingSafeEqual(entry.data, input.data);
  });
};
