import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  parseWorkspaceImageProbe,
  nativeBuildOwnershipSchema,
  nativeSnapshotArtifactSchema,
  nativePublicationEvidenceSchema,
  type NativeBuildOwnership,
  type NativePublicationEvidence,
  type WorkspaceBlueprint,
} from "@sealant/validators";
import { z } from "zod";

import { IMAGE_PROBE_PATH, imagePersonLayoutSupport } from "../../buildkit/person-layout.js";
import { BOAT_AGENT_MANIFEST_FILE } from "../../runtime/boat/agent-contract.js";
import {
  boatBuildOwnershipLabels,
  type BoatApi,
  type BoatSavedSnapshot,
} from "../../runtime/boat/api.js";
import {
  BoatBuildOwnership,
  boatDeletionIdSchema,
  boatSandboxIdSchema,
  boatSnapshotNameSchema,
  type BoatResult,
} from "../../runtime/boat/config.js";
import { sealantdHasRecoveryBoot } from "../../runtime/daemon-recovery.js";
import {
  nativeCommandFailure,
  nativeCommandFailureSchema,
  nativeProviderFailureSchema,
  type NativeCommandFailure,
} from "./command-diagnostics.js";
import { createNativeRecipe, type NativeRecipe } from "./recipe.js";
import {
  NativeBuildError,
  nativeRuntimeIdentitySchema,
  sha256,
  type NativeResult,
  type VerifiedRuntimeBundle,
} from "./runtime-bundle.js";

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
/** The agent the image carries, as the receipt records it: the digest every bind request names. */
const agentEvidenceSchema = z.object({ manifestDigest: hashSchema });
const identitySchema = z.object({
  name: boatSnapshotNameSchema,
  sourceSandboxId: boatSandboxIdSchema,
  createdAt: z.iso.datetime(),
  snapshotId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,256}$/)
    .optional(),
});
const artifactSchema = nativeSnapshotArtifactSchema;
/** Exact owned saved artifact. Source-and-creation fallback is a checked handle, never a disk digest. */
export type NativeSnapshotArtifact = z.infer<typeof artifactSchema>;

const allocationIntent = z.object({
  key: z.uuid(),
  requestedAt: z.iso.datetime(),
  requestVersion: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(1),
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
  ownership: nativeBuildOwnershipSchema.optional(),
  evidence: nativePublicationEvidenceSchema.optional(),
  removal: z.enum(["intent", "complete"]).optional(),
  failureCode: z
    .string()
    .regex(/^native-[a-z_-]+$/)
    .optional(),
  commandFailure: nativeCommandFailureSchema.optional(),
  providerFailure: nativeProviderFailureSchema.optional(),
  phase: z.enum(["running", "cleanup", "published", "complete"]),
  allocation: allocationSchema,
  save: saveSchema,
});
type Journal = z.infer<typeof journalSchema>;

/** One cohesive owner of install, publication, reuse, removal, and interrupted-attempt cleanup. */
export interface IBoatSnapshotBuilder {
  /** Prepare complete identity before reserving any provider work. */
  plan(
    spec: WorkspaceBlueprint,
  ): Promise<
    NativeResult<
      Pick<NativeBuildOwnership["key"], "recipeHash" | "runtime" | "assetsHash" | "platform">
    >
  >;
  build(input: {
    readonly spec: WorkspaceBlueprint;
    readonly ownership?: NativeBuildOwnership;
    readonly previous?: NativeSnapshotArtifact;
    readonly signal?: AbortSignal;
    readonly onProgress?: (phase: "preparing" | "installing" | "saving" | "cleaning") => void;
  }): Promise<
    NativeResult<{
      readonly outcome: "built" | "reused";
      readonly artifact: NativeSnapshotArtifact;
      readonly evidence: NativePublicationEvidence;
      readonly journalPath?: string;
    }>
  >;
  findPublished(input: {
    readonly spec: WorkspaceBlueprint;
    readonly previous: NativeSnapshotArtifact;
    readonly evidence?: NativePublicationEvidence;
  }): Promise<NativeResult<NativeSnapshotArtifact | null>>;
  remove(artifact: NativeSnapshotArtifact): Promise<NativeResult<"deleted" | "absent">>;
  cleanup(journalPath: string): Promise<NativeResult<void>>;
  /** Bounded enumeration contains parsed obligations, never raw journal rows. */
  journals(input: {
    readonly limit: number;
    readonly after?: string;
  }): Promise<NativeResult<NativeJournalPage>>;
  /** Locks and observes an attempt. It never replays installation or save. */
  reconcileBuild(
    ownership: NativeBuildOwnership,
    expected?: {
      readonly artifact: NativeSnapshotArtifact;
      readonly evidence: NativePublicationEvidence;
    },
  ): Promise<NativeResult<NativeBuildRecovery>>;
}

/** Reconciliation preserves unknown work and only adopts complete published evidence. */
export type NativeBuildRecovery =
  | {
      readonly kind: "published";
      readonly artifact: NativeSnapshotArtifact;
      readonly evidence: NativePublicationEvidence;
    }
  | { readonly kind: "abandoned"; readonly failureCode?: string }
  | { readonly kind: "missing" };
/** Private journal inventory, bounded by caller-supplied page size. */
export interface NativeJournalPage {
  readonly entries: ReadonlyArray<{
    readonly buildId: string;
    readonly ownership?: NativeBuildOwnership;
  }>;
  readonly failures: ReadonlyArray<{ readonly name: string; readonly error: NativeBuildError }>;
  readonly next?: string;
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
    ? new NativeBuildError(
        error.code,
        path ?? error.journalPath,
        error.commandFailure,
        error.providerFailure,
      )
    : new NativeBuildError("native-local-io-failed", path);

const noop = () => undefined;
/** A save Boat answered with a refusal (4xx) other than a save already under way. */
const savedNothing = (error: unknown) => {
  if (!(error instanceof NativeBuildError)) return false;
  const status = error.providerFailure?.status ?? null;
  return (
    status !== null &&
    status >= 400 &&
    status < 500 &&
    error.providerFailure?.boat !== undefined &&
    !["save_in_progress", "idempotency_in_progress"].includes(error.providerFailure.boat.code ?? "")
  );
};

const awaitProviderResponse = async <T>(
  request: () => Promise<BoatResult<T>>,
  signal: AbortSignal,
): Promise<T> => {
  if (signal.aborted) throw new NativeBuildError("native-interrupted");
  let abort: () => void = noop;
  try {
    return await Promise.race([
      request().then((r) => {
        if (!r.ok)
          throw new NativeBuildError(
            `native-provider-${r.error.code}`,
            undefined,
            undefined,
            nativeProviderFailureSchema.parse(r.error),
          );
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
    constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    0o600,
  );
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o077) !== 0
    )
      throw new NativeBuildError("native-unsafe-journal-lock");
  } finally {
    await file.close();
  }
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
    const info = await lstat(this.#directory);
    if (
      (await realpath(this.#directory)) !== this.#directory ||
      !info.isDirectory() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o077) !== 0
    )
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

  #buildOwnership(journal: Journal): BoatBuildOwnership {
    const parsed = BoatBuildOwnership.parse({
      owner: journal.owner,
      reservation: journal.ownership,
    });
    if (!parsed.ok) throw new NativeBuildError("native-build-ownership-missing");
    return parsed.value;
  }

  #matchesAllocation(
    journal: Journal,
    labels: Readonly<Record<string, string>> | undefined,
  ): boolean {
    const expected =
      journal.allocation.requestVersion === 3
        ? boatBuildOwnershipLabels(this.#buildOwnership(journal))
        : { "sealant-build": journal.build, "sealant-dev": "boat-stream" };
    return Object.entries(expected).every(([key, value]) => labels?.[key] === value);
  }

  async #allocate(journal: Journal, path: string, signal: AbortSignal): Promise<void> {
    if (journal.allocation.state !== "intent") return;
    const allocation = journal.allocation;
    if (allocation.requestVersion === 3) {
      const ownership = this.#buildOwnership(journal);
      const discovered = await this.#options.api.discover(ownership);
      if (discovered.kind === "conflict") throw new NativeBuildError("native-allocation-conflict");
      if (discovered.kind === "found") {
        journal.allocation = { ...allocation, state: "known", id: discovered.sandbox.id };
        await persist(path, journal);
        return;
      }
      if (discovered.reason === "inventory-unavailable")
        throw new NativeBuildError("native-allocation-unknown");
    }
    if (Date.now() - Date.parse(allocation.requestedAt) >= 23 * 60 * 60 * 1000)
      throw new NativeBuildError("native-idempotency-window-expired");
    let last: unknown;
    for (let retry = 0; retry < 3; retry++) {
      try {
        const vm = await awaitProviderResponse(
          () =>
            this.#options.api.create(
              allocation.requestVersion === 3
                ? {
                    idempotencyKey: allocation.key,
                    buildOwnership: this.#buildOwnership(journal),
                    requestVersion: 3,
                    lifetime: { kind: "bounded", ttlSeconds: 900 },
                  }
                : {
                    marker: journal.build,
                    idempotencyKey: allocation.key,
                    purpose: "native-build",
                    lifetime: { kind: "bounded", ttlSeconds: 900 },
                    requestVersion: allocation.requestVersion,
                  },
            ),
          signal,
        );
        journal.allocation = { ...allocation, state: "known", id: vm.id };
        await persist(path, journal);
        return;
      } catch (error) {
        last = error;
        // Retried: Boat did not answer, is still settling this key, or asked to wait (a rate
        // limit, no machine now). A refusal no retry can change (the key, its permissions,
        // billing, the plan) ends the build with Boat's reason.
        if (
          !(error instanceof NativeBuildError) ||
          !(
            error.code === "native-provider-idempotency_in_progress" ||
            error.providerFailure?.boat?.retryable === true
          )
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
      if (vm.id !== allocation.id || !this.#matchesAllocation(journal, vm.labels))
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
      return !found.ok &&
        found.error.status === 404 &&
        (found.error.code === "not_found" || found.error.code === "snapshot_not_found")
        ? { ok: true, value: null }
        : found;
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
    ).catch(async (error: unknown) => {
      // Boat refused the save outright (the snapshot allowance, billing, the key): it holds no
      // snapshot for it, and its reason is the build's. Any other outcome may have saved one.
      if (savedNothing(error)) throw error;
      return this.#observeSave(journal, path, signal);
    });
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
    redactions: readonly string[],
  ): Promise<NativePublicationEvidence> {
    const allocation = journal.allocation;
    if (allocation.state !== "known") throw new NativeBuildError("native-allocation-missing");
    const id = allocation.id;
    const stage = `/home/user/sealant-dev-boat-stream-${journal.build}`;
    const command = async (
      step: NativeCommandFailure["step"],
      script: string,
      timeoutSeconds = 30,
    ) => {
      const output = await awaitProviderResponse(
        () => this.#options.api.execute(id, `set -eu\n${script}`, { timeoutSeconds, signal }),
        signal,
      ).catch((error: unknown) => {
        if (error instanceof NativeBuildError && error.providerFailure !== undefined)
          throw new NativeBuildError(error.code, error.journalPath, error.commandFailure, {
            ...error.providerFailure,
            step,
          });
        throw error;
      });
      if (output.exitCode !== 0 || output.timedOut)
        throw new NativeBuildError(
          "native-guest-command-failed",
          undefined,
          nativeCommandFailure(step, output, redactions),
        );
      return output.stdout;
    };
    await command("stage-directory", `install -d -m700 ${quote(stage)}`);
    for (let i = 0; i < recipe.files.length; i++) {
      const file = recipe.files[i];
      if (file === undefined) throw new NativeBuildError("native-file-missing");
      const staged = `${stage}/file-${i}`;
      await awaitProviderResponse(
        () => this.#options.api.uploadFile(id, staged, file.bytes),
        signal,
      );
      await command(
        "install-asset",
        `echo '${file.sha256}  '${quote(staged)} | sha256sum -c - >/dev/null\n/usr/bin/sudo install -D -m${file.mode} ${quote(staged)} ${quote(file.path)}`,
      );
    }
    await awaitProviderResponse(
      () => this.#options.api.writeFile(id, `${stage}/install.sh`, recipe.installScript),
      signal,
    );
    await command(
      "install-recipe",
      `echo '${sha256(recipe.installScript)}  '${quote(stage + "/install.sh")} | sha256sum -c - >/dev/null\n/usr/bin/sudo /bin/bash ${quote(stage + "/install.sh")}`,
      600,
    );
    await command(
      "verify-assets",
      recipe.files
        .map(
          (file) => `echo '${file.sha256}  ${file.path}' | /usr/bin/sudo sha256sum -c - >/dev/null`,
        )
        .join("\n"),
    );
    const probe = parseWorkspaceImageProbe(
      JSON.parse(await command("read-image-probe", `/usr/bin/sudo cat ${IMAGE_PROBE_PATH}`)),
    );
    if (imagePersonLayoutSupport(probe).status !== "supported")
      throw new NativeBuildError("native-person-capabilities-unsupported");
    // The manifest the installed image carries is the one the recipe planned: what the bind CLI
    // will compare every bind request against.
    const manifest = z
      .object({ digest: hashSchema })
      .parse(
        JSON.parse(
          await command("read-agent-manifest", `/usr/bin/sudo cat ${BOAT_AGENT_MANIFEST_FILE}`),
        ),
      );
    if (manifest.digest !== recipe.agentManifestDigest)
      throw new NativeBuildError("native-agent-manifest-mismatch");
    const agent = agentEvidenceSchema.parse({ manifestDigest: manifest.digest });
    const receipt =
      JSON.stringify({
        version: 4,
        ownership: journal.ownership,
        assetsHash: recipe.assetsHash,
        owner: journal.owner,
        build: journal.build,
        recipeHash: recipe.hash,
        runtime: recipe.runtime,
        substrate: recipe.substrate,
        dockerService: recipe.dockerService,
        agent,
        probe,
      }) + "\n";
    await awaitProviderResponse(
      () => this.#options.api.writeFile(id, stage + "/receipt.json", receipt),
      signal,
    );
    const receiptHash = sha256(receipt);
    await command(
      "install-receipt",
      `/usr/bin/sudo install -D -m600 ${quote(stage + "/receipt.json")} /etc/sealant/native-receipt.json\necho '${receiptHash}  /etc/sealant/native-receipt.json' | /usr/bin/sudo sha256sum -c - >/dev/null\nls -d ${quote(stage)}\nrm -rf ${quote(stage)}`,
    );
    const capabilities = z
      .object({ supports: z.array(z.string()), daemonVersion: z.string().optional() })
      .safeParse(probe.sealantd);
    return {
      receiptHash,
      receipt,
      imageProbe: probe,
      runtime: recipe.runtime,
      recipeHash: recipe.hash,
      assetsHash: recipe.assetsHash,
      daemonRecovery: capabilities.success
        ? sealantdHasRecoveryBoot(recipe.runtime.source, []) === true
          ? "supported"
          : "unsupported"
        : "unknown",
      executorRecovery: "unverified",
    };
  }

  /** Complete recipe identity includes every installed asset byte and the verified runtime. */
  async plan(spec: WorkspaceBlueprint): ReturnType<IBoatSnapshotBuilder["plan"]> {
    if (this.#options.runtimeBundle === undefined)
      return { ok: false, error: new NativeBuildError("native-runtime-bundle-required") };
    const recipe = await createNativeRecipe(spec, this.#options.runtimeBundle);
    return recipe.ok
      ? {
          ok: true,
          value: {
            recipeHash: recipe.value.hash,
            assetsHash: recipe.value.assetsHash,
            runtime: recipe.value.runtime,
            platform: recipe.value.platform,
          },
        }
      : recipe;
  }

  /** Build a clean artifact, or explicitly reuse the previous exact owned publication. */
  async build(
    input: Parameters<IBoatSnapshotBuilder["build"]>[0],
  ): ReturnType<IBoatSnapshotBuilder["build"]> {
    if (this.#options.runtimeBundle === undefined)
      return { ok: false, error: new NativeBuildError("native-runtime-bundle-required") };
    const planned = await createNativeRecipe(input.spec, this.#options.runtimeBundle);
    if (!planned.ok) return planned;
    const recipe = planned.value;
    const ownership =
      input.ownership === undefined
        ? undefined
        : nativeBuildOwnershipSchema.safeParse(input.ownership);
    if (
      ownership !== undefined &&
      (!ownership.success ||
        ownership.data.key.recipeHash !== recipe.hash ||
        ownership.data.key.assetsHash !== recipe.assetsHash ||
        !isDeepStrictEqual(ownership.data.key.runtime, recipe.runtime))
    )
      return { ok: false, error: new NativeBuildError("native-build-ownership-mismatch") };
    if (input.previous !== undefined) {
      const reused = await this.findPublished({ spec: input.spec, previous: input.previous });
      if (!reused.ok) return reused;
      if (input.ownership !== undefined && input.previous.build !== input.ownership.buildId)
        return { ok: false, error: new NativeBuildError("native-build-ownership-mismatch") };
      if (reused.value !== null) {
        try {
          return {
            ok: true,
            value: {
              outcome: "reused",
              artifact: reused.value,
              evidence: await this.#evidence(reused.value),
            },
          };
        } catch (error) {
          return { ok: false, error: failure(error) };
        }
      }
    }
    const build = ownership?.success ? ownership.data.buildId : randomUUID();
    const path = join(this.#directory, build + ".json");
    let unlock: (() => Promise<void>) | undefined;
    let journal: Journal | undefined;
    try {
      await this.#directoryReady();
      unlock = await lockAttempt(path);
      const existing = await this.#readJournal(path, true);
      if (existing !== undefined) {
        if (
          !isDeepStrictEqual(existing.ownership, input.ownership) ||
          existing.recipeHash !== recipe.hash
        )
          throw new NativeBuildError("native-build-ownership-mismatch");
        const recovered = await this.#recover(existing, path);
        if (recovered.kind === "published")
          return {
            ok: true,
            value: {
              outcome: "reused",
              artifact: recovered.artifact,
              evidence: recovered.evidence,
              journalPath: path,
            },
          };
        return {
          ok: false,
          error: new NativeBuildError(
            existing.failureCode ?? "native-build-abandoned",
            path,
            existing.commandFailure,
            existing.providerFailure,
          ),
        };
      }
      const bound = this.#signal();
      const signal = input.signal === undefined ? bound : AbortSignal.any([bound, input.signal]);
      if (signal.aborted) throw new NativeBuildError("native-interrupted");
      const attempt: Journal = {
        version: 1,
        owner: this.#options.owner,
        build,
        recipeHash: recipe.hash,
        runtime: recipe.runtime,
        ...(ownership?.success ? { ownership: ownership.data } : {}),
        phase: "running",
        allocation: {
          state: "intent",
          key: randomUUID(),
          requestedAt: new Date().toISOString(),
          requestVersion: ownership?.success ? 3 : 2,
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
        if (vm.id !== allocation.id || !this.#matchesAllocation(attempt, vm.labels))
          throw new NativeBuildError("native-sandbox-identity-mismatch");
        if (["error", "cancelled", "archived"].includes(vm.state))
          throw new NativeBuildError("native-sandbox-failed");
        return ["ready", "idle", "running"].includes(vm.state) ? true : undefined;
      }, signal);
      input.onProgress?.("installing");
      const installed = await this.#install(recipe, attempt, signal, [
        ...Object.values(input.spec.runtime.env),
        ...Object.values(input.spec.runtime.userEnv),
      ]);
      attempt.receiptHash = installed.receiptHash;
      attempt.evidence = installed;
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
      return {
        ok: true,
        value: { outcome: "built", artifact, evidence: installed, journalPath: path },
      };
    } catch (error) {
      if (journal !== undefined) {
        try {
          if (journal.phase === "published")
            return {
              ok: false,
              error: new NativeBuildError("native-publication-commit-pending", path),
            };
          journal.phase = "cleanup";
          journal.failureCode = failure(error).code;
          journal.commandFailure = failure(error).commandFailure;
          journal.providerFailure = failure(error).providerFailure;
          await persist(path, journal);
          await this.#cleanup(journal, path);
        } catch {
          return {
            ok: false,
            error: new NativeBuildError(
              "native-cleanup-pending",
              path,
              failure(error).commandFailure,
              failure(error).providerFailure,
            ),
          };
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
    const journal = await this.#readJournal(path);
    if (
      journal === undefined ||
      journal.owner !== artifact.owner ||
      journal.build !== artifact.build ||
      journal.phase !== "published" ||
      journal.allocation.state !== "deleted" ||
      journal.save.state !== "known" ||
      journal.recipeHash !== artifact.recipeHash ||
      journal.receiptHash !== artifact.receiptHash ||
      !isDeepStrictEqual(journal.runtime, artifact.runtime) ||
      !isDeepStrictEqual(journal.save.identity, artifact.identity)
    )
      throw new NativeBuildError("native-artifact-not-owned");
  }

  async #evidence(artifact: NativeSnapshotArtifact): Promise<NativePublicationEvidence> {
    const journal = await this.#readJournal(join(this.#directory, artifact.build + ".json"));
    if (journal?.evidence === undefined)
      throw new NativeBuildError("native-publication-evidence-missing");
    this.#checkEvidence(journal);
    return journal.evidence;
  }

  #checkEvidence(journal: Journal): void {
    const evidence = journal.evidence;
    if (
      evidence === undefined ||
      evidence.receiptHash !== journal.receiptHash ||
      sha256(evidence.receipt) !== evidence.receiptHash ||
      evidence.recipeHash !== journal.recipeHash ||
      !isDeepStrictEqual(evidence.runtime, journal.runtime)
    )
      throw new NativeBuildError("native-publication-evidence-mismatch");
    const receipt = z
      .object({
        version: z.literal(4),
        agent: agentEvidenceSchema,
        owner: z.uuid(),
        build: z.uuid(),
        recipeHash: hashSchema,
        assetsHash: hashSchema,
        runtime: nativeRuntimeIdentitySchema,
        probe: z.unknown(),
        ownership: nativeBuildOwnershipSchema.optional(),
      })
      .parse(JSON.parse(evidence.receipt));
    if (
      receipt.owner !== journal.owner ||
      receipt.build !== journal.build ||
      receipt.recipeHash !== journal.recipeHash ||
      receipt.assetsHash !== evidence.assetsHash ||
      !isDeepStrictEqual(receipt.runtime, journal.runtime) ||
      !isDeepStrictEqual(receipt.probe, evidence.imageProbe) ||
      !isDeepStrictEqual(receipt.ownership, journal.ownership)
    )
      throw new NativeBuildError("native-publication-evidence-mismatch");
  }

  async #readJournal(path: string, missing = false): Promise<Journal | undefined> {
    let file;
    try {
      file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if (missing && z.object({ code: z.literal("ENOENT") }).safeParse(error).success)
        return undefined;
      throw error;
    }
    try {
      const info = await file.stat();
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        info.size > 1048576 ||
        info.uid !== process.getuid?.() ||
        (info.mode & 0o077) !== 0
      )
        throw new NativeBuildError("native-unsafe-journal");
      const journal = journalSchema.parse(JSON.parse(await file.readFile("utf8")));
      if (
        journal.owner !== this.#options.owner ||
        path !== join(this.#directory, journal.build + ".json")
      )
        throw new NativeBuildError("native-owner-mismatch");
      if (
        journal.ownership !== undefined &&
        (journal.build !== journal.ownership.buildId ||
          journal.recipeHash !== journal.ownership.key.recipeHash ||
          !isDeepStrictEqual(journal.runtime, journal.ownership.key.runtime))
      )
        throw new NativeBuildError("native-build-ownership-mismatch");
      return journal;
    } finally {
      await file.close();
    }
  }

  async #recover(journal: Journal, path: string): Promise<NativeBuildRecovery> {
    if (journal.phase === "published") {
      if (journal.removal !== undefined) throw new NativeBuildError("native-publication-retiring");
      this.#checkEvidence(journal);
      if (
        journal.save.state !== "known" ||
        journal.allocation.state !== "deleted" ||
        journal.evidence === undefined
      )
        throw new NativeBuildError("native-publication-incomplete");
      const artifact = artifactSchema.parse({
        kind: "boat-saved-snapshot",
        owner: journal.owner,
        build: journal.build,
        recipeHash: journal.recipeHash,
        receiptHash: journal.receiptHash,
        runtime: journal.runtime,
        identity: journal.save.identity,
      });
      const found = await this.#getSnapshot(artifact.identity.name, this.#signal());
      if (found === null || !sameIdentity(artifact.identity, found) || found.status !== "ready")
        throw new NativeBuildError("native-snapshot-identity-mismatch");
      return { kind: "published", artifact, evidence: journal.evidence };
    }
    await this.#cleanup(journal, path);
    return {
      kind: "abandoned",
      ...(journal.failureCode === undefined ? {} : { failureCode: journal.failureCode }),
    };
  }

  /** Adoption is an observation under the same kernel lock as build and cleanup. */
  async reconcileBuild(
    ownership: NativeBuildOwnership,
    expected?: {
      readonly artifact: NativeSnapshotArtifact;
      readonly evidence: NativePublicationEvidence;
    },
  ): Promise<NativeResult<NativeBuildRecovery>> {
    let unlock: (() => Promise<void>) | undefined;
    try {
      const parsed = nativeBuildOwnershipSchema.parse(ownership);
      await this.#directoryReady();
      const path = join(this.#directory, parsed.buildId + ".json");
      unlock = await lockAttempt(path);
      const journal = await this.#readJournal(path, true);
      if (journal === undefined) return { ok: true, value: { kind: "missing" } };
      if (!isDeepStrictEqual(journal.ownership, parsed))
        throw new NativeBuildError("native-build-ownership-mismatch");
      if (expected !== undefined) {
        await this.#ownedArtifact(expected.artifact);
        if (!isDeepStrictEqual(await this.#evidence(expected.artifact), expected.evidence))
          throw new NativeBuildError("native-publication-evidence-mismatch");
      }
      return { ok: true, value: await this.#recover(journal, path) };
    } catch (error) {
      return { ok: false, error: failure(error) };
    } finally {
      await unlock?.();
    }
  }

  /** Only direct, private regular files in the configured root can become sweep obligations. */
  async journals(input: {
    readonly limit: number;
    readonly after?: string;
  }): Promise<NativeResult<NativeJournalPage>> {
    try {
      await this.#directoryReady();
      if (
        !Number.isInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > 200 ||
        (input.after !== undefined &&
          (input.after.length === 0 ||
            input.after.length > 256 ||
            /[/\\]/.test(input.after) ||
            input.after.includes("\0")))
      )
        throw new NativeBuildError("native-invalid-journal-page");
      const names = (await readdir(this.#directory))
        .filter((name) => !name.endsWith(".lock"))
        .toSorted()
        .filter((name) => input.after === undefined || name > input.after);
      const entries: Array<{ buildId: string; ownership?: NativeBuildOwnership }> = [];
      const failures: Array<{ name: string; error: NativeBuildError }> = [];
      for (const name of names.slice(0, input.limit)) {
        try {
          if (!/^[a-f0-9-]{36}\.json$/.test(name))
            throw new NativeBuildError("native-invalid-journal-path");
          const journal = await this.#readJournal(join(this.#directory, name));
          if (journal !== undefined)
            entries.push({
              buildId: journal.build,
              ...(journal.ownership === undefined ? {} : { ownership: journal.ownership }),
            });
        } catch (error) {
          failures.push({ name, error: failure(error) });
        }
      }
      return {
        ok: true,
        value: {
          entries,
          failures,
          ...(names.length > input.limit ? { next: names[input.limit - 1] } : {}),
        },
      };
    } catch (error) {
      return { ok: false, error: failure(error) };
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
      const evidence = await this.#evidence(artifact);
      if (input.evidence !== undefined && !isDeepStrictEqual(input.evidence, evidence))
        throw new NativeBuildError("native-publication-evidence-mismatch");
      const journal = await this.#readJournal(join(this.#directory, artifact.build + ".json"));
      if (journal?.removal !== undefined) throw new NativeBuildError("native-publication-retiring");
      const recipe = await createNativeRecipe(input.spec, this.#options.runtimeBundle);
      if (!recipe.ok) return recipe;
      if (
        artifact.recipeHash !== recipe.value.hash ||
        !isDeepStrictEqual(artifact.runtime, recipe.value.runtime)
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
      const path = join(this.#directory, artifact.build + ".json");
      const journal = await this.#readJournal(path);
      if (journal === undefined) throw new NativeBuildError("native-journal-missing");
      if (journal.removal === "complete") return { ok: true, value: "absent" };
      const signal = this.#signal(true);
      const found = await this.#getSnapshot(artifact.identity.name, signal);
      if (found === null) {
        journal.removal = "complete";
        await persist(path, journal);
        return { ok: true, value: "absent" };
      }
      if (!sameIdentity(artifact.identity, found))
        throw new NativeBuildError("native-snapshot-identity-mismatch");
      if (found.status === "saving") throw new NativeBuildError("native-save-pending");
      journal.removal = "intent";
      await persist(path, journal);
      await awaitProviderResponse(
        () => this.#options.api.deleteSnapshot(artifact.identity.name),
        signal,
      );
      await this.#poll(
        async () =>
          (await this.#getSnapshot(artifact.identity.name, signal)) === null ? true : undefined,
        signal,
      );
      journal.removal = "complete";
      await persist(path, journal);
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
        pathInput !== path ||
        dirname(path) !== this.#directory ||
        !/^[a-f0-9-]{36}\.json$/.test(path.slice(this.#directory.length + 1))
      )
        throw new NativeBuildError("native-invalid-journal-path");
      unlock = await lockAttempt(path);
      const journal = await this.#readJournal(path);
      if (journal === undefined) throw new NativeBuildError("native-journal-missing");
      await this.#cleanup(journal, path);
      return { ok: true, value: undefined };
    } catch (error) {
      return { ok: false, error: failure(error, path) };
    } finally {
      await unlock?.();
    }
  }
}
