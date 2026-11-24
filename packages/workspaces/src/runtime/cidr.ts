/**
 * IPv4 and IPv6 CIDR blocks as numbers: strict parsing, containment and subtraction. The Docker
 * egress guard (`docker-egress.ts`) builds its `prohibit` routes from these, so every parse refuses
 * what it cannot read exactly instead of guessing: a protection is never dropped on a typo.
 */

export type IpFamily = 4 | 6;

/** A network block: `base` has no bits set past `prefix`. */
export interface Cidr {
  readonly family: IpFamily;
  readonly base: bigint;
  readonly prefix: number;
}

const WIDTH: Record<IpFamily, number> = { 4: 32, 6: 128 };

const OCTET = /^(?:0|[1-9]\d{0,2})$/;
const HEXTET = /^[0-9a-fA-F]{1,4}$/;
const PREFIX = /^(?:0|[1-9]\d{0,2})$/;

const parseIpv4 = (text: string): bigint | undefined => {
  const parts = text.split(".");
  if (parts.length !== 4) return undefined;
  let value = 0n;
  for (const part of parts) {
    if (!OCTET.test(part) || Number(part) > 255) return undefined;
    value = value * 256n + BigInt(part);
  }
  return value;
};

/** The hextets of one side of a `::`, the last of which may be a dotted IPv4 tail. */
const hextets = (text: string, allowIpv4Tail: boolean): Array<number> | undefined => {
  if (text.length === 0) return [];
  const parts = text.split(":");
  const out: Array<number> = [];
  for (const [index, part] of parts.entries()) {
    if (allowIpv4Tail && index === parts.length - 1 && part.includes(".")) {
      const v4 = parseIpv4(part);
      if (v4 === undefined) return undefined;
      out.push(Number(v4 >> 16n), Number(v4 & 0xffffn));
    } else if (HEXTET.test(part)) {
      out.push(Number.parseInt(part, 16));
    } else {
      return undefined;
    }
  }
  return out;
};

const parseIpv6 = (text: string): bigint | undefined => {
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  let groups: Array<number>;
  if (halves.length === 2) {
    const head = hextets(halves[0] ?? "", false);
    const tail = hextets(halves[1] ?? "", true);
    if (head === undefined || tail === undefined || head.length + tail.length > 7) return undefined;
    groups = [...head, ...Array<number>(8 - head.length - tail.length).fill(0), ...tail];
  } else {
    const all = hextets(text, true);
    if (all === undefined || all.length !== 8) return undefined;
    groups = all;
  }
  return groups.reduce((value, group) => (value << 16n) | BigInt(group), 0n);
};

const hostMask = (family: IpFamily, prefix: number): bigint =>
  (1n << BigInt(WIDTH[family] - prefix)) - 1n;

/**
 * One address (`10.1.2.3`, `fd00::1`) or block (`10.0.0.0/8`, `fc00::/7`). An address is its own
 * `/32` or `/128`. Refused: anything else, a zone (`%eth0`), a prefix past the family's width, and
 * a block with host bits set (`10.0.0.5/8`), which would otherwise be silently widened or narrowed.
 */
export const parseCidr = (text: string): Cidr | undefined => {
  const slash = text.indexOf("/");
  const address = slash === -1 ? text : text.slice(0, slash);
  const prefixText = slash === -1 ? undefined : text.slice(slash + 1);
  if (address.includes("%")) return undefined;
  const family: IpFamily = address.includes(":") ? 6 : 4;
  const base = family === 4 ? parseIpv4(address) : parseIpv6(address);
  if (base === undefined) return undefined;
  let prefix = WIDTH[family];
  if (prefixText !== undefined) {
    if (!PREFIX.test(prefixText)) return undefined;
    prefix = Number(prefixText);
    if (prefix > WIDTH[family]) return undefined;
  }
  if ((base & hostMask(family, prefix)) !== 0n) return undefined;
  return { family, base, prefix };
};

/** The block an interface address sits in (`10.233.0.2` with prefix 28 → `10.233.0.0/28`). */
export const networkOf = (address: string, prefix: number): Cidr | undefined => {
  const host = parseCidr(address);
  if (host === undefined || !Number.isInteger(prefix) || prefix < 0) return undefined;
  if (prefix > WIDTH[host.family]) return undefined;
  return { family: host.family, base: host.base & ~hostMask(host.family, prefix), prefix };
};

/** `inner` lies wholly inside `outer`. */
export const cidrContains = (outer: Cidr, inner: Cidr): boolean =>
  outer.family === inner.family &&
  outer.prefix <= inner.prefix &&
  (inner.base & ~hostMask(outer.family, outer.prefix)) === outer.base;

export const cidrsOverlap = (left: Cidr, right: Cidr): boolean =>
  cidrContains(left, right) || cidrContains(right, left);

/** `block` minus `hole`, as the fewest blocks that cover exactly what is left. */
const subtractOne = (block: Cidr, hole: Cidr): ReadonlyArray<Cidr> => {
  if (!cidrsOverlap(block, hole)) return [block];
  if (cidrContains(hole, block)) return [];
  // The hole is strictly inside: keep the half without it, and recurse into the half with it.
  const prefix = block.prefix + 1;
  const low: Cidr = { family: block.family, base: block.base, prefix };
  const high: Cidr = {
    family: block.family,
    base: block.base | (1n << BigInt(WIDTH[block.family] - prefix)),
    prefix,
  };
  return cidrContains(low, hole)
    ? [...subtractOne(low, hole), high]
    : [low, ...subtractOne(high, hole)];
};

const compareCidrs = (left: Cidr, right: Cidr): number =>
  left.family - right.family ||
  (left.base < right.base ? -1 : left.base > right.base ? 1 : 0) ||
  left.prefix - right.prefix;

/** Distinct blocks in a stable order: family, then address, then prefix. */
export const sortCidrs = (cidrs: ReadonlyArray<Cidr>): ReadonlyArray<Cidr> => {
  return cidrs.toSorted(compareCidrs).reduce<Array<Cidr>>((distinct, next) => {
    const last = distinct.at(-1);
    if (last === undefined || compareCidrs(last, next) !== 0) distinct.push(next);
    return distinct;
  }, []);
};

/**
 * Every address of `blocks` that is in none of `holes`, as blocks. A route list built from it needs
 * no allow routes and no reliance on route order: what is open simply has no `prohibit` route.
 */
export const subtractCidrs = (
  blocks: ReadonlyArray<Cidr>,
  holes: ReadonlyArray<Cidr>,
): ReadonlyArray<Cidr> =>
  sortCidrs(
    holes.reduce<ReadonlyArray<Cidr>>(
      (remaining, hole) => remaining.flatMap((block) => subtractOne(block, hole)),
      blocks,
    ),
  );

const formatIpv6 = (value: bigint): string => {
  const groups = Array.from({ length: 8 }, (_, index) =>
    Number((value >> BigInt(112 - index * 16)) & 0xffffn),
  );
  // RFC 5952: the longest run of two or more zero groups (the first of equal runs) becomes `::`.
  let bestStart = -1;
  let bestLength = 1;
  for (let start = 0; start < 8; start += 1) {
    let length = 0;
    while (start + length < 8 && groups[start + length] === 0) length += 1;
    if (length > bestLength) {
      bestStart = start;
      bestLength = length;
    }
  }
  const hex = groups.map((group) => group.toString(16));
  if (bestStart === -1) return hex.join(":");
  return `${hex.slice(0, bestStart).join(":")}::${hex.slice(bestStart + bestLength).join(":")}`;
};

export const formatCidr = (cidr: Cidr): string => {
  const address =
    cidr.family === 4
      ? [24n, 16n, 8n, 0n].map((shift) => String((cidr.base >> shift) & 255n)).join(".")
      : formatIpv6(cidr.base);
  return `${address}/${String(cidr.prefix)}`;
};

/** A literal block, for constants: throws on a typo at module load rather than at a launch. */
export const cidr = (text: string): Cidr => {
  const parsed = parseCidr(text);
  if (parsed === undefined) throw new Error(`Not a CIDR block: ${text}`);
  return parsed;
};
