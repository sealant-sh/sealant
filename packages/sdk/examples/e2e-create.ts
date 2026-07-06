/**
 * Step 1 of the end-to-end: create a workspace (non-blocking) and print its id so we can watch the
 * worker build + launch it. Uses a relative import so it runs under tsx without self-resolution.
 */
import { opencode, Sealant } from "../src/index.js";

const sealant = new Sealant({
  baseUrl: process.env["SEALANT_BASE_URL"] ?? "http://127.0.0.1:4000",
});

const workspace = await sealant.workspaces.create({
  repository: "github.com/octocat/Hello-World",
  ref: "master",
  harness: opencode(),
  wait: false,
});

console.log(`WORKSPACE_ID=${workspace.id}`);
console.log(`STATUS=${await workspace.status()}`);

await sealant.close();
