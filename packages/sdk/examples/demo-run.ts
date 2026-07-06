/**
 * Demo: create a server-executed run (the worker docker-execs it in the workspace and records
 * telemetry), then follow the record through the public SDK until it is terminal.
 *
 *   pnpm exec tsx packages/sdk/examples/demo-run.ts <workspaceId> <ownerUserId>
 */
import { Sealant } from "../src/index.js";

const baseUrl = process.env["SEALANT_BASE_URL"] ?? "http://127.0.0.1:4000";
const [workspaceId, ownerUserId] = process.argv.slice(2);
if (workspaceId === undefined || ownerUserId === undefined) {
  console.error("usage: demo-run.ts <workspaceId> <ownerUserId>");
  process.exit(1);
}

const script = [
  "set -e",
  'echo "sealant demo · inspecting the repo"',
  "ls",
  'grep -n "theme" README.md | head -5 || true',
  "printf '\\n## Demo note\\n\\nThis line was written by a recorded Sealant run.\\n' >> README.md",
  "git status --short",
  'echo "sealant demo · done"',
].join("\n");

const created = await fetch(`${baseUrl}/v1/runs`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    workspaceId,
    ownerUserId,
    harnessId: "sh",
    prompt: "Add a demo note to the README and report the working-tree state",
    command: { executable: "sh", args: ["-lc", script], cwd: "/workspace/repo" },
  }),
});
if (!created.ok) {
  console.error("createRun failed:", created.status, await created.text());
  process.exit(1);
}
const { runId } = (await created.json()) as { runId: string };
console.log("created run:", runId);

const sealant = new Sealant({ baseUrl });
try {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const run = await sealant.runs.get(runId);
    const status = run.result.status;
    process.stdout.write(`status=${status}\n`);
    if (status === "completed" || status === "failed" || status === "cancelled") {
      const summary = await run.record.summary();
      console.log("record summary:", JSON.stringify(summary));
      const commands = await run.record.commands();
      for (const command of commands) {
        console.log(
          `$ ${command.command} -> exit ${command.exitCode ?? "?"} (${command.stdoutBytes}B out, ${command.stderrBytes}B err)`,
        );
      }
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
} finally {
  await sealant.close();
}
