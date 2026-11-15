// `pnpm verify boat-harness --preflight | status`: before an hour-long Boat harness run, whether it
// can start here and which of its four groups the diff needs; and who holds the host lock now. It
// starts nothing: the host's state comes from the harness's own read-only boat-harness/preflight.ts,
// the groups from boat-harness.yml's matrix.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { parse } from "yaml";

import { matchesAny } from "./paths.mjs";
import { loadObligations } from "./plan.mjs";

const PACKAGE = "packages/workspaces";
const HARNESS_DIR = `${PACKAGE}/boat-harness`;

/** The four groups CI runs, each with its harness file (repo-relative), from boat-harness.yml. */
export function harnessGroups(root) {
  const workflow = parse(
    readFileSync(path.join(root, ".github/workflows/boat-harness.yml"), "utf8"),
  );
  return workflow.jobs.harness.strategy.matrix.include.map(({ group, files }) => ({
    group,
    file: `${PACKAGE}/${files}`,
  }));
}

/** The harness files `file` imports, transitively, inside boat-harness/ (repo-relative). */
function localClosure(root, file) {
  const seen = new Set();
  const queue = [file];
  while (queue.length > 0) {
    const next = queue.pop();
    if (seen.has(next) || !existsSync(path.join(root, next))) continue;
    seen.add(next);
    for (const [, specifier] of readFileSync(path.join(root, next), "utf8").matchAll(
      /from\s+["'](\.\/[^"']+)["']/g,
    )) {
      queue.push(path.join(path.dirname(next), specifier.replace(/\.js$/, ".ts")));
    }
  }
  return seen;
}

/**
 * Which groups a diff needs, and why. Nothing when it touches no harness path. A file only some
 * groups' harness files import needs those groups; the twin image, the harness's shared code and
 * the product code it drives need all four; the harness's unit tests and docs need none.
 */
export function groupsFor(root, files) {
  const groups = harnessGroups(root);
  const harnessPaths = loadObligations(root).find((entry) => entry.id === "boat-harness").paths;
  const touched = files.filter((file) => matchesAny(file, harnessPaths));
  if (touched.length === 0) return { groups: [], why: "the diff touches no Boat harness path" };
  const closures = groups.map(({ group, file }) => ({ group, files: localClosure(root, file) }));
  const needed = new Set();
  const reasons = [];
  for (const file of touched) {
    const inside = file.startsWith(`${HARNESS_DIR}/`);
    if (
      inside &&
      (file.endsWith(".test.ts") || !/\.(ts|mjs)$/.test(file)) &&
      !file.startsWith(`${HARNESS_DIR}/twin/`)
    ) {
      continue;
    }
    const owners = closures.filter((closure) => closure.files.has(file)).map(({ group }) => group);
    const all =
      !inside ||
      file.startsWith(`${HARNESS_DIR}/twin/`) ||
      owners.length === 0 ||
      owners.length === groups.length;
    for (const group of all ? groups.map((g) => g.group) : owners) needed.add(group);
    reasons.push(
      `${path.relative(PACKAGE, file).startsWith("..") ? file : path.relative(PACKAGE, file)} → ${all ? "every group" : owners.join(", ")}`,
    );
  }
  const chosen = groups.filter(({ group }) => needed.has(group));
  return {
    groups: chosen,
    why:
      reasons.length === 0
        ? "only the harness's unit tests or docs"
        : reasons.slice(0, 6).join("; "),
  };
}

const probe = (argv) => {
  try {
    return {
      ok: true,
      out: execFileSync(argv[0], argv.slice(1), {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim(),
    };
  } catch {
    return { ok: false, out: "" };
  }
};

/** Docker, cgroup v2, WireGuard and openssl: what the harness README says the host needs. */
export function hostSteps() {
  const steps = [];
  const info = probe([
    "docker",
    "info",
    "--format",
    "{{.CgroupVersion}} {{json .SecurityOptions}}",
  ]);
  if (!info.ok) {
    steps.push({
      id: "docker",
      title: "Docker",
      status: "blocked_by_prerequisite",
      detail: "`docker info` failed",
    });
  } else {
    const [cgroup] = info.out.split(" ");
    const rootless = info.out.includes("rootless");
    steps.push({
      id: "docker",
      title: "Docker with privileged containers and cgroup v2",
      status: cgroup === "2" && !rootless ? "passed" : "blocked_by_prerequisite",
      detail:
        cgroup !== "2"
          ? `cgroup v${cgroup}; the twins need v2`
          : rootless
            ? "rootless Docker cannot run the privileged twins"
            : "cgroup v2, not rootless",
    });
  }
  const wireguard = existsSync("/sys/module/wireguard");
  steps.push({
    id: "wireguard",
    title: "Kernel WireGuard (the twins share the host's kernel and cannot load it)",
    status: wireguard ? "passed" : "blocked_by_prerequisite",
    detail: wireguard ? "loaded" : "not loaded: `sudo modprobe wireguard`",
  });
  const openssl = probe(["openssl", "version"]);
  steps.push({
    id: "openssl",
    title: "openssl (the fake Boat's TLS)",
    status: openssl.ok ? "passed" : "blocked_by_prerequisite",
    detail: openssl.ok ? openssl.out : "not on PATH",
  });
  return steps;
}

const CLEANUP = "pnpm --filter @sealant/workspaces exec tsx boat-harness/cleanup.ts --remove";

/** Reads boat-harness/preflight.ts; null when it could not run (no Docker, no install). */
export function harnessState(root) {
  const run = probe([
    "pnpm",
    "--dir",
    path.join(root, PACKAGE),
    "exec",
    "tsx",
    "boat-harness/preflight.ts",
  ]);
  if (!run.ok) return null;
  return JSON.parse(run.out.split("\n").at(-1));
}

/** Steps from the harness's own view of the host: the lock, leftovers, foreign objects, the twin. */
export function stateSteps(state, { withTwin }) {
  if (state === null) {
    return {
      steps: [
        {
          id: "lock",
          title: "The harness host lock",
          status: "blocked_by_prerequisite",
          detail: "boat-harness/preflight.ts could not run (Docker, or `pnpm install`)",
        },
      ],
      next: [],
    };
  }
  const steps = [];
  const next = [];
  steps.push({
    id: "lock",
    title: "The harness host lock (one run per Docker host)",
    status: state.lock.state === "live" ? "blocked_by_prerequisite" : "passed",
    detail:
      state.lock.state === "live"
        ? `held by run ${state.lock.run}, whose heartbeat is live; a new run waits for it (up to 2 h)`
        : state.lock.state === "stale"
          ? `held by finished run ${state.lock.run}; the next run takes it over`
          : "free",
  });
  steps.push({
    id: "leftovers",
    title: "No finished run's labelled objects (a run refuses to start beside them)",
    status: state.leftovers.length === 0 ? "passed" : "blocked_by_prerequisite",
    detail: state.leftovers.length === 0 ? "none" : `runs ${state.leftovers.join(", ")}`,
  });
  if (state.leftovers.length > 0) next.push(CLEANUP);
  steps.push({
    id: "foreign",
    title: "No sealant resource or Boat gateway objects of another deployment",
    status: state.foreign.length === 0 ? "passed" : "blocked_by_prerequisite",
    detail:
      state.foreign.length === 0
        ? "none"
        : `${state.foreign.slice(0, 5).join(", ")}: stop that deployment, or set BOAT_HARNESS_ALLOW_SHARED_DOCKER=1`,
  });
  if (withTwin) {
    steps.push({
      id: "twin",
      title: "The twin base image cache",
      status: "passed",
      detail: state.twin.cached
        ? `${state.twin.tag} is built`
        : `${state.twin.tag} is not built: the run builds it first, from the Ubuntu archive (minutes, and network access)`,
    });
  }
  return { steps, next };
}

export function runPreflight({ root, files }) {
  const { groups, why } = groupsFor(root, files);
  const { steps, next } = stateSteps(harnessState(root), { withTwin: true });
  const groupStep = {
    id: "groups",
    title: "The harness groups this diff needs",
    status: "passed",
    detail:
      groups.length === 0 ? `none: ${why}` : `${groups.map((g) => g.group).join(", ")} (${why})`,
  };
  return {
    steps: [...hostSteps(), ...steps, groupStep],
    next: [
      ...next,
      ...groups.map(({ file }) => `pnpm boat:harness ${path.relative(PACKAGE, file)}`),
    ],
  };
}

export function runHarnessStatus({ root }) {
  return stateSteps(harnessState(root), { withTwin: false });
}
