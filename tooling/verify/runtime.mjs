// `pnpm verify runtime --runtime boat --live`: a live Boat launch, stop and resume against a real
// Mend deployment and a real Boat account, through the existing operator script
// (packages/workspaces/scripts/boat-live-check.ts), which keeps a durable ledger of what it made.
// Without every credential the script needs, nothing is started and the result is
// `requires_external_observer`: a live proof cannot be stood in for from here, so it is never
// `passed` without one.
import path from "node:path";

import { runLogged } from "./repo.mjs";

/** What boat-live-check.ts reads from the environment (names only; no value is ever printed). */
export const BOAT_LIVE_ENV = [
  "MEND_URL",
  "MEND_TOKEN",
  "BOAT_PROOF_PROJECT_ID",
  "BOAT_PROOF_OWNER_ID",
  "SEALANT_BOAT_DEPLOYMENT_ID",
  "BOAT_PROOF_RESOURCE_HOST",
  "BOAT_PROOF_RESOURCE_PORT",
  "DATABASE_URL",
  "SEALANT_BOAT_BUILDER_OWNER",
  "SEALANT_BOAT_STATE_DIRECTORY",
  "SEALANT_BOAT_API_KEY_FILE",
];

const SCRIPT = "scripts/boat-live-check.ts";

/** Runs the live Boat check when every credential is set; returns steps, evidence and next. */
export async function runBoatLive({ root, env = process.env, stamp, echo }) {
  const missing = BOAT_LIVE_ENV.filter((name) => (env[name] ?? "") === "");
  if (missing.length > 0) {
    return {
      steps: [
        {
          id: "boat-live",
          title: "A live Boat launch, stop and resume (boat-live-check.ts)",
          status: "requires_external_observer",
          detail: `not run: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not set. It needs a Mend deployment, a Boat account and its key; the local harness (\`pnpm boat:harness\`) fakes the provider and proves none of this.`,
        },
      ],
      evidence: [],
      next: [`set ${missing.join(", ")}, then pnpm verify runtime --runtime boat --live`],
    };
  }
  // The script refuses a ledger directory that exists, so each run gets its own.
  const ledger = path.join(root, ".verify", "runtime", `boat-${stamp}`);
  const log = path.join(root, ".verify", "logs", "runtime-boat.log");
  const cleanup = `pnpm --filter @sealant/workspaces exec tsx ${SCRIPT} cleanup ${ledger}`;
  const started = Date.now();
  const code = await runLogged({
    argv: ["pnpm", "--filter", "@sealant/workspaces", "exec", "tsx", SCRIPT, "run", ledger],
    cwd: root,
    logFile: log,
    echo,
  });
  return {
    steps: [
      {
        id: "boat-live",
        title: "A live Boat launch, stop and resume (boat-live-check.ts)",
        status: code === 0 ? "passed" : "failed",
        command: `pnpm --filter @sealant/workspaces exec tsx ${SCRIPT} run ${path.relative(root, ledger)}`,
        durationMs: Date.now() - started,
        log: path.relative(root, log),
        ...(code === 0
          ? {}
          : {
              detail: `exit ${code}; what it made is in the ledger, and cleanup removes only that`,
            }),
      },
    ],
    evidence: [
      { kind: "ledger", path: path.relative(root, path.join(ledger, "operations.jsonl")) },
    ],
    next: code === 0 ? [] : [cleanup],
  };
}
