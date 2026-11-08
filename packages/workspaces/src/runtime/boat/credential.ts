import { constants, closeSync, fstatSync, openSync, readSync } from "node:fs";

import { BoatApiError, BoatSecret, type BoatResult } from "./config.js";

const refused = (): BoatResult<BoatSecret> => ({
  ok: false,
  error: new BoatApiError("credential", null, "credential_file_refused"),
});

/** Read once into a redacted credential. File bytes never enter process.env or failure diagnostics. */
export const loadBoatCredential = (input: {
  readonly value?: string | undefined;
  readonly file?: string | undefined;
}): BoatResult<BoatSecret> => {
  if (input.file === undefined)
    return input.value === undefined ? refused() : BoatSecret.parse(input.value);
  if (input.value !== undefined) return refused();
  const parts = input.file.split("/");
  if (
    parts.shift() !== "" ||
    parts.length < 2 ||
    parts.some((part) => !part || part === "." || part === "..")
  )
    return refused();
  const descriptors: number[] = [];
  try {
    const root = openSync("/", constants.O_RDONLY | constants.O_DIRECTORY);
    descriptors.push(root);
    let parent = root;
    for (const part of parts.slice(0, -1)) {
      parent = openSync(
        `/proc/self/fd/${parent}/${part}`,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      descriptors.push(parent);
    }
    const directory = fstatSync(parent);
    if (directory.uid !== 0 || directory.gid !== 0 || (directory.mode & 0o7777) !== 0o700)
      return refused();
    const descriptor = openSync(
      `/proc/self/fd/${parent}/${parts.at(-1)}`,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    descriptors.push(descriptor);
    const before = fstatSync(descriptor);
    if (
      !before.isFile() ||
      before.uid !== 0 ||
      before.gid !== 0 ||
      (before.mode & 0o7777) !== 0o400 ||
      before.nlink !== 1 ||
      before.size < 16 ||
      before.size > 4097
    )
      return refused();
    const bytes = Buffer.alloc(4098);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(descriptor, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    const after = fstatSync(descriptor);
    if (
      length !== before.size ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.mode !== after.mode ||
      before.uid !== after.uid ||
      before.gid !== after.gid ||
      before.nlink !== after.nlink ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      return refused();
    const value = bytes.subarray(0, length).toString("utf8").replace(/\n$/, "");
    return BoatSecret.parse(value);
  } catch {
    return refused();
  } finally {
    for (const descriptor of descriptors.toReversed()) {
      try {
        closeSync(descriptor);
      } catch {
        // A close failure must not disclose the credential path through a native error.
      }
    }
  }
};
