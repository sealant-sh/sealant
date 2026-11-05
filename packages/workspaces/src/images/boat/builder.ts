import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  parseWorkspaceImageProbe,
  type WorkspaceBlueprint,
  type WorkspaceImageProbe,
} from "@sealant/validators";
import { z } from "zod";

import { IMAGE_PROBE_PATH, imagePersonLayoutSupport } from "../../buildkit/person-layout.js";
import type { BoatApi, BoatSavedSnapshot } from "../../runtime/boat/api.js";
import {
  boatDeletionIdSchema,
  boatSandboxIdSchema,
  boatSnapshotNameSchema,
  type BoatResult,
} from "../../runtime/boat/config.js";
import { createNativeRecipe, type NativeRecipe } from "./recipe.js";
import {
  NativeBuildError,
  nativeRuntimeIdentitySchema,
  sha256,
  type NativeResult,
  type VerifiedRuntimeBundle,
} from "./runtime-bundle.js";

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const identitySchema = z.object({
  name: boatSnapshotNameSchema,
  sourceSandboxId: boatSandboxIdSchema,
  createdAt: z.iso.datetime(),
  snapshotId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,256}$/)
    .optional(),
});
const artifactSchema = z.object({
  kind: z.literal("boat-saved-snapshot"),
  owner: z.uuid(),
  build: z.uuid(),
  recipeHash: hashSchema,
  receiptHash: hashSchema,
  runtime: nativeRuntimeIdentitySchema,
  identity: identitySchema,
});
/** Exact owned saved artifact. Source-and-creation fallback is a checked handle, never a disk digest. */
export type NativeSnapshotArtifact = z.infer<typeof artifactSchema>;

const allocationIntent = z.object({
  key: z.uuid(),
  requestedAt: z.iso.datetime(),
  requestVersion: z.union([z.literal(1), z.literal(2)]).default(1),
});
const allocationSchema = z.discriminatedUnion("state", [
  allocationIntent.extend({ state: z.literal("intent") }),
  allocationIntent.extend({
    state: z.literal("known"),
    id: boatSandboxIdSchema,
    deletion: boatDeletionIdSchema.optional(),
  }),
  allocationIntent.extend({
    state: z.literal("deleting"),
    id: boatSandboxIdSchema,
    deletion: boatDeletionIdSchema.optional(),
  }),
  allocationIntent.extend({
    state: z.literal("deleted"),
    id: boatSandboxIdSchema,
    deletion: boatDeletionIdSchema,
  }),
]);
const saveIntent = z.object({
  name: boatSnapshotNameSchema,
  sourceSandboxId: boatSandboxIdSchema,
  requestedAt: z.iso.datetime(),
});
const saveSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("none") }),
  saveIntent.extend({ state: z.literal("intent") }),
  saveIntent.extend({ state: z.literal("known"), identity: identitySchema }),
  saveIntent.extend({ state: z.literal("removed") }),
]);
const journalSchema = z.object({
  version: z.literal(1),
  owner: z.uuid(),
  build: z.uuid(),
  recipeHash: hashSchema,
  runtime: nativeRuntimeIdentitySchema,
  receiptHash: hashSchema.optional(),
  failureCode: z
    .string()
    .regex(/^native-[a-z_-]+$/)
    .optional(),
  phase: z.enum(["running", "cleanup", "published", "complete"]),
  allocation: allocationSchema,
  save: saveSchema,
});
type Journal = z.infer<typeof journalSchema>;

/** One cohesive owner of install, publication, reuse, removal, and interrupted-attempt cleanup. */
export interface IBoatSnapshotBuilder {
  build(input: {
    readonly spec: WorkspaceBlueprint;
    readonly previous?: NativeSnapshotArtifact;
    readonly signal?: AbortSignal;
    readonly onProgress?: (phase: "preparing" | "installing" | "saving" | "cleaning") => void;
  }): Promise<
    NativeResult<{
      readonly outcome: "built" | "reused";
      readonly artifact: NativeSnapshotArtifact;
      readonly journalPath?: string;
    }>
  >;
  findPublished(input: {
    readonly spec: WorkspaceBlueprint;
    readonly previous: NativeSnapshotArtifact;
  }): Promise<NativeResult<NativeSnapshotArtifact | null>>;
  remove(artifact: NativeSnapshotArtifact): Promise<NativeResult<"deleted" | "absent">>;
  cleanup(journalPath: string): Promise<NativeResult<void>>;
}

/** Explicit infrastructure and bounds, with no owner-global index or discovery operation. */
export interface BoatSnapshotBuilderOptions {
  readonly api: BoatApi;
  /** Cleanup and removal work without retaining a runtime bundle on the operator's machine. */
  readonly runtimeBundle?: VerifiedRuntimeBundle;
  readonly journalDirectory: string;
  readonly owner: string;
  readonly buildTimeoutMs?: number;
  readonly cleanupTimeoutMs?: number;
  readonly pollIntervalMs?: number;
}

const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
const failure = (error: unknown, path?: string) =>
  error instanceof NativeBuildError
    ? new NativeBuildError(error.code, path ?? error.journalPath)
    : new NativeBuildError("native-local-io-failed", path);

const noop = () => undefined;
const awaitProviderResponse = async <T>(
  request: () => Promise<BoatResult<T>>,
  signal: AbortSignal,
): Promise<T> => {
  if (signal.aborted) throw new NativeBuildError("native-interrupted");
  let abort: () => void = noop;
  try {
    return await Promise.race([
      request().then((r) => {
        if (!r.ok) throw new NativeBuildError(`native-provider-${r.error.code}`);
        return r.value;
      }),
      new Promise<never>((_, reject) => {
        abort = () => reject(new NativeBuildError("native-interrupted"));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
};
const pause = async (ms: number, signal: AbortSignal) => {
  if (signal.aborted) throw new NativeBuildError("native-interrupted");
  await new Promise<void>((done, reject) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      done();
    };
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(new NativeBuildError("native-interrupted"));
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
};

const sameIdentity = (
  expected: z.infer<typeof identitySchema>,
  actual: BoatSavedSnapshot,
): boolean =>
  expected.name === actual.name &&
  expected.sourceSandboxId === actual.sourceSandboxId &&
  expected.createdAt === actual.createdAt &&
  expected.snapshotId === actual.snapshotId;

const persist = async (path: string, journal: Journal) => {
  const temporary = `${path}.next-${randomUUID()}`;
  const file = await open(
    temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600,
  );
  try {
    await file.writeFile(JSON.stringify(journal) + "\n");
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
  const directory = await open(dirname(path), constants.O_RDONLY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
};

// A kernel advisory lock belongs to this attempt only and disappears on process loss.
const lockAttempt = async (path: string): Promise<() => Promise<void>> => {
  const file = await open(
    path + ".lock",
    constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
    0o600,
  );
  await file.close();
  const child = spawn(
    "flock",
    ["-n", path + ".lock", "sh", "-c", "printf 'locked\\n'; cat >/dev/null"],
    {
      env: { PATH: "/usr/bin:/bin" },
      stdio: ["pipe", "pipe", "ignore"],
    },
  );
  const exited = new Promise<void>((done) => child.once("close", () => done()));
  await new Promise<void>((done, reject) => {
    child.once("error", () => reject(new NativeBuildError("native-attempt-lock-failed")));
    child.once("exit", () => reject(new NativeBuildError("native-attempt-busy")));
    child.stdout.once("data", () => done());
  });
  return async () => {
    child.stdin.end();
    await exited;
  };
};

/** Unregistered internal native builder. Success includes completed scratch deletion. */
export class BoatSnapshotBuilder implements IBoatSnapshotBuilder {
  readonly #options: BoatSnapshotBuilderOptions;
  readonly #directory: string;

  constructor(options: BoatSnapshotBuilderOptions) {
    this.#options = options;
    this.#directory = resolve(options.journalDirectory);
  }

  async #directoryReady(): Promise<void> {
    if (!z.uuid().safeParse(this.#options.owner).success)
      throw new NativeBuildError("native-invalid-owner");
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const info = await stat(this.#directory);
    if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
      throw new NativeBuildError("native-unsafe-journal-directory");
  }

  #signal(cleanup = false): AbortSignal {
    return AbortSignal.timeout(
      cleanup
        ? (this.#options.cleanupTimeoutMs ?? 180_000)
        : (this.#options.buildTimeoutMs ?? 780_000),
    );
  }

  async #poll<T>(check: () => Promise<T | undefined>, signal: AbortSignal): Promise<T> {
    for (;;) {
      if (signal.aborted) throw new NativeBuildError("native-interrupted");
      const found = await check();
      if (found !== undefined) return found;
      await pause(this.#options.pollIntervalMs ?? 1500, signal);
    }
  }

  async #allocate(journal: Journal, path: string, signal: AbortSignal): Promise<void> {
    if (journal.allocation.state !== "intent") return;
    const allocation = journal.allocation;
    if (Date.now() - Date.parse(allocation.requestedAt) >= 23 * 60 * 60 * 1000)
      throw new NativeBuildError("native-idempotency-window-expired");
    let last: unknown;
    for (let retry = 0; retry < 3; retry++) {
      try {
        const vm = await awaitProviderResponse(
          () =>
            this.#options.api.create({
              marker: journal.build,
              idempotencyKey: allocation.key,
              purpose: "native-build",
              lifetime: { kind: "bounded", ttlSeconds: 900 },
              requestVersion: allocation.requestVersion,
            }),
          signal,
        );
        journal.allocation = { ...allocation, state: "known", id: vm.id };
        await persist(path, journal);
        return;
      } catch (error) {
        last = error;
        if (
          !(error instanceof NativeBuildError) ||
          ![
            "native-provider-transport_error",
            "native-provider-idempotency_in_progress",
            "native-provider-provider_error",
          ].includes(error.code)
        )
          throw error;
        await pause(this.#options.pollIntervalMs ?? 1500, signal);
      }
    }
    throw last;
  }

  async #deleteScratch(journal: Journal, path: string, signal: AbortSignal): Promise<void> {
    await this.#allocate(journal, path, signal);
    let allocation = journal.allocation;
    if (allocation.state !== "known" && allocation.state !== "deleting") return;
    const sandboxId = allocation.id;
    if (allocation.state === "known" && allocation.deletion === undefined) {
      const vm = await awaitProviderResponse(() => this.#options.api.get(sandboxId), signal);
      if (
        vm.id !== allocation.id ||
        vm.labels?.["sealant-build"] !== journal.build ||
        vm.labels["sealant-dev"] !== "boat-stream"
      )
        throw new NativeBuildError("native-sandbox-identity-mismatch");
      allocation = { ...allocation, state: "deleting" };
      journal.allocation = allocation;
      await persist(path, journal);
    }
    if (allocation.deletion === undefined) {
      const deletion = await awaitProviderResponse(
        () => this.#options.api.deleteSandbox(sandboxId),
        signal,
      );
      if (deletion.targetId !== allocation.id)
        throw new NativeBuildError("native-deletion-identity-mismatch");
      allocation.deletion = deletion.id;
      await persist(path, journal);
    }
    const deletionId = allocation.deletion;
    await this.#poll(async () => {
      const operation = await awaitProviderResponse(
        () => this.#options.api.getDeletion(deletionId),
        signal,
      );
      if (operation.id !== deletionId || operation.targetId !== allocation.id)
        throw new NativeBuildError("native-deletion-identity-mismatch");
      if (operation.status === "blocked") throw new NativeBuildError("native-deletion-blocked");
      return operation.status === "completed" ? true : undefined;
    }, signal);
    journal.allocation = { ...allocation, state: "deleted", deletion: deletionId };
    await persist(path, journal);
  }

  async #getSnapshot(
    name: z.infer<typeof boatSnapshotNameSchema>,
    signal: AbortSignal,
  ): Promise<BoatSavedSnapshot | null> {
    const result = await awaitProviderResponse<BoatSavedSnapshot | null>(async () => {
      const found = await this.#options.api.getSnapshot(name);
      return !found.ok && found.error.status === 404 ? { ok: true, value: null } : found;
    }, signal);
    if (result !== null && result.name !== name)
      throw new NativeBuildError("native-snapshot-identity-mismatch");
    return result;
  }

  async #observeSave(
    journal: Journal,
    path: string,
    signal: AbortSignal,
  ): Promise<BoatSavedSnapshot> {
    const save = journal.save;
    if (save.state !== "intent" && save.state !== "known")
      throw new NativeBuildError("native-save-intent-missing");
    const found = await this.#getSnapshot(save.name, signal);
    if (found === null) throw new NativeBuildError("native-save-unresolved");
    if (
      found.sourceSandboxId !== save.sourceSandboxId ||
      Date.parse(found.createdAt) < Date.parse(save.requestedAt) - 5000 ||
      (save.state === "known" &&
        (save.identity.name !== found.name ||
          save.identity.sourceSandboxId !== found.sourceSandboxId ||
          save.identity.createdAt !== found.createdAt ||
          (save.identity.snapshotId !== undefined &&
            save.identity.snapshotId !== found.snapshotId)))
    )
      throw new NativeBuildError("native-snapshot-identity-mismatch");
    if (
      save.state === "intent" ||
      (save.identity.snapshotId === undefined && found.snapshotId !== undefined)
    ) {
      journal.save = { ...save, state: "known", identity: identitySchema.parse(found) };
      await persist(path, journal);
    }
    return found;
  }

  async #saveOnceThenObserve(journal: Journal, path: string, signal: AbortSignal): Promise<void> {
    const save = journal.save;
    if (save.state !== "intent") throw new NativeBuildError("native-save-intent-missing");
    const saved = await awaitProviderResponse(
      () => this.#options.api.saveSnapshot(save.sourceSandboxId, save.name),
      signal,
    ).catch(async () => this.#observeSave(journal, path, signal));
    if (
      saved.name !== save.name ||
      saved.sourceSandboxId !== save.sourceSandboxId ||
      Date.parse(saved.createdAt) < Date.parse(save.requestedAt) - 5000
    )
      throw new NativeBuildError("native-snapshot-identity-mismatch");
    if (journal.save.state === "intent") {
      journal.save = { ...save, state: "known", identity: identitySchema.parse(saved) };
      await persist(path, journal);
    }
  }

  async #discardSave(journal: Journal, path: string, signal: AbortSignal): Promise<void> {
    const save = journal.save;
    if (save.state === "none" || save.state === "removed") return;
    const found = await this.#getSnapshot(save.name, signal);
    if (found === null) {
      if (save.state === "intent") throw new NativeBuildError("native-save-unresolved");
    } else {
      const settled = await this.#poll(async () => {
        const observed = await this.#observeSave(journal, path, signal);
        return observed.status === "saving" ? undefined : observed;
      }, signal);
      if (journal.save.state !== "known" || !sameIdentity(journal.save.identity, settled))
        throw new NativeBuildError("native-snapshot-identity-mismatch");
      await awaitProviderResponse(() => this.#options.api.deleteSnapshot(save.name), signal);
      await this.#poll(
        async () => ((await this.#getSnapshot(save.name, signal)) === null ? true : undefined),
        signal,
      );
    }
    journal.save = { ...save, state: "removed" };
    await persist(path, journal);
  }

  async #cleanup(journal: Journal, path: string): Promise<void> {
    const signal = this.#signal(true);
    let deletionError: unknown;
    try {
      await this.#deleteScratch(journal, path, signal);
    } catch (error) {
      deletionError = error;
    }
    if (journal.phase !== "published") await this.#discardSave(journal, path, signal);
    if (deletionError !== undefined) throw deletionError;
    if (journal.phase !== "published") journal.phase = "complete";
    await persist(path, journal);
  }

  async #install(
    recipe: NativeRecipe,
    journal: Journal,
    signal: AbortSignal,
  ): Promise<{ receiptHash: string; probe: WorkspaceImageProbe }> {
    const allocation = journal.allocation;
    if (allocation.state !== "known") throw new NativeBuildError("native-allocation-missing");
    const id = allocation.id;
    const stage = `/home/user/sealant-dev-boat-stream-${journal.build}`;
    const command = async (script: string, timeoutSeconds = 30) => {
      const output = await awaitProviderResponse(
        () => this.#options.api.execute(id, `set -eu\n${script}`, { timeoutSeconds, signal }),
        signal,
      );
      if (output.exitCode !== 0 || output.timedOut)
        throw new NativeBuildError("native-guest-command-failed");
      return output.stdout;
    };
    await command(`install -d -m700 ${quote(stage)}`);
    for (let i = 0; i < recipe.files.length; i++) {
      const file = recipe.files[i];
      if (file === undefined) throw new NativeBuildError("native-file-missing");
      const staged = `${stage}/file-${i}`;
      await awaitProviderResponse(
        () => this.#options.api.uploadFile(id, staged, file.bytes),
        signal,
      );
      await command(
        `echo '${file.sha256}  '${quote(staged)} | sha256sum -c - >/dev/null\n/usr/bin/sudo install -D -m${file.mode} ${quote(staged)} ${quote(file.path)}`,
      );
    }
    await awaitProviderResponse(
      () => this.#options.api.writeFile(id, `${stage}/install.sh`, recipe.installScript),
      signal,
    );
    await command(
      `echo '${sha256(recipe.installScript)}  '${quote(stage + "/install.sh")} | sha256sum -c - >/dev/null\n/usr/bin/sudo /bin/bash ${quote(stage + "/install.sh")}`,
      600,
    );
    await command(
      recipe.files
        .map(
          (file) => `echo '${file.sha256}  ${file.path}' | /usr/bin/sudo sha256sum -c - >/dev/null`,
        )
        .join("\n"),
    );
    const probe = parseWorkspaceImageProbe(
      JSON.parse(await command(`/usr/bin/sudo cat ${IMAGE_PROBE_PATH}`)),
    );
    if (imagePersonLayoutSupport(probe).status !== "supported")
      throw new NativeBuildError("native-person-capabilities-unsupported");
    const receipt =
      JSON.stringify({
        version: 1,
        owner: journal.owner,
        build: journal.build,
        recipeHash: recipe.hash,
        runtime: recipe.runtime,
        substrate: recipe.substrate,
        probe,
      }) + "\n";
    await awaitProviderResponse(
      () => this.#options.api.writeFile(id, stage + "/receipt.json", receipt),
      signal,
    );
    const receiptHash = sha256(receipt);
    await command(
      `/usr/bin/sudo install -m600 ${quote(stage + "/receipt.json")} /etc/sealant/native-receipt.json\necho '${receiptHash}  /etc/sealant/native-receipt.json' | /usr/bin/sudo sha256sum -c - >/dev/null\nls -d ${quote(stage)}\nrm -rf ${quote(stage)}`,
    );
    return { receiptHash, probe };
  }

  /** Build a clean artifact, or explicitly reuse the previous exact owned publication. */
  async build(
    input: Parameters<IBoatSnapshotBuilder["build"]>[0],
  ): ReturnType<IBoatSnapshotBuilder["build"]> {
    if (this.#options.runtimeBundle === undefined)
      return { ok: false, error: new NativeBuildError("native-runtime-bundle-required") };
    const planned = await createNativeRecipe(input.spec, this.#options.runtimeBundle);
    if (!planned.ok) return planned;
    if (input.previous !== undefined) {
      const reused = await this.findPublished({ spec: input.spec, previous: input.previous });
      if (!reused.ok) return reused;
      if (reused.value !== null)
        return { ok: true, value: { outcome: "reused", artifact: reused.value } };
    }
    const recipe = planned.value;
    const build = randomUUID();
    const path = join(this.#directory, build + ".json");
    let unlock: (() => Promise<void>) | undefined;
    let journal: Journal | undefined;
    try {
      await this.#directoryReady();
      unlock = await lockAttempt(path);
      const bound = this.#signal();
      const signal = input.signal === undefined ? bound : AbortSignal.any([bound, input.signal]);
      if (signal.aborted) throw new NativeBuildError("native-interrupted");
      const attempt: Journal = {
        version: 1,
        owner: this.#options.owner,
        build,
        recipeHash: recipe.hash,
        runtime: recipe.runtime,
        phase: "running",
        allocation: {
          state: "intent",
          key: randomUUID(),
          requestedAt: new Date().toISOString(),
          requestVersion: 2,
        },
        save: { state: "none" },
      };
      journal = attempt;
      await persist(path, attempt);
      input.onProgress?.("preparing");
      await this.#allocate(attempt, path, signal);
      const allocation = attempt.allocation;
      if (allocation.state !== "known") throw new NativeBuildError("native-allocation-missing");
      await this.#poll(async () => {
        const vm = await awaitProviderResponse(() => this.#options.api.get(allocation.id), signal);
        if (
          vm.id !== allocation.id ||
          vm.labels?.["sealant-build"] !== attempt.build ||
          vm.labels["sealant-dev"] !== "boat-stream"
        )
          throw new NativeBuildError("native-sandbox-identity-mismatch");
        if (["error", "cancelled", "archived"].includes(vm.state))
          throw new NativeBuildError("native-sandbox-failed");
        return ["ready", "idle", "running"].includes(vm.state) ? true : undefined;
      }, signal);
      input.onProgress?.("installing");
      const installed = await this.#install(recipe, attempt, signal);
      attempt.receiptHash = installed.receiptHash;
      const name = boatSnapshotNameSchema.parse(
        `sealant-dev-boat-stream-${build.replaceAll("-", "")}`,
      );
      attempt.save = {
        state: "intent",
        name,
        sourceSandboxId: allocation.id,
        requestedAt: new Date().toISOString(),
      };
      await persist(path, attempt);
      input.onProgress?.("saving");
      await this.#saveOnceThenObserve(attempt, path, signal);
      const ready = await this.#poll(async () => {
        const observed = await this.#observeSave(attempt, path, signal);
        if (observed.status === "failed") throw new NativeBuildError("native-save-failed");
        return observed.status === "ready" ? observed : undefined;
      }, signal);
      input.onProgress?.("cleaning");
      await this.#deleteScratch(attempt, path, this.#signal(true));
      if (signal.aborted) throw new NativeBuildError("native-interrupted");
      const artifact = artifactSchema.parse({
        kind: "boat-saved-snapshot",
        owner: attempt.owner,
        build,
        recipeHash: recipe.hash,
        receiptHash: installed.receiptHash,
        runtime: recipe.runtime,
        identity: ready,
      });
      attempt.phase = "published";
      await persist(path, attempt);
      return { ok: true, value: { outcome: "built", artifact, journalPath: path } };
    } catch (error) {
      if (journal !== undefined) {
        try {
          journal.phase = "cleanup";
          journal.failureCode = failure(error).code;
          await persist(path, journal);
          await this.#cleanup(journal, path);
        } catch {
          return { ok: false, error: new NativeBuildError("native-cleanup-pending", path) };
        }
      }
      return { ok: false, error: failure(error, journal === undefined ? undefined : path) };
    } finally {
      await unlock?.();
    }
  }

  async #ownedArtifact(artifact: NativeSnapshotArtifact): Promise<void> {
    await this.#directoryReady();
    const path = join(this.#directory, artifact.build + ".json");
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
        throw new NativeBuildError("native-unsafe-journal");
      const journal = journalSchema.parse(JSON.parse(await file.readFile("utf8")));
      if (
        journal.owner !== artifact.owner ||
        journal.build !== artifact.build ||
        journal.phase !== "published" ||
        journal.allocation.state !== "deleted" ||
        journal.save.state !== "known" ||
        journal.recipeHash !== artifact.recipeHash ||
        journal.receiptHash !== artifact.receiptHash ||
        JSON.stringify(journal.runtime) !== JSON.stringify(artifact.runtime) ||
        JSON.stringify(journal.save.identity) !== JSON.stringify(artifact.identity)
      )
        throw new NativeBuildError("native-artifact-not-owned");
    } finally {
      await file.close();
    }
  }

  /** Reuse only the caller's exact artifact, its recipe, owner, receipt, and runtime identity. */
  async findPublished(
    input: Parameters<IBoatSnapshotBuilder["findPublished"]>[0],
  ): ReturnType<IBoatSnapshotBuilder["findPublished"]> {
    try {
      if (this.#options.runtimeBundle === undefined)
        throw new NativeBuildError("native-runtime-bundle-required");
      const artifact = artifactSchema.parse(input.previous);
      if (artifact.owner !== this.#options.owner)
        throw new NativeBuildError("native-owner-mismatch");
      await this.#ownedArtifact(artifact);
      const recipe = await createNativeRecipe(input.spec, this.#options.runtimeBundle);
      if (!recipe.ok) return recipe;
      if (
        artifact.recipeHash !== recipe.value.hash ||
        JSON.stringify(artifact.runtime) !== JSON.stringify(recipe.value.runtime)
      )
        return { ok: true, value: null };
      const found = await this.#getSnapshot(artifact.identity.name, this.#signal());
      if (found === null) return { ok: true, value: null };
      if (!sameIdentity(artifact.identity, found))
        throw new NativeBuildError("native-snapshot-identity-mismatch");
      return { ok: true, value: found.status === "ready" ? artifact : null };
    } catch (error) {
      return { ok: false, error: failure(error) };
    }
  }

  /** Explicit removal validates all provider identity facts immediately before deletion. */
  async remove(input: NativeSnapshotArtifact): Promise<NativeResult<"deleted" | "absent">> {
    let unlock: (() => Promise<void>) | undefined;
    try {
      const artifact = artifactSchema.parse(input);
      if (artifact.owner !== this.#options.owner)
        throw new NativeBuildError("native-owner-mismatch");
      await this.#directoryReady();
      unlock = await lockAttempt(join(this.#directory, artifact.build + ".json"));
      await this.#ownedArtifact(artifact);
      const signal = this.#signal(true);
      const found = await this.#getSnapshot(artifact.identity.name, signal);
      if (found === null) return { ok: true, value: "absent" };
      if (!sameIdentity(artifact.identity, found))
        throw new NativeBuildError("native-snapshot-identity-mismatch");
      if (found.status === "saving") throw new NativeBuildError("native-save-pending");
      await awaitProviderResponse(
        () => this.#options.api.deleteSnapshot(artifact.identity.name),
        signal,
      );
      await this.#poll(
        async () =>
          (await this.#getSnapshot(artifact.identity.name, signal)) === null ? true : undefined,
        signal,
      );
      return { ok: true, value: "deleted" };
    } catch (error) {
      return { ok: false, error: failure(error) };
    } finally {
      await unlock?.();
    }
  }

  /** Reconcile one private durable attempt, never account-wide objects or an implicit index. */
  async cleanup(pathInput: string): Promise<NativeResult<void>> {
    const path = resolve(pathInput);
    let unlock: (() => Promise<void>) | undefined;
    try {
      await this.#directoryReady();
      if (
        dirname(path) !== this.#directory ||
        !/^[a-f0-9-]{36}\.json$/.test(path.slice(this.#directory.length + 1))
      )
        throw new NativeBuildError("native-invalid-journal-path");
      unlock = await lockAttempt(path);
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      let journal: Journal;
      try {
        const info = await file.stat();
        if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
          throw new NativeBuildError("native-unsafe-journal");
        journal = journalSchema.parse(JSON.parse(await file.readFile("utf8")));
      } finally {
        await file.close();
      }
      if (
        journal.owner !== this.#options.owner ||
        path !== join(this.#directory, journal.build + ".json")
      )
        throw new NativeBuildError("native-owner-mismatch");
      await this.#cleanup(journal, path);
      return { ok: true, value: undefined };
    } catch (error) {
      return { ok: false, error: failure(error, path) };
    } finally {
      await unlock?.();
    }
  }
}
