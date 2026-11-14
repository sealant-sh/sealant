// `pnpm verify check`: the checks AGENTS.md lists before a PR, each a step, with every skipped test
// named with its gate. A test may skip without failing the step only when allowed-skips.json lets it
// skip here and the diff does not owe the suite it belongs to.
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { matchesAny } from "./plan.mjs";
import { runLogged } from "./repo.mjs";

const REPORTER = fileURLToPath(new URL("vitest-reporter.mjs", import.meta.url));

export function loadAllowedSkips(root) {
  return JSON.parse(readFileSync(path.join(root, "tooling/verify/allowed-skips.json"), "utf8"))
    .skips;
}

/**
 * Sorts skipped tests into those allowed to skip in `context` and those that make the step
 * `skipped`. A skip is allowed only when its file's first matching entry allows `context` and the
 * entry's suite is not one the diff owes (`owedSuites`).
 */
export function classifySkips({ root, tests, allowedSkips, context, owedSuites }) {
  const allowed = [];
  const refused = [];
  for (const test of tests) {
    if (test.state !== "skipped") continue;
    const file = path.relative(root, test.file);
    const entry = allowedSkips.find((candidate) => matchesAny(file, candidate.files));
    const skip = {
      name: test.name,
      file,
      gate:
        entry === undefined
          ? "unlisted in tooling/verify/allowed-skips.json"
          : entry.gate.join(" + "),
      ...(entry === undefined ? {} : { suite: entry.suite }),
    };
    if (
      entry !== undefined &&
      entry.allowedIn.includes(context) &&
      !owedSuites.includes(entry.suite)
    ) {
      allowed.push(skip);
    } else {
      refused.push(skip);
    }
  }
  return { allowed, refused };
}

function readReports(directory) {
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(path.join(directory, name), "utf8")));
}

function countBy(items, key) {
  const counts = new Map();
  for (const item of items) counts.set(item[key], (counts.get(item[key]) ?? 0) + 1);
  return [...counts].map(([value, count]) => `${count} ${value}`).join(", ");
}

/**
 * Runs a vitest command (`argv`, which must leave the extra reporter flags to this function) with
 * the verify reporter, and judges it: failed on a non-zero exit, skipped when any skip is refused,
 * passed otherwise.
 */
export async function runTestsStep({
  root,
  id,
  title,
  argv,
  env = {},
  logFile,
  context,
  owedSuites,
  allowedSkips,
  echo,
}) {
  const reportDirectory = mkdtempSync(path.join(tmpdir(), "sealant-verify-"));
  const started = Date.now();
  const fullArgv = [...argv, "--reporter=default", `--reporter=${REPORTER}`];
  try {
    const code = await runLogged({
      argv: fullArgv,
      cwd: root,
      env: { ...env, SEALANT_VERIFY_REPORT_DIR: reportDirectory },
      logFile,
      echo,
    });
    const reports = readReports(reportDirectory);
    const tests = reports.flatMap((report) => report.tests);
    const { allowed, refused } = classifySkips({ root, tests, allowedSkips, context, owedSuites });
    const passed = tests.filter((test) => test.state === "passed").length;
    const failed = tests.filter((test) => test.state === "failed").length;
    const parts = [`${passed} passed`, `${failed} failed`, `${refused.length} skipped`];
    if (allowed.length > 0)
      parts.push(`${allowed.length} allowed to skip (${countBy(allowed, "gate")})`);
    let status = "passed";
    if (code !== 0) status = "failed";
    else if (refused.length > 0) status = "skipped";
    return {
      step: {
        id,
        title,
        status,
        command: fullArgv.join(" "),
        durationMs: Date.now() - started,
        log: path.relative(root, logFile),
        detail: `${parts.join(", ")} in ${reports.length} vitest run${reports.length === 1 ? "" : "s"}${code === 0 ? "" : `; exit ${code}`}`,
        skipped: refused.map(({ name, file, gate }) => ({ name, file, gate })),
      },
      refused,
    };
  } finally {
    rmSync(reportDirectory, { recursive: true, force: true });
  }
}

/** Runs a command as one step: passed on exit 0, failed otherwise. */
export async function runCommandStep({ root, id, title, argv, env, logFile, echo }) {
  const started = Date.now();
  const code = await runLogged({ argv, cwd: root, env, logFile, echo });
  return {
    id,
    title,
    status: code === 0 ? "passed" : "failed",
    command: argv.join(" "),
    durationMs: Date.now() - started,
    log: path.relative(root, logFile),
    ...(code === 0 ? {} : { detail: `exit ${code}` }),
  };
}

/**
 * The four checks of AGENTS.md "Checks Before a PR", in order. Formatting is checked on the files
 * the diff changes (`changed`), or on the whole repo with `all`: main carries files its bots write
 * unformatted (changelogs, migration snapshots), and CI does not check formatting.
 */
export async function runCheck({
  root,
  head,
  all,
  owed,
  changed,
  logDirectory,
  workers,
  echo = true,
}) {
  const concurrency = workers === undefined ? [] : [`--concurrency=${workers}`];
  const log = (name) => path.join(logDirectory, `check-${name}.log`);
  const steps = [];
  const next = [];
  steps.push(
    await runCommandStep({
      root,
      id: "typecheck",
      title: "Typecheck, every package (forced)",
      argv: [
        "pnpm",
        "exec",
        "turbo",
        "typecheck",
        "--force",
        "--output-logs=errors-only",
        ...concurrency,
      ],
      logFile: log("typecheck"),
      echo,
    }),
  );
  steps.push(
    await runCommandStep({
      root,
      id: "lint",
      title: "Lint, every package (forced)",
      argv: [
        "pnpm",
        "exec",
        "turbo",
        "lint",
        "--force",
        "--output-logs=errors-only",
        ...concurrency,
      ],
      logFile: log("lint"),
      echo,
    }),
  );
  const affected = !all && head.mergeBase !== null;
  const owedSuites = owed.flatMap((item) => (item.suite === undefined ? [] : [item.suite]));
  const tests = await runTestsStep({
    root,
    id: "tests",
    title: affected ? "Tests of the affected packages" : "Tests of every package",
    argv: [
      "pnpm",
      "exec",
      "turbo",
      "test",
      "--force",
      ...concurrency,
      ...(affected ? ["--affected"] : []),
      "--",
      ...(workers === undefined ? [] : [`--maxWorkers=${workers}`]),
    ],
    env: affected ? { TURBO_SCM_BASE: head.mergeBase } : {},
    logFile: log("tests"),
    context: "check",
    owedSuites,
    allowedSkips: loadAllowedSkips(root),
    echo,
  });
  steps.push(tests.step);
  for (const suite of new Set(tests.refused.map((skip) => skip.suite))) {
    const owe = owed.find((item) => item.suite === suite && item.command !== undefined);
    if (owe !== undefined) next.push(owe.command);
  }
  const formatTargets = all ? ["."] : changed.filter((file) => existsSync(path.join(root, file)));
  const formatArgs = ["--no-error-on-unmatched-pattern", ...formatTargets];
  const format =
    formatTargets.length === 0
      ? {
          id: "format",
          title: "Formatting of the changed files",
          status: "passed",
          detail: "no changed file to check",
        }
      : await runCommandStep({
          root,
          id: "format",
          title: all ? "Formatting, the whole repo" : "Formatting of the changed files",
          argv: ["pnpm", "exec", "oxfmt", "--check", ...formatArgs],
          logFile: log("format"),
          echo,
        });
  steps.push(format);
  if (format.status === "failed") next.push(["pnpm exec oxfmt", ...formatArgs].join(" "));
  return { steps, next };
}
