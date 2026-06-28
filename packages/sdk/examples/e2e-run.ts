/**
 * End-to-end: create a sandbox, run the harness in it, replay the recorded run.
 * The whole fluent loop against a live, self-hosted deployment. Relative import so it runs under tsx.
 */
import { opencode, Sealant } from "../src/index.js";

const sealant = new Sealant({
  baseUrl: process.env["SEALANT_BASE_URL"] ?? "http://127.0.0.1:4000",
});

console.log("→ creating sandbox (build + launch)…");
const sandbox = await sealant.sandboxes.create({
  repository: "github.com/octocat/Hello-World",
  ref: "master",
  harness: opencode(),
});
console.log(`✓ sandbox ready: ${sandbox.id} (${await sandbox.status()})`);

console.log("→ running harness…");
const run = await sandbox.harness.run(
  "Append a line that says: Hello from Sealant. to the README file.",
);

console.log("→ changes:");
for (const file of run.changes.files) {
  console.log(`   ${file.change}\t${file.path}`);
}
console.log(
  (await run.changes.diff())
    .split("\n")
    .map((l) => `   | ${l}`)
    .join("\n"),
);

console.log("→ replaying the record — what the harness actually ran:");
console.log(await run.record.transcript());
console.log(`✓ run ${run.id} — ${run.result.status} (exit ${run.result.exitCode})`);

const summary = await run.record.summary();
console.log(`✓ summary: ${JSON.stringify(summary)}`);
const loss = await run.record.loss();
console.log(`✓ loss.complete: ${loss.complete}`);

await sealant.close();
console.log("✓ done");
