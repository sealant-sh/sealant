/**
 * A ZIP archive of a few small text files, stored without compression. The managed MicroVM image
 * build takes its context as a zip; ours holds a Containerfile and two scripts, so a dependency
 * is not worth it. Entries carry a fixed timestamp, so equal contents give equal bytes.
 */
import { crc32 } from "node:zlib";

export interface ZipEntry {
  /** A relative path with forward slashes. */
  readonly name: string;
  readonly content: Uint8Array;
}

// 1980-01-01 00:00:00, the earliest a DOS timestamp can say.
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

const assertName = (name: string): void => {
  if (
    name === "" ||
    name.startsWith("/") ||
    name.includes("\\") ||
    name.split("/").includes("..")
  ) {
    throw new Error(`Refusing the zip entry name ${JSON.stringify(name)}.`);
  }
};

export const zipStored = (entries: readonly ZipEntry[]): Buffer => {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    assertName(entry.name);
    const name = Buffer.from(entry.name, "utf8");
    const content = Buffer.from(entry.content);
    const checksum = crc32(content);

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4); // version needed
    header.writeUInt16LE(0x0800, 6); // UTF-8 names
    header.writeUInt16LE(0, 8); // stored
    header.writeUInt16LE(DOS_TIME, 10);
    header.writeUInt16LE(DOS_DATE, 12);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(content.length, 18);
    header.writeUInt32LE(content.length, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);
    local.push(header, name, content);

    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4); // version made by
    record.writeUInt16LE(20, 6); // version needed
    record.writeUInt16LE(0x0800, 8);
    record.writeUInt16LE(0, 10);
    record.writeUInt16LE(DOS_TIME, 12);
    record.writeUInt16LE(DOS_DATE, 14);
    record.writeUInt32LE(checksum, 16);
    record.writeUInt32LE(content.length, 20);
    record.writeUInt32LE(content.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE((0o100644 << 16) >>> 0, 38); // a regular file, rw-r--r--
    record.writeUInt32LE(offset, 42);
    central.push(record, name);

    offset += header.length + name.length + content.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
};
