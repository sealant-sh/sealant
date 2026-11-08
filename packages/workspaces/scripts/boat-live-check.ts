import {
  constants,
  openSync,
  closeSync,
  fsyncSync,
  writeSync,
  readFileSync,
  mkdirSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import { z } from "zod";

import {
  boatProofConfigSchema,
  BoatProofError,
  MendProofClient,
  runBoatLiveCheck,
} from "../src/operator/boat-live-check.js";
import { makeBoatProofCore } from "../src/operator/boat-proof-core.js";
import { BoatProofProvider } from "../src/operator/boat-proof-provider.js";
import { HttpBoatApi } from "../src/runtime/boat/api.js";
import { loadBoatCredential } from "../src/runtime/boat/credential.js";

const main = async () => {
  const mode = process.argv[2];
  const directory = process.argv[3];
  if ((mode !== "run" && mode !== "cleanup") || directory === undefined)
    throw new BoatProofError("usage: run|cleanup <ledger-directory>");
  const config = boatProofConfigSchema.parse({
    origin: process.env.MEND_URL,
    projectId: process.env.BOAT_PROOF_PROJECT_ID,
    ownerId: process.env.BOAT_PROOF_OWNER_ID,
    deploymentId: process.env.SEALANT_BOAT_DEPLOYMENT_ID,
    resourceHost: process.env.BOAT_PROOF_RESOURCE_HOST,
    resourcePort: Number(process.env.BOAT_PROOF_RESOURCE_PORT),
    ...(process.env.BOAT_PROOF_IDLE_BUDGET_MS === undefined
      ? {}
      : { idleBudgetMs: Number(process.env.BOAT_PROOF_IDLE_BUDGET_MS) }),
  });
  const token = z.string().min(1).parse(process.env.MEND_TOKEN);
  const databaseUrl = z.string().min(1).parse(process.env.DATABASE_URL);
  const builderOwner = z.uuid().parse(process.env.SEALANT_BOAT_BUILDER_OWNER);
  const stateDirectory = z.string().startsWith("/").parse(process.env.SEALANT_BOAT_STATE_DIRECTORY);
  const credential = loadBoatCredential({ file: process.env.SEALANT_BOAT_API_KEY_FILE });
  if (!credential.ok) throw new BoatProofError("credential-file");
  const api = HttpBoatApi.create({ credential: credential.value });
  if (!api.ok) throw new BoatProofError("provider-config");
  const root = resolve(directory);
  if (mode === "run") {
    mkdirSync(root, { mode: 0o700 });
    const directoryParent = openSync(dirname(root), constants.O_RDONLY | constants.O_DIRECTORY);
    fsyncSync(directoryParent);
    closeSync(directoryParent);
  }
  const path = join(root, "operations.jsonl");
  const previous =
    mode === "run"
      ? []
      : readFileSync(path, "utf8")
          .trim()
          .split("\n")
          .map((line) => z.record(z.string(), z.unknown()).parse(JSON.parse(line)));
  const descriptor = openSync(
    path,
    constants.O_WRONLY |
      constants.O_APPEND |
      constants.O_NOFOLLOW |
      (mode === "run" ? constants.O_CREAT | constants.O_EXCL : 0),
    0o600,
  );
  const record = (event: Readonly<Record<string, unknown>>) => {
    writeSync(descriptor, JSON.stringify({ ...event, at: new Date().toISOString() }) + "\n");
    fsyncSync(descriptor);
  };
  const parent = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
  fsyncSync(descriptor);
  fsyncSync(parent);
  closeSync(parent);
  const mend = new MendProofClient(config.origin, token);
  const provider = new BoatProofProvider(credential.value);
  const core = makeBoatProofCore({
    config,
    databaseUrl,
    builderOwner,
    journalDirectory: join(stateDirectory, "native-builds"),
    api: api.value,
  });
  try {
    if (mode === "run") {
      await runBoatLiveCheck(config, mend, {
        ...core,
        record,
        inventory: () => provider.inventory(),
        privacy: async (id) => provider.privacy(await core.snapshotName(id)),
      });
    } else {
      const intent = z
        .object({
          event: z.literal("create-intent"),
          name: z.string(),
          ...boatProofConfigSchema.shape,
        })
        .parse(previous.find((e) => e.event === "create-intent"));
      if (JSON.stringify(boatProofConfigSchema.strip().parse(intent)) !== JSON.stringify(config))
        throw new BoatProofError("ledger-context-mismatch");
      const saved = previous.find((e) => e.event === "session");
      const session =
        saved === undefined
          ? await mend.find(config.projectId, intent.name)
          : await mend.session(z.string().parse(saved.id));
      const publications = new Set(
        previous.filter((e) => e.event === "runtime").map((e) => z.uuid().parse(e.publicationId)),
      );
      if (session !== undefined) {
        if (session.projectId !== config.projectId || session.name !== intent.name)
          throw new BoatProofError("cleanup-project");
        const observed = await core.runtime(session);
        if (observed !== undefined) publications.add(observed.publicationId);
        await mend.request("POST", `/sessions/${session.id}/stop`);
        const terminal = await core.runtime(session);
        if (terminal !== undefined && !terminal.closed)
          throw new BoatProofError("cleanup-pending; rerun cleanup in same ledger");
      }
      for (const id of publications) await core.withdraw(id);
      const inventory = await provider.inventory();
      record({ event: "cleanup-inventory", ...inventory });
      if (inventory.sandboxes.length !== 0 || inventory.snapshots.length !== 0)
        throw new BoatProofError("cleanup-inventory-not-empty");
    }
    record({ event: "completed", mode });
    process.stdout.write(`Boat proof ${mode} completed. Ledger: ${path}\n`);
  } finally {
    await core.dispose();
    closeSync(descriptor);
  }
};
try {
  await main();
} catch (error) {
  process.stderr.write(
    `${error instanceof BoatProofError ? error.message : "Boat live proof failed; inspect the owned ledger and use cleanup. No credentials were logged."}\n`,
  );
  process.exitCode = 1;
}
