/**
 * Starts the stack and keeps it up for debugging; Ctrl-C tears it down.
 *
 *   pnpm exec tsx boat-harness/up.ts            # just the stack
 *   pnpm exec tsx boat-harness/up.ts --launch   # plus one Boat workspace, left as it ends
 */
import { awaitOutcome, launch, openProject } from "./scenario.js";
import { startStack } from "./stack.js";

const stack = await startStack();
const say = (value: unknown) => process.stderr.write(`[boat-harness] ${JSON.stringify(value)}\n`);
say({
  runId: stack.runId,
  scratch: stack.scratch,
  api: stack.apiUrl,
  boat: stack.boat.baseUrl,
  database: stack.databaseUrl,
  owner: stack.ownerId,
});
if (process.argv.includes("--launch")) {
  const project = await openProject(stack);
  const run = await launch(stack, project);
  say({ workspace: run.workspace.id, runId: run.runId });
  const outcome = await awaitOutcome(stack, run, 30 * 60_000);
  say({ outcome: outcome.status, runtime: outcome.view });
  say({ vms: stack.boat.liveSandboxes().map((vm) => [vm.id, vm.container, vm.state]) });
}
// The stack tears itself down on SIGINT or SIGTERM.
await new Promise(() => undefined);
