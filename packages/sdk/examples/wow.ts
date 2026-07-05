/**
 * The hero example — the verbatim fluent flow the marketing site commits to.
 *
 * This file is the SDK's living acceptance test: it must always compile against the public surface.
 * It is not yet runnable end-to-end (the client operations are typed stubs until the implementation
 * phases land); task #10 of the SDK plan turns this green against a real `docker compose` deployment.
 */
import { opencode, Sealant } from "@sealant/sdk";

const sealant = new Sealant({
  baseUrl: process.env["SEALANT_BASE_URL"] ?? "http://localhost:8080",
});

const sandbox = await sealant.sandboxes.create({
  repository: "github.com/acme/billing-service",
  harness: opencode(),
});

const run = await sandbox.harness.run("Round invoice totals once, after applying the discount.");

const replay = await run.record.replay();

console.log(`Replayed ${replay.entries.length} timeline entries for run ${run.id}.`);

await sealant.close();
