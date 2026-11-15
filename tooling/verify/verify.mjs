#!/usr/bin/env node
// `pnpm verify <verb>`: what a change owes, the pre-PR checks with every skip named, and the receipt.
// Progress goes to stderr; with --json, stdout carries exactly one result (result.mjs). Every run is
// kept under .verify/. Exit codes: 0 passed, 1 failed, 2 wrong usage, 3 blocked by a prerequisite,
// 4 any other status. The shared contract is the verify toolkit spec (SLNT-892).
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { runCheck } from "./check.mjs";
import { runDb, SUITES } from "./db.mjs";
import { ciJobsFor, loadObligations, owedFor, printable } from "./plan.mjs";
import { changedFiles, readHead, REPO_ROOT } from "./repo.mjs";
import { EXIT_CODES, makeResult, writeResult } from "./result.mjs";
import { judge, readLatest, toMarkdown } from "./status.mjs";

const VERBS = {
  plan: "What this diff owes (tests, gated suites, models, screenshots) and which CI jobs it runs",
  check: "The pre-PR checks: forced typecheck and lint, affected tests (skips named), formatting",
  status: "For each obligation, whether a passing result exists for this exact commit (--markdown)",
  db: "A throwaway Postgres, the Boat bundle and every gate set; runs gated suites, no skips",
  formal: "Not yet: the formal models whose covered paths the diff touches, and their drift",
  stack: "Not yet: the local stack, up, status and down",
  runtime: "Not yet: a live Boat launch (requires an external observer without credentials)",
  "boat-harness": "Not yet: the Boat harness preflight and lock status",
  evidence: "Not yet: screenshots and transcripts, secret-scanned, and the verdict file",
};
const IMPLEMENTED = new Set(["plan", "check", "status", "db"]);

class UsageError extends Error {}

function usage() {
  const width = Math.max(...Object.keys(VERBS).map((verb) => verb.length));
  return [
    "pnpm verify <verb> [options]",
    "",
    ...Object.entries(VERBS).map(([verb, what]) => `  ${verb.padEnd(width)}  ${what}`),
    "",
    "Options: --json (one result on stdout), --base <ref> (default origin/main),",
    "plan: --files <path>... ; check: --all ; status: --markdown ;",
    `db: [suite...] of ${Object.keys(SUITES).join(", ")} (all when none) ;`,
    "check, db: --workers <n> (at most n test workers and turbo tasks)",
  ].join("\n");
}

function parse(argv) {
  try {
    return parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        json: { type: "boolean", default: false },
        base: { type: "string", default: "origin/main" },
        files: { type: "boolean", default: false },
        all: { type: "boolean", default: false },
        markdown: { type: "boolean", default: false },
        workers: { type: "string" },
      },
    });
  } catch (error) {
    throw new UsageError(error.message);
  }
}

/** The plan for `head`: from `--files` when given, else from the diff against the merge base. */
function planFor(root, head, files) {
  if (files === null && head.mergeBase === null) {
    throw new UsageError(`no merge base with ${head.base}; fetch it, pass --base, or use --files`);
  }
  const changed = files ?? changedFiles(root, head.mergeBase);
  return {
    changed,
    owed: owedFor(loadObligations(root), changed),
    ciJobs: ciJobsFor(root, changed),
  };
}

/** Runs one verb and returns its result. Throws UsageError for wrong usage. */
export async function run(argv, { root = REPO_ROOT, echo = true } = {}) {
  const { values, positionals } = parse(argv);
  const [verb, ...rest] = positionals;
  if (verb === undefined || verb === "help") return { help: usage() };
  if (!(verb in VERBS)) throw new UsageError(`unknown verb "${verb}"\n\n${usage()}`);
  if (values.files && verb !== "plan") throw new UsageError("--files is a plan option");
  const workers = values.workers === undefined ? undefined : Number(values.workers);
  if (workers !== undefined && !(Number.isInteger(workers) && workers > 0)) {
    throw new UsageError("--workers takes a whole number above 0");
  }
  if (verb === "db") {
    const unknown = rest.find((suite) => !(suite in SUITES));
    if (unknown !== undefined) {
      throw new UsageError(`unknown suite "${unknown}"; db runs ${Object.keys(SUITES).join(", ")}`);
    }
  } else if (!values.files && rest.length > 0 && IMPLEMENTED.has(verb)) {
    throw new UsageError(`unexpected argument "${rest[0]}"`);
  }
  const startedAt = new Date();
  const head = readHead(root, values.base);
  const invocation = ["pnpm verify", ...argv.filter((arg) => arg !== "--json")].join(" ");
  const say = (text) => echo && process.stderr.write(`${text}\n`);

  if (!IMPLEMENTED.has(verb)) {
    return makeResult({
      verb,
      head,
      startedAt,
      steps: [{ id: verb, title: VERBS[verb], status: "not_implemented" }],
      invocation,
    });
  }

  if (verb === "plan") {
    const { changed, owed, ciJobs } = planFor(root, head, values.files ? rest : null);
    say(`${changed.length} changed file(s) against ${head.mergeBase?.slice(0, 8) ?? "--files"}`);
    for (const item of owed) say(`owes ${item.id}: ${item.command ?? item.what ?? ""}`);
    for (const job of ciJobs) say(`CI: ${job.workflow} / ${job.job} (${job.why})`);
    return makeResult({
      verb,
      head,
      startedAt,
      steps: [
        {
          id: "plan",
          title: "Match the diff against tooling/verify/obligations.json",
          status: "passed",
          detail: `${changed.length} changed file(s), ${owed.length} obligation(s), ${ciJobs.length} CI job(s)`,
        },
      ],
      obligations: owed.map(printable),
      next: [
        ...new Set(
          owed.flatMap((item) => (item.command?.startsWith("pnpm ") ? [item.command] : [])),
        ),
      ],
      ciJobs,
      invocation,
    });
  }

  if (verb === "check") {
    const { owed, changed } = planFor(root, head, null);
    const logDirectory = path.join(root, ".verify", "logs");
    const { steps, next } = await runCheck({
      root,
      head,
      all: values.all,
      owed,
      changed,
      logDirectory,
      workers,
      echo,
    });
    return makeResult({
      verb,
      head,
      startedAt,
      steps,
      evidence: steps.flatMap((step) =>
        step.log === undefined ? [] : [{ kind: "log", path: step.log }],
      ),
      next,
      proves: ["check"],
      invocation,
    });
  }

  if (verb === "db") {
    const suites = rest.length === 0 ? Object.keys(SUITES) : [...new Set(rest)];
    const { steps, next, left } = await runDb({
      root,
      suites,
      logDirectory: path.join(root, ".verify", "logs"),
      workers,
      echo,
    });
    return makeResult({
      verb,
      head,
      startedAt,
      steps,
      evidence: steps.flatMap((step) =>
        step.log === undefined ? [] : [{ kind: "log", path: step.log }],
      ),
      cleanup: { status: left.length === 0 ? "clean" : "left", left },
      next,
      proves: suites.map((suite) => `db:${suite}`),
      invocation,
    });
  }

  // status
  const { owed } = planFor(root, head, null);
  const judged = judge({ owed, latest: readLatest(root), head, implemented: IMPLEMENTED });
  const markdown = toMarkdown({ head, judged });
  return {
    markdown: values.markdown ? markdown : undefined,
    ...makeResult({
      verb,
      head,
      startedAt,
      steps: judged.map((item) => ({
        id: item.id,
        title: item.why,
        status: item.status,
        ...(item.detail === undefined ? {} : { detail: item.detail }),
      })),
      obligations: judged.map(printable),
      next: [
        ...new Set(
          judged.flatMap((item) =>
            item.status !== "passed" && item.command?.startsWith("pnpm ") ? [item.command] : [],
          ),
        ),
      ],
      invocation,
    }),
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const json = argv.includes("--json");
  let outcome;
  try {
    outcome = await run(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`verify: ${error.message}\n`);
    process.exit(EXIT_CODES.usage);
  }
  if ("help" in outcome) {
    process.stdout.write(`${outcome.help}\n`);
    process.exit(0);
  }
  const { markdown, ...result } = outcome;
  const kept = writeResult(REPO_ROOT, result);
  process.stderr.write(`verify ${result.verb}: ${result.status} (${kept})\n`);
  for (const command of result.next) process.stderr.write(`  next: ${command}\n`);
  if (json) process.stdout.write(`${JSON.stringify(result)}\n`);
  else if (markdown !== undefined) process.stdout.write(markdown);
  process.exit(EXIT_CODES[result.status]);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
