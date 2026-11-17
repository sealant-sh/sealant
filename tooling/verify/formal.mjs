// `pnpm verify formal`: the formal models whose covered paths a diff touches, run at their quick
// bounds (`--full`: every bound), and their drift: covered code that changed while the model and its
// sync commit stayed put.
//
// Each model is an area under docs/formal/<area>/ with a `check.sh` (no argument: the quick bounds;
// `--deep`: every bound; exit 0 every case gave its expected verdict, 1 one did not, 2 no checker,
// with at most $FORMAL_WORKERS checker threads when set) and a COVERAGE file (`sync <commit>`, then
// one `path <repo path>` per covered file). Every check.sh runs tlx at the commit docs/formal/tlx.sh
// pins.
//
// It needs nothing installed, so CI's scope job runs `node tooling/verify/formal.mjs scope <base>`
// before `pnpm install`.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { matchesAny } from "./paths.mjs";
import { changedFiles, REPO_ROOT, runLogged } from "./repo.mjs";

const FORMAL = "docs/formal";

/** A COVERAGE file's sync commit and covered paths; null when it has no `sync` line. */
export function parseCoverage(text) {
  let sync = null;
  const paths = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const [key, value, ...rest] = line.split(/\s+/);
    if (value === undefined || rest.length > 0 || (key !== "sync" && key !== "path")) {
      throw new Error(
        `COVERAGE: cannot read "${line}"; a line is \`sync <commit>\` or \`path <file>\``,
      );
    }
    if (key === "sync") sync = value;
    else paths.push(value);
  }
  return sync === null ? null : { sync, paths };
}

/** Every model under docs/formal/, with its COVERAGE. */
export function formalAreas(root) {
  const base = path.join(root, FORMAL);
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(path.join(base, entry.name, "COVERAGE")))
    .map((entry) => {
      const directory = `${FORMAL}/${entry.name}`;
      const coverage = parseCoverage(readFileSync(path.join(root, directory, "COVERAGE"), "utf8"));
      if (coverage === null) throw new Error(`${directory}/COVERAGE has no sync line`);
      return { area: entry.name, directory, coverage };
    })
    .toSorted((a, b) => a.area.localeCompare(b.area));
}

// What every model runs on: the tlx pin, the checker lookup each check.sh sources, and CI's tlx
// build. A diff to one of them owes every model.
const CHECKER_PATHS = [`${FORMAL}/tlx.sh`, `${FORMAL}/checker.sh`, ".github/actions/tlx/**"];

/** The paths that make a diff owe this model: its covered code, the model and its checker. */
export function obligationPaths(area) {
  return [...area.coverage.paths, `${area.directory}/**`, ...CHECKER_PATHS];
}

/** The areas whose covered code or model files `files` touch. */
export function touchedAreas(areas, files) {
  return areas.filter((area) => files.some((file) => matchesAny(file, obligationPaths(area))));
}

function syncAt(root, commit, area) {
  try {
    const text = execFileSync("git", ["show", `${commit}:${area.directory}/COVERAGE`], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return parseCoverage(text)?.sync ?? null;
  } catch {
    return null;
  }
}

/**
 * The drift guard: a diff that changes covered code must also change the model (any file under the
 * area but COVERAGE) or move the sync commit. Passes when the diff touches no covered code.
 */
export function driftGuard({ root, area, mergeBase, files }) {
  const covered = files.filter((file) => area.coverage.paths.includes(file));
  if (covered.length === 0) return { status: "passed", detail: "the diff changes no covered file" };
  const modelChanged = files.some(
    (file) => file.startsWith(`${area.directory}/`) && file !== `${area.directory}/COVERAGE`,
  );
  const syncMoved = mergeBase === null || syncAt(root, mergeBase, area) !== area.coverage.sync;
  if (modelChanged || syncMoved) {
    return {
      status: "passed",
      detail: `the diff changes ${covered.length} covered file(s) and ${modelChanged ? "the model" : "the sync commit"}`,
    };
  }
  return {
    status: "failed",
    detail: `the diff changes ${covered.join(", ")} but neither the model nor the sync commit in ${area.directory}/COVERAGE`,
  };
}

/** Covered files that differ from the sync commit, the working tree included. */
export function driftSinceSync(root, area) {
  const out = execFileSync(
    "git",
    ["diff", "--name-only", area.coverage.sync, "--", ...area.coverage.paths],
    { cwd: root, encoding: "utf8" },
  );
  return out.split("\n").filter((line) => line !== "");
}

const CHECK_STATUS = { 0: "passed", 1: "failed", 2: "blocked_by_prerequisite" };

/**
 * Runs the drift guard and the model of every area the diff touches (every area with `all`).
 * Returns the steps, the commands that would turn a non-passed result into a passed one, and the
 * proofs a passing result discharges.
 */
export async function runFormal({
  root,
  mergeBase,
  files,
  all,
  full,
  workers,
  logDirectory,
  echo,
}) {
  const areas = formalAreas(root);
  const chosen = all ? areas : touchedAreas(areas, files);
  if (chosen.length === 0) {
    return {
      steps: [
        {
          id: "scope",
          title: `Formal models whose covered paths the diff touches (${areas.map((a) => a.area).join(", ")})`,
          status: "passed",
          detail: "the diff touches no covered path",
        },
      ],
      next: [],
      proves: [],
    };
  }
  const steps = [];
  const next = [];
  for (const area of chosen) {
    const guard = driftGuard({ root, area, mergeBase, files });
    const behind = driftSinceSync(root, area);
    steps.push({
      id: `drift:${area.area}`,
      title: `${area.area}: covered code changed with its model or sync commit`,
      status: guard.status,
      detail: `${guard.detail}. ${behind.length} covered file(s) differ from sync ${area.coverage.sync.slice(0, 8)}${behind.length === 0 ? "" : `: ${behind.join(", ")}`}`,
    });
    if (guard.status !== "passed") {
      next.push(
        `read the changed hunks against ${area.directory}, then update the model or move \`sync\` in its COVERAGE (the ${area.area} skill)`,
      );
    }
    const started = Date.now();
    const logFile = path.join(logDirectory, `formal-${area.area}.log`);
    const argv = ["bash", `${area.directory}/check.sh`, ...(full ? ["--deep"] : [])];
    const code = await runLogged({
      argv,
      cwd: root,
      env: workers === undefined ? {} : { FORMAL_WORKERS: String(workers) },
      logFile,
      echo,
    });
    const status = CHECK_STATUS[code] ?? "failed";
    steps.push({
      id: `model:${area.area}`,
      title: `${area.area}: every case gives its expected verdict (${full ? "every bound" : "quick bounds"})`,
      status,
      command: argv.join(" "),
      durationMs: Date.now() - started,
      log: path.relative(root, logFile),
      ...(status === "passed" ? {} : { detail: `check.sh exited ${code}` }),
    });
    if (status !== "passed") next.push(`bash ${area.directory}/check.sh --trace`);
  }
  return { steps, next, proves: chosen.map((area) => `formal:${area.area}`) };
}

// CI's scope job: `node tooling/verify/formal.mjs scope <base ref>` prints `touched=true` when the
// branch's diff against its merge base with <base ref> touches any model's covered paths.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [command, base] = process.argv.slice(2);
  if (command !== "scope" || base === undefined) {
    process.stderr.write("usage: node tooling/verify/formal.mjs scope <base ref>\n");
    process.exit(2);
  }
  const mergeBase = execFileSync("git", ["merge-base", "HEAD", base], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  }).trim();
  const touched = touchedAreas(formalAreas(REPO_ROOT), changedFiles(REPO_ROOT, mergeBase));
  process.stderr.write(
    `formal models touched: ${touched.map((a) => a.area).join(", ") || "none"}\n`,
  );
  process.stdout.write(`touched=${touched.length > 0}\n`);
}
