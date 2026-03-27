import { timingSafeEqual } from "node:crypto";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const cjsRequire = createRequire(resolve(process.cwd(), "package.json"));
const ssh2 = cjsRequire("ssh2") as typeof import("ssh2");

const { utils } = ssh2;

type VerifyFunction = (blob: Buffer, signature: Buffer, hashAlgo?: string) => boolean;

export interface AuthorizedKeyEntry {
  readonly algo: string;
  readonly data: Buffer;
  readonly verify: VerifyFunction;
}

const toAuthorizedKeyEntry = (line: string): AuthorizedKeyEntry | undefined => {
  const trimmed = line.trim();

  if (trimmed.length === 0 || trimmed.startsWith("#")) {
    return undefined;
  }

  const [algo, encoded] = trimmed.split(/\s+/, 3);

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

  return {
    algo,
    data: Buffer.from(encoded, "base64"),
    verify: verifier,
  };
};

export const parseAuthorizedKeys = (input: string): ReadonlyArray<AuthorizedKeyEntry> => {
  return input
    .split("\n")
    .map((line) => toAuthorizedKeyEntry(line))
    .flatMap((entry) => (entry === undefined ? [] : [entry]));
};

export const findAuthorizedKey = (
  entries: ReadonlyArray<AuthorizedKeyEntry>,
  input: { algo: string; data: Buffer },
): AuthorizedKeyEntry | undefined => {
  return entries.find((entry) => {
    if (entry.algo !== input.algo || entry.data.length !== input.data.length) {
      return false;
    }

    return timingSafeEqual(entry.data, input.data);
  });
};
