// `pnpm verify db [suite...]`: a throwaway Postgres, migrated, the Boat runtime bundle staged, every
// gate variable set, and the named gated suites run with no skip allowed. It removes what it
// started (the container and the staged bundle) and nothing else.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadAllowedSkips, runCommandStep, runTestsStep } from "./check.mjs";

const IMAGE = "postgres:17";
const LABEL = "sh.sealant.verify=db";
// The catalog suite refuses any database but this disposable loopback one (catalog.db.test.ts).
const CATALOG = { role: "stage2a", password: "stage2a_fake_password", database: "stage2a" };

/**
 * The gated suites, by the test files they hold. `database` is every other test file that reads a
 * database gate, found by searching rather than listed, so a new database suite joins it unasked.
 */
export const SUITES = {
  database: {
    why: "Queries, migrations, leases and queues against a real, migrated Postgres",
    files: (root) => {
      const others = new Set(Object.values(STATIC_FILES).flat());
      return gitGrepFiles(root, DATABASE_GATES).filter(
        (file) => !others.has(file) && !file.endsWith(".docker.test.ts"),
      );
    },
  },
  "boat-catalog": {
    why: "Boat image custody: refused builds, retry after quarantine, retention, the staged bundle",
    files: () => STATIC_FILES["boat-catalog"],
  },
  "sealantd-runtime": {
    why: "The Effect runtime driving a real sealantd (the pinned one, from the staged bundle)",
    files: () => STATIC_FILES["sealantd-runtime"],
  },
};
const STATIC_FILES = {
  "boat-catalog": [
    "packages/workspaces/src/images/boat/catalog.db.test.ts",
    "packages/workspaces/src/images/boat/retention.db.test.ts",
    "packages/workspaces/src/images/boat/assets.test.ts",
  ],
  "sealantd-runtime": ["packages/workspaces/src/sealantd/runtime.test.ts"],
};
const DATABASE_GATES =
  "SEALANT_TEST_DATABASE_URL|SEALANT_JOBS_TEST_DATABASE_URL|process\\.env\\.DATABASE_URL";

function gitGrepFiles(root, pattern) {
  const out = execFileSync("git", ["grep", "-l", "-E", pattern, "--", "*.test.ts"], {
    cwd: root,
    encoding: "utf8",
  });
  return out.split("\n").filter((line) => line !== "");
}

/** `apps/api/src/x.test.ts` → `apps/api`: the package whose vitest config runs the file. */
function packageOf(file) {
  return file.split("/").slice(0, 2).join("/");
}

const docker = (args) =>
  execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function dockerAvailable() {
  try {
    docker(["info", "--format", "{{.ServerVersion}}"]);
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Starts the container and waits until Postgres accepts a query; returns its loopback port. */
async function startPostgres(name) {
  docker([
    "run",
    "--detach",
    "--rm",
    "--name",
    name,
    "--label",
    LABEL,
    "--env",
    "POSTGRES_PASSWORD=postgres",
    "--env",
    "POSTGRES_DB=sealant_test",
    "--publish",
    "127.0.0.1::5432",
    IMAGE,
  ]);
  const port = docker(["port", name, "5432/tcp"]).split(":").at(-1);
  // The image's entrypoint restarts the server once after initdb; a query over TCP succeeds only
  // after that restart, so wait for one instead of for the socket.
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      docker([
        "exec",
        name,
        "psql",
        "-h",
        "127.0.0.1",
        "-U",
        "postgres",
        "-d",
        "sealant_test",
        "-c",
        "select 1",
      ]);
      return port;
    } catch {
      await sleep(500);
    }
  }
  throw new Error(`Postgres in ${name} did not accept a query within 60 s`);
}

function psql(name, sql) {
  docker([
    "exec",
    name,
    "psql",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    "postgres",
    "-d",
    "sealant_test",
    "-c",
    sql,
  ]);
}

/**
 * Runs `suites` (names from SUITES; empty means all). Returns the steps, what it left behind, and
 * the commands that would turn a non-passed result into a passed one.
 */
export async function runDb({ root, suites, logDirectory, workers, echo = true }) {
  const names = suites.length === 0 ? Object.keys(SUITES) : suites;
  const log = (name) => path.join(logDirectory, `db-${name}.log`);
  const steps = [];
  const next = [];
  if (!dockerAvailable()) {
    steps.push({
      id: "postgres",
      title: `A throwaway ${IMAGE}`,
      status: "blocked_by_prerequisite",
      detail: "Docker is not available: `docker info` failed",
    });
    return { steps, next, left: [] };
  }

  const name = `sealant-verify-db-${process.pid}-${Date.now().toString(36)}`;
  const bundle = path.join(mkdtempSync(path.join(tmpdir(), "sealant-verify-db-")), "boat-assets");
  const started = { container: false };
  const cleanup = () => {
    const left = [];
    if (started.container) {
      try {
        docker(["rm", "--force", name]);
      } catch {
        left.push(`container ${name}`);
      }
    }
    try {
      rmSync(path.dirname(bundle), { recursive: true, force: true });
    } catch {
      left.push(path.dirname(bundle));
    }
    return left;
  };
  // An interrupted run still removes what it started.
  const onSignal = () => {
    cleanup();
    process.exit(130);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    const postgresStarted = Date.now();
    let port;
    try {
      started.container = true;
      port = await startPostgres(name);
      psql(name, `CREATE ROLE ${CATALOG.role} LOGIN PASSWORD '${CATALOG.password}'`);
      psql(name, `CREATE DATABASE ${CATALOG.database} OWNER ${CATALOG.role}`);
    } catch (error) {
      steps.push({
        id: "postgres",
        title: `A throwaway ${IMAGE}`,
        status: "blocked_by_prerequisite",
        durationMs: Date.now() - postgresStarted,
        detail: String(error.message).split("\n")[0],
      });
      return { steps, next, left: cleanup() };
    }
    steps.push({
      id: "postgres",
      title: `A throwaway ${IMAGE}`,
      status: "passed",
      durationMs: Date.now() - postgresStarted,
      detail: `container ${name} on 127.0.0.1:${port}`,
    });

    const url = `postgresql://postgres:postgres@127.0.0.1:${port}/sealant_test`;
    const gates = {
      SEALANT_TEST_DATABASE_URL: url,
      SEALANT_JOBS_TEST_DATABASE_URL: url,
      DATABASE_URL: url,
      SEALANT_BOAT_CATALOG_TEST_DATABASE_URL: `postgresql://${CATALOG.role}:${CATALOG.password}@127.0.0.1:${port}/${CATALOG.database}`,
      SEALANT_BOAT_RUNTIME_BUNDLE: bundle,
      SEALANTD_BIN: path.join(bundle, "sealantd"),
    };

    const migrate = await runCommandStep({
      root,
      id: "migrate",
      title: "Migrate the test database",
      argv: ["pnpm", "db:migrate"],
      env: { DATABASE_URL: url },
      logFile: log("migrate"),
      echo,
    });
    steps.push(migrate);
    const stage = await runCommandStep({
      root,
      id: "bundle",
      title: "Stage the Boat runtime bundle (the pinned sealantd)",
      argv: ["node", "packages/workspaces/boat-image/stage-assets.mjs", bundle],
      logFile: log("bundle"),
      echo,
    });
    // Staging downloads the pinned runtime from GHCR: a failure here is the network's, not the code's.
    steps.push(stage.status === "passed" ? stage : { ...stage, status: "blocked_by_prerequisite" });
    if (migrate.status !== "passed" || stage.status !== "passed")
      return { steps, next, left: cleanup() };

    for (const suite of names) {
      const files = SUITES[suite].files(root);
      const byPackage = Map.groupBy(files, packageOf);
      for (const [packageDirectory, packageFiles] of byPackage) {
        const id = `${suite}:${packageDirectory}`;
        const { step } = await runTestsStep({
          root,
          id,
          title: `${SUITES[suite].why} (${packageDirectory}, ${packageFiles.length} file${packageFiles.length === 1 ? "" : "s"})`,
          argv: [
            "pnpm",
            "--dir",
            packageDirectory,
            "exec",
            "vitest",
            "run",
            ...packageFiles.map((file) => path.relative(packageDirectory, file)),
            ...(workers === undefined ? [] : [`--maxWorkers=${workers}`]),
          ],
          env: gates,
          logFile: log(id.replaceAll("/", "-").replace(":", "-")),
          // No test may skip here: `db` is in no entry's `allowedIn`, so every skip is refused and
          // named with its gate.
          context: "db",
          owedSuites: [],
          allowedSkips: loadAllowedSkips(root),
          echo,
        });
        steps.push(step);
        if (step.status !== "passed") next.push(`pnpm verify db ${suite}`);
      }
    }
    return { steps, next: [...new Set(next)], left: cleanup() };
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}
