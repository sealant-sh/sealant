/**
 * The owner map of a capture workspace (sealantd ADR-0015 "Per-person saved directories", Mend's
 * ADR 0016 decision 8): who owns what the daemon's restore writes, and so whether its executor is a
 * per-person one. The ONE definition of its shape, its bounds and its wire encoding, shared by the
 * SDK (client-side refusal with the server's wording), the control-plane validators (every parse:
 * create, worker, restart) and the runtime adapters (the boot env).
 *
 * The daemon reads it from its boot environment as `SEALANT_CAPTURE_OWNER_MAP`, JSON
 * `{"gid":…,"worktree":…,"people":{"<id>":uid,…}}`, parsed strictly (unknown fields refused):
 *
 * - each listed person's saved directory (`<harness home>/people/<id>/`) is restored owned by their
 *   uid and the group, the directory itself 0710, its `conversations/` group-readable and -writable;
 * - the worktree and its git directory are given to the group (owned by `worktreeUid`, setgid, the
 *   owner's bits copied to the group);
 * - a root daemon whose map names at least one person does not set no-new-privileges, so every
 *   person's passwordless `sudo` works. A map naming nobody keeps it.
 *
 * Deliberately dependency-free, like `workspace-environment.ts`: data plus pure functions.
 */

/** The daemon's name for the owner map in its boot environment. */
export const CAPTURE_OWNER_MAP_ENV = "SEALANT_CAPTURE_OWNER_MAP";

/** The shared group every person is in: Mend's `mend`, the reserved range's first id. */
export const CAPTURE_OWNER_MAP_GID = 40_000;

/**
 * The uids people may have: the reserved range (40000–49999) less its first id, the group's. The
 * managed images leave the whole range free (their probe checks it).
 */
export const CAPTURE_OWNER_MAP_UID_RANGE = { first: 40_001, last: 49_999 } as const;

/** At most this many people in one map. */
export const CAPTURE_OWNER_MAP_MAX_PEOPLE = 256;

/**
 * A person's id: the name of their saved directory under `people/` (Mend's account id). One plain
 * path component of at most 128 characters that starts with a letter, a digit or `_` (so never `.`
 * or `..`).
 */
export const CAPTURE_OWNER_MAP_ID_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/u;

/** One person in an owner map. */
export interface CaptureOwnerMapPerson {
  /** The name of their saved directory under `<harness home>/people/` (Mend's account id). */
  readonly id: string;
  /** Their Linux uid, in {@link CAPTURE_OWNER_MAP_UID_RANGE}. */
  readonly uid: number;
}

/** Who owns what a capture restore writes. */
export interface CaptureOwnerMap {
  /** The shared group every person is in: {@link CAPTURE_OWNER_MAP_GID}. */
  readonly gid: number;
  /** The change's owner: owns the worktree root and its git directory. */
  readonly worktreeUid: number;
  /** Each current member. A removed member is left out: their directory is restored root's. */
  readonly people: ReadonlyArray<CaptureOwnerMapPerson>;
}

const isUid = (value: number): boolean =>
  Number.isInteger(value) &&
  value >= CAPTURE_OWNER_MAP_UID_RANGE.first &&
  value <= CAPTURE_OWNER_MAP_UID_RANGE.last;

const UID_RANGE_TEXT = `${CAPTURE_OWNER_MAP_UID_RANGE.first}–${CAPTURE_OWNER_MAP_UID_RANGE.last}`;

/**
 * What is wrong with a map, in the words the control plane answers with; empty when nothing is.
 * Checks the gid, every uid's range, every id's form, and that no id and no uid appears twice (one
 * person's saved directory is never handed to another).
 */
export const captureOwnerMapProblems = (map: CaptureOwnerMap): ReadonlyArray<string> => {
  // A plain JavaScript caller may hand anything: refused in words, never a TypeError.
  const shape: unknown = map;
  if (typeof shape !== "object" || shape === null) {
    return ["ownerMap must be an object { gid, worktreeUid, people }"];
  }
  if (!Array.isArray(map.people)) {
    return ["ownerMap.people must be an array of { id, uid }"];
  }
  const problems: string[] = [];
  if (map.gid !== CAPTURE_OWNER_MAP_GID) {
    problems.push(`ownerMap.gid must be ${CAPTURE_OWNER_MAP_GID} (the mend group), not ${map.gid}`);
  }
  if (!isUid(map.worktreeUid)) {
    problems.push(`ownerMap.worktreeUid ${map.worktreeUid} is not a uid in ${UID_RANGE_TEXT}`);
  }
  if (map.people.length > CAPTURE_OWNER_MAP_MAX_PEOPLE) {
    problems.push(
      `ownerMap.people has ${map.people.length} people; the maximum is ${CAPTURE_OWNER_MAP_MAX_PEOPLE}`,
    );
    return problems;
  }
  const ids = new Set<string>();
  const uids = new Map<number, string>();
  for (const [index, person] of map.people.entries()) {
    const entry: unknown = person;
    if (typeof entry !== "object" || entry === null) {
      problems.push(`ownerMap.people[${index}] must be an object { id, uid }`);
      continue;
    }
    if (typeof person.id !== "string" || !CAPTURE_OWNER_MAP_ID_PATTERN.test(person.id)) {
      problems.push(
        `ownerMap.people[${index}].id must be one directory name of letters, digits, '.', '_' or '-' (at most 128, not starting with '.' or '-')`,
      );
      continue;
    }
    if (ids.has(person.id)) {
      problems.push(`ownerMap.people names ${person.id} twice`);
    }
    ids.add(person.id);
    if (!isUid(person.uid)) {
      problems.push(
        `ownerMap.people ${person.id} has uid ${person.uid}, not a uid in ${UID_RANGE_TEXT}`,
      );
      continue;
    }
    const other = uids.get(person.uid);
    if (other !== undefined && other !== person.id) {
      problems.push(`ownerMap.people gives ${other} and ${person.id} the same uid ${person.uid}`);
    }
    uids.set(person.uid, person.id);
  }
  return problems;
};

/**
 * The map as the daemon parses it (`SEALANT_CAPTURE_OWNER_MAP`): compact JSON, `people` an object
 * keyed by id in code-point order (the daemon's own order), always present.
 */
export const encodeCaptureOwnerMap = (map: CaptureOwnerMap): string => {
  // `fromEntries` defines own properties, so an id such as `__proto__` stays a key.
  const people = Object.fromEntries(
    map.people
      .toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((person) => [person.id, person.uid] as const),
  );
  return JSON.stringify({ gid: map.gid, worktree: map.worktreeUid, people });
};
