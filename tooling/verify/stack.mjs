// `pnpm verify stack up | status | down`: the local stack the verify skill describes (Postgres from
// compose.yaml, migrated, the API and the web app in dev mode), up, checked and down. Ready means
// the API answered a request that reads the database and the web app served its page, not that a
// port opened. `down` removes only what `up` started: a Postgres that was already running stays.
import { execFileSync, spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import path from "node:path";

import { runLogged } from "./repo.mjs";

export const API_URL = "http://127.0.0.1:4000";
// Vite listens on localhost, which can be ::1 only; 127.0.0.1 would miss it.
export const WEB_URL = "http://localhost:3000";
const READY_MS = 180_000;
const STATE = ".verify/stack/state.json";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Whether the API is ready: `GET /v1/system/setup-state` (public; it reads the database) answers 200
 * with its `needsSetup` boolean. An open port, a 404 or a 500 is not ready.
 */
export async function apiReady(base = API_URL) {
  try {
    const response = await fetch(`${base}/v1/system/setup-state`, {
      signal: AbortSignal.timeout(5000),
    });
    if (response.status !== 200) return false;
    const body = await response.json();
    return typeof body?.needsSetup === "boolean";
  } catch {
    return false;
  }
}

/** Whether the web app is ready: its root answers 200 with an HTML page. */
export async function webReady(base = WEB_URL) {
  try {
    const response = await fetch(`${base}/`, { signal: AbortSignal.timeout(10_000) });
    return response.status === 200 && (await response.text()).includes("<html");
  } catch {
    return false;
  }
}

/** Whether something already listens on `port` of `host`. */
function portTaken(port, host) {
  return new Promise((resolve) => {
    const socket = connect({ port, host });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const docker = (root, args) =>
  execFileSync("docker", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

function readState(root) {
  const file = path.join(root, STATE);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
}

function writeState(root, state) {
  mkdirSync(path.dirname(path.join(root, STATE)), { recursive: true });
  writeFileSync(path.join(root, STATE), `${JSON.stringify(state, null, 2)}\n`);
}

/** Starts `argv` in its own process group, its output to `logFile`; returns its pid. */
function startDetached(root, argv, logFile) {
  mkdirSync(path.dirname(logFile), { recursive: true });
  const out = openSync(logFile, "a");
  const child = spawn(argv[0], argv.slice(1), {
    cwd: root,
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();
  return child.pid;
}

async function waitFor(check, pid, ms = READY_MS) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return "ready";
    if (!alive(pid)) return "exited";
    await sleep(1000);
  }
  return "timeout";
}

/** Stops a process group: SIGTERM, then SIGKILL after 10 s. Returns whether it is gone. */
async function stopGroup(pid) {
  if (!alive(pid)) return true;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    return !alive(pid);
  }
  for (let waited = 0; waited < 10_000 && alive(pid); waited += 250) await sleep(250);
  if (alive(pid)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Gone between the check and the kill.
    }
    await sleep(500);
  }
  return !alive(pid);
}

/** What `state` started that is still there, for a result's `cleanup.left`. */
function leftOf(state) {
  const left = [];
  for (const [name, started] of Object.entries(state.processes ?? {})) {
    if (alive(started.pid)) left.push(`${name} (process group ${started.pid})`);
  }
  if (state.postgresStarted) left.push("compose service postgres");
  return left;
}

export async function stackDown({ root, echo }) {
  const state = readState(root);
  if (state === null) {
    return {
      steps: [
        {
          id: "down",
          title: "Stop what `verify stack up` started",
          status: "passed",
          detail: "nothing started by `verify stack up` is recorded",
        },
      ],
      left: [],
    };
  }
  const steps = [];
  const left = [];
  for (const [name, started] of Object.entries(state.processes ?? {})) {
    const gone = await stopGroup(started.pid);
    steps.push({
      id: `stop:${name}`,
      title: `Stop the ${name} dev server`,
      status: gone ? "passed" : "failed",
      detail: `process group ${started.pid}`,
    });
    if (!gone) left.push(`${name} (process group ${started.pid})`);
  }
  if (state.postgresStarted) {
    const code = await runLogged({
      argv: ["docker", "compose", "rm", "--stop", "--force", "postgres"],
      cwd: root,
      logFile: path.join(root, ".verify/logs/stack-down.log"),
      echo,
    });
    steps.push({
      id: "stop:postgres",
      title: "Remove the postgres service it started (its volume stays)",
      status: code === 0 ? "passed" : "failed",
    });
    if (code !== 0) left.push("compose service postgres");
  } else {
    steps.push({
      id: "stop:postgres",
      title: "Leave the postgres service that was already running",
      status: "passed",
    });
  }
  if (left.length === 0) rmSync(path.join(root, STATE), { force: true });
  return { steps, left };
}

export async function stackStatus({ root }) {
  const state = readState(root);
  if (state === null) {
    return {
      steps: [
        {
          id: "stack",
          title: "A stack started by `verify stack up`",
          status: "skipped",
          detail: "none is recorded",
        },
      ],
      left: [],
      next: ["pnpm verify stack up"],
    };
  }
  const steps = [];
  for (const [name, check] of [
    ["api", apiReady],
    ["web", webReady],
  ]) {
    const started = state.processes?.[name];
    const running = started !== undefined && alive(started.pid);
    const ready = running && (await check());
    steps.push({
      id: name,
      title:
        name === "api"
          ? `The API answers ${API_URL}/v1/system/setup-state`
          : `The web app serves ${WEB_URL}/`,
      status: ready ? "passed" : "failed",
      detail: running
        ? ready
          ? `ready (process group ${started.pid}, built from ${state.head.slice(0, 8)})`
          : "running but not answering"
        : "not running",
      ...(started === undefined ? {} : { log: started.log }),
    });
  }
  const left = leftOf(state);
  return {
    steps,
    left,
    next: steps.every((step) => step.status === "passed")
      ? []
      : ["pnpm verify stack down", "pnpm verify stack up"],
  };
}

export async function stackUp({ root, head, echo }) {
  const steps = [];
  const existing = readState(root);
  if (existing !== null && leftOf(existing).length > 0) {
    const status = await stackStatus({ root });
    return {
      ...status,
      steps: [
        {
          id: "up",
          title: "A stack is already up",
          status: "passed",
          detail: `started at ${existing.startedAt} from ${existing.head.slice(0, 8)}`,
        },
        ...status.steps,
      ],
    };
  }
  const blocked = (id, title, detail) => {
    steps.push({ id, title, status: "blocked_by_prerequisite", detail });
    return { steps, left: [], next: [] };
  };
  try {
    docker(root, ["info", "--format", "{{.ServerVersion}}"]);
  } catch {
    return blocked("docker", "Docker for the postgres service", "`docker info` failed");
  }
  for (const [port, host, what] of [
    [4000, "127.0.0.1", "API"],
    [3000, "localhost", "web app"],
  ]) {
    if (await portTaken(port, host)) {
      return blocked(
        "ports",
        `Ports for the ${what}`,
        `something already listens on ${host}:${port}; stop it (another stack?) and retry`,
      );
    }
  }
  if (!existsSync(path.join(root, ".env"))) {
    copyFileSync(path.join(root, ".env.example"), path.join(root, ".env"));
    steps.push({
      id: "env",
      title: "A .env from .env.example (its defaults point at the local infra)",
      status: "passed",
      detail: "created; `down` leaves it",
    });
  }

  const state = {
    startedAt: new Date().toISOString(),
    head: head.sha,
    postgresStarted: false,
    processes: {},
  };
  const running = docker(root, ["compose", "ps", "--status", "running", "--services"]).split("\n");
  if (!running.includes("postgres")) {
    const code = await runLogged({
      argv: ["docker", "compose", "up", "--detach", "--wait", "postgres"],
      cwd: root,
      logFile: path.join(root, ".verify/logs/stack-postgres.log"),
      echo,
    });
    state.postgresStarted = code === 0;
    writeState(root, state);
    steps.push({
      id: "postgres",
      title: "Postgres from compose.yaml (:5433)",
      status: code === 0 ? "passed" : "failed",
      log: ".verify/logs/stack-postgres.log",
    });
    if (code !== 0) return { steps, left: leftOf(state), next: ["pnpm verify stack down"] };
  } else {
    steps.push({
      id: "postgres",
      title: "Postgres from compose.yaml (:5433)",
      status: "passed",
      detail: "already running; `down` leaves it",
    });
  }
  const migrate = await runLogged({
    argv: ["pnpm", "db:migrate"],
    cwd: root,
    logFile: path.join(root, ".verify/logs/stack-migrate.log"),
    echo,
  });
  steps.push({
    id: "migrate",
    title: "Migrate it",
    status: migrate === 0 ? "passed" : "failed",
    log: ".verify/logs/stack-migrate.log",
  });
  if (migrate !== 0) {
    const { left } = await stackDown({ root, echo });
    return { steps, left, next: [] };
  }

  for (const [name, filter, check, url] of [
    ["api", "@sealant/api", apiReady, `${API_URL}/v1/system/setup-state`],
    ["web", "@sealant/web", webReady, `${WEB_URL}/`],
  ]) {
    const log = `.verify/logs/stack-${name}.log`;
    const pid = startDetached(root, ["pnpm", "--filter", filter, "dev"], path.join(root, log));
    state.processes[name] = { pid, log };
    writeState(root, state);
    const started = Date.now();
    const outcome = await waitFor(check, pid);
    steps.push({
      id: name,
      title:
        name === "api"
          ? "The API, ready when setup-state answers from the database"
          : "The web app, ready when its page renders",
      status: outcome === "ready" ? "passed" : "failed",
      durationMs: Date.now() - started,
      log,
      detail:
        outcome === "ready"
          ? `${url} answered`
          : outcome === "exited"
            ? "the dev server exited"
            : `${url} did not answer in ${READY_MS / 1000} s`,
    });
    if (outcome !== "ready") {
      const { left } = await stackDown({ root, echo });
      return { steps, left, next: [] };
    }
  }
  return { steps, left: leftOf(state), next: ["pnpm verify stack down"] };
}
