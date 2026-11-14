// The one result every `pnpm verify` verb prints, and how a run's steps roll up into it. This is the
// shared contract of the verify toolkit (the same shape in sealant, sealantd and Mend): add optional
// fields freely, never change the meaning of one, and bump SCHEMA_VERSION only for a breaking change.
import { mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import path from "node:path";

import { Schema } from "effect";

export const SCHEMA_VERSION = 1;

/** Worst first: a verb's status is the first of these that any of its steps has. */
export const STATUSES = [
  "failed",
  "blocked_by_prerequisite",
  "skipped",
  "not_implemented",
  "requires_external_observer",
  "evidence_withheld",
  "passed",
];

export const EXIT_CODES = {
  passed: 0,
  failed: 1,
  usage: 2,
  blocked_by_prerequisite: 3,
  skipped: 4,
  not_implemented: 4,
  requires_external_observer: 4,
  evidence_withheld: 4,
};

const Status = Schema.Literals(STATUSES);

const Skipped = Schema.Struct({
  name: Schema.String,
  gate: Schema.String,
  // Optional, sealant: the test file, so a reader can find it without searching for the name.
  file: Schema.optionalKey(Schema.String),
});

export const Step = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  status: Status,
  command: Schema.optionalKey(Schema.String),
  durationMs: Schema.optionalKey(Schema.Number),
  log: Schema.optionalKey(Schema.String),
  detail: Schema.optionalKey(Schema.String),
  skipped: Schema.optionalKey(Schema.Array(Skipped)),
});

export const Obligation = Schema.Struct({
  // `<map entry>:<kind>`, plus the suite or model when it has one: stable across runs.
  id: Schema.String,
  kind: Schema.Literals([
    "tests",
    "formal",
    "stack",
    "screenshots",
    "box-check",
    "harness",
    "external",
  ]),
  why: Schema.String,
  // "owed" in a plan; in `verify status`, the status of the result that discharges it.
  status: Schema.Union([Schema.Literal("owed"), Status]),
  command: Schema.optionalKey(Schema.String),
  what: Schema.optionalKey(Schema.String),
  // The CI workflow that also runs it on the pull request, when one does.
  ci: Schema.optionalKey(Schema.String),
  evidence: Schema.optionalKey(Schema.String),
  detail: Schema.optionalKey(Schema.String),
});

const CiJob = Schema.Struct({ workflow: Schema.String, job: Schema.String, why: Schema.String });

export const Result = Schema.Struct({
  schemaVersion: Schema.Literal(SCHEMA_VERSION),
  tool: Schema.Literal("verify"),
  repo: Schema.String,
  verb: Schema.String,
  status: Status,
  head: Schema.Struct({
    sha: Schema.String,
    branch: Schema.NullOr(Schema.String),
    dirty: Schema.Boolean,
    base: Schema.String,
    mergeBase: Schema.NullOr(Schema.String),
  }),
  startedAt: Schema.String,
  durationMs: Schema.Number,
  steps: Schema.Array(Step),
  obligations: Schema.Array(Obligation),
  evidence: Schema.Array(Schema.Struct({ kind: Schema.String, path: Schema.String })),
  cleanup: Schema.Struct({
    status: Schema.Literals(["clean", "left"]),
    left: Schema.Array(Schema.String),
  }),
  next: Schema.Array(Schema.String),
  // Optional, sealant: the command line that made this result.
  invocation: Schema.optionalKey(Schema.String),
  // Optional, sealant: the obligation proofs a passing result discharges (`check`, `db:boat-catalog`).
  proves: Schema.optionalKey(Schema.Array(Schema.String)),
  // Optional, sealant (`verify plan`): the CI jobs this diff runs on its pull request.
  ciJobs: Schema.optionalKey(Schema.Array(CiJob)),
});

/** Throws, naming the first field that is wrong, when `value` is not a valid result. */
export const decodeResult = Schema.decodeUnknownSync(Result);

/** The worst status in `statuses`; `passed` for none. */
export function worstStatus(statuses) {
  let worst = STATUSES.length - 1;
  for (const status of statuses) {
    const rank = STATUSES.indexOf(status);
    if (rank === -1) throw new Error(`worstStatus: unknown status ${status}`);
    worst = Math.min(worst, rank);
  }
  return STATUSES[worst];
}

/** Builds the result of a verb from its steps; the verb's status is the worst of theirs. */
export function makeResult({ verb, head, startedAt, steps, ...rest }) {
  const result = {
    schemaVersion: SCHEMA_VERSION,
    tool: "verify",
    repo: "sealant",
    verb,
    status: rest.status ?? worstStatus(steps.map((step) => step.status)),
    head,
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    steps,
    obligations: rest.obligations ?? [],
    evidence: rest.evidence ?? [],
    cleanup: rest.cleanup ?? { status: "clean", left: [] },
    next: rest.next ?? [],
    ...(rest.invocation === undefined ? {} : { invocation: rest.invocation }),
    ...(rest.proves === undefined ? {} : { proves: rest.proves }),
    ...(rest.ciJobs === undefined ? {} : { ciJobs: rest.ciJobs }),
  };
  return decodeResult(result);
}

/** Where a result is kept, relative to the repo root: `.verify/results/<verb>-<UTC timestamp>.json`. */
export function resultPath(result) {
  const stamp = result.startedAt.replaceAll(":", "").replace(/\.\d+Z$/, "Z");
  return path.join(".verify", "results", `${result.verb}-${stamp}.json`);
}

/**
 * Keeps the result: `.verify/results/<verb>-<UTC timestamp>.json`, copied to
 * `.verify/latest/<verb>.json`. Returns the kept file's path, relative to `root`.
 */
export function writeResult(root, result) {
  const relative = resultPath(result);
  const file = path.join(root, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
  const latest = path.join(root, ".verify", "latest", `${result.verb}.json`);
  mkdirSync(path.dirname(latest), { recursive: true });
  copyFileSync(file, latest);
  return relative;
}
