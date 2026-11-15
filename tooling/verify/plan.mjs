// `pnpm verify plan`: what a diff owes, from the obligations map, and which CI jobs it runs.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { parse } from "yaml";

import { gateHit, matchesAny } from "./paths.mjs";

export { globToRegExp, matchesAny } from "./paths.mjs";

const WORKFLOWS = ".github/workflows";

function readWorkflow(root, file) {
  return parse(readFileSync(path.join(root, WORKFLOWS, file), "utf8"));
}

/** A workflow's pull_request trigger: null when it has none, else its path filters (if any). */
export function pullRequestTrigger(workflow) {
  // `on` parses as the key "on" (YAML 1.2), not as `true`.
  const on = workflow.on;
  if (on === undefined || on === null) return null;
  if (typeof on === "string") return on === "pull_request" ? {} : null;
  if (Array.isArray(on)) return on.includes("pull_request") ? {} : null;
  if (!("pull_request" in on)) return null;
  const trigger = on.pull_request ?? {};
  return {
    ...(trigger.paths === undefined ? {} : { paths: trigger.paths }),
    ...(trigger["paths-ignore"] === undefined ? {} : { pathsIgnore: trigger["paths-ignore"] }),
  };
}

/** The obligations map with every `pathsFrom` replaced by that workflow's own path filters. */
export function loadObligations(root) {
  const map = JSON.parse(readFileSync(path.join(root, "tooling/verify/obligations.json"), "utf8"));
  return map.obligations.map((entry) => {
    if (entry.pathsFrom === undefined) return entry;
    const trigger = pullRequestTrigger(readWorkflow(root, entry.pathsFrom.workflow));
    if (trigger?.paths === undefined) {
      throw new Error(
        `obligations.json: ${entry.id} reads its paths from ${entry.pathsFrom.workflow}, which has no pull_request path filter`,
      );
    }
    return { ...entry, paths: trigger.paths };
  });
}

/** One owed item per `owes` entry of every map entry whose paths `files` touch. */
export function owedFor(obligations, files) {
  const owed = [];
  for (const entry of obligations) {
    const touched = files.filter((file) => matchesAny(file, entry.paths));
    if (touched.length === 0) continue;
    for (const owe of entry.owes) {
      const subject = owe.suite ?? owe.model ?? owe.name;
      owed.push({
        id: [entry.id, owe.kind, subject].filter((part) => part !== undefined).join(":"),
        kind: owe.kind,
        why: entry.why,
        status: "owed",
        ...(owe.command === undefined ? {} : { command: owe.command }),
        ...(owe.what === undefined ? {} : { what: owe.what }),
        ...(owe.ci === undefined ? {} : { ci: owe.ci }),
        detail: `touched: ${touched.slice(0, 5).join(", ")}${touched.length > 5 ? ` and ${touched.length - 5} more` : ""}`,
        // Not part of the printed result: what `verify status` and `verify check` match on.
        proof: owe.proof,
        ...(owe.suite === undefined ? {} : { suite: owe.suite }),
      });
    }
  }
  return owed;
}

/**
 * The CI jobs a pull request with these changed files runs: every job of every workflow whose
 * pull_request trigger matches, less the jobs a map entry gates (`gates`) when the files touch
 * none of its paths. Those jobs run under the same rule in CI (gate.mjs); no other job-level `if:`
 * is evaluated.
 */
export function ciJobsFor(root, files) {
  const obligations = loadObligations(root);
  const jobs = [];
  for (const file of readdirSync(path.join(root, WORKFLOWS)).toSorted()) {
    if (!file.endsWith(".yml") && !file.endsWith(".yaml")) continue;
    const workflow = readWorkflow(root, file);
    const trigger = pullRequestTrigger(workflow);
    if (trigger === null) continue;
    let why = "runs on every pull request";
    if (trigger.paths !== undefined) {
      const hit = files.find((changed) => matchesAny(changed, trigger.paths));
      if (hit === undefined) continue;
      why = `path filter matches ${hit}`;
    }
    if (
      trigger.pathsIgnore !== undefined &&
      files.every((f) => matchesAny(f, trigger.pathsIgnore))
    ) {
      continue;
    }
    const gates = obligations.filter((entry) => entry.gates?.workflow === file);
    for (const [id, job] of Object.entries(workflow.jobs ?? {})) {
      const gate = gates.find((entry) => entry.gates.jobs.includes(id));
      let jobWhy = why;
      if (gate !== undefined) {
        const hit = gateHit(obligations, gate.id, files);
        if (hit === undefined) continue;
        jobWhy = `${gate.id} covers ${hit}`;
      }
      // A matrix job is one check per `include` entry, named with that entry's values.
      const include = job.strategy?.matrix?.include;
      const variants = Array.isArray(include) && include.length > 0 ? include : [{}];
      for (const variant of variants) {
        const name = (job.name ?? id).replace(/\$\{\{\s*matrix\.([\w-]+)\s*\}\}/g, (whole, key) =>
          key in variant ? String(variant[key]) : whole,
        );
        jobs.push({ workflow: workflow.name ?? file, job: name, why: jobWhy });
      }
    }
  }
  return jobs;
}

/** Strips the matching keys `owedFor` keeps for its callers, leaving the printed obligation. */
export function printable(obligation) {
  return Object.fromEntries(
    Object.entries(obligation).filter(([key]) => key !== "proof" && key !== "suite"),
  );
}
