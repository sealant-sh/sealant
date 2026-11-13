import { createHash, randomUUID } from "node:crypto";

import { WebSocket, type RawData } from "ws";
import { z } from "zod";

/** A WebSocket message's bytes as text. A default (nodebuffer) socket delivers one Buffer. */
const messageText = (data: RawData): string =>
  Buffer.isBuffer(data)
    ? data.toString()
    : Array.isArray(data)
      ? Buffer.concat(data).toString()
      : Buffer.from(data).toString();

/** Safe phase only: neither endpoint responses nor credentials belong in proof errors. */
export class BoatProofError extends Error {
  readonly _tag = "BoatProofError";
  constructor(
    readonly phase: string,
    readonly cleanupHeld = false,
  ) {
    super(
      `Boat live proof refused: ${phase}${cleanupHeld ? "; cleanup-held; use cleanup with this ledger" : ""}`,
    );
  }
}
const id = z
  .string()
  .regex(/^[A-Za-z0-9_:-]+$/)
  .max(256);
export const boatProofConfigSchema = z.strictObject({
  origin: z.url().refine((value) => {
    const u = new URL(value);
    return (
      (u.protocol === "https:" || (u.protocol === "http:" && u.hostname === "127.0.0.1")) &&
      u.pathname === "/" &&
      !u.search &&
      !u.hash &&
      !u.username &&
      !u.password
    );
  }),
  projectId: id,
  ownerId: id,
  deploymentId: id,
  resourceHost: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
  resourcePort: z.number().int().min(1).max(65535),
  buildBudgetMs: z
    .number()
    .int()
    .min(60_000)
    .max(60 * 60_000)
    .default(30 * 60_000),
  idleBudgetMs: z
    .number()
    .int()
    .min(60_000)
    .max(30 * 60_000)
    .default(20 * 60_000),
});
export type BoatProofConfig = z.infer<typeof boatProofConfigSchema>;
const sessionSchema = z.object({
  id,
  worktree: z.string(),
  projectId: id,
  sealantRunId: id.nullable(),
  sealantWorkspaceId: id.nullable(),
  worktreeId: id,
  idleStoppedAt: z.string().nullable(),
  status: z.enum([
    "starting",
    "running",
    "waiting",
    "idle",
    "stopping",
    "completed",
    "failed",
    "stopped",
  ]),
});
/** The Mend Session fields used by the proof, parsed from create, detail and list responses. */
export type ProofSession = z.infer<typeof sessionSchema>;
export interface ProofRuntime {
  readonly runId: string;
  readonly sandboxId: string;
  readonly publicationId: string;
  readonly resourceSubnet: string | null;
  readonly ready: boolean;
  readonly closed: boolean;
}
export interface BoatProofInventory {
  readonly sandboxes: readonly string[];
  readonly snapshots: readonly string[];
  readonly pages: number;
  /** Exact ready catalog artifacts, independently matched to the provider. Never VM allocations. */
  readonly retainedSnapshots?: readonly { readonly publicationId: string; readonly name: string }[];
}
/** sealant has already given up on this attempt. Its cause is the runtime row's recorded error. */
export interface ProofFailure {
  readonly runId: string;
  readonly attemptStatus: string;
  readonly runtimeStatus: string | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
}
/** The rows the failure lookup reads. The proof core passes sealant's repositories. */
export interface ProofFailureReads {
  readonly workspace: (
    id: string,
  ) => Promise<{ readonly ownerUserId: string; readonly latestRunId: string | null } | undefined>;
  readonly attempt: (
    id: string,
  ) => Promise<{ readonly ownerUserId: string; readonly status: string } | undefined>;
  readonly runtime: (runId: string) => Promise<
    | {
        readonly status: string;
        readonly errorCode: string | null;
        readonly errorMessage: string | null;
      }
    | undefined
  >;
}
/**
 * sealant's verdict on the workspace's current attempt. Mend sets sealantRunId only once the agent
 * starts, so a launch that fails earlier is found through the workspace, as publication() does.
 */
export const findProofFailure = async (
  session: ProofSession,
  ownerId: string,
  reads: ProofFailureReads,
): Promise<ProofFailure | undefined> => {
  if (session.sealantWorkspaceId === null) return undefined;
  const workspace = await reads.workspace(session.sealantWorkspaceId);
  if (workspace === undefined) return undefined;
  if (workspace.ownerUserId !== ownerId) throw new BoatProofError("owner-mismatch");
  if (workspace.latestRunId === null) return undefined;
  const attempt = await reads.attempt(workspace.latestRunId);
  if (attempt === undefined) return undefined;
  if (attempt.ownerUserId !== ownerId) throw new BoatProofError("owner-mismatch");
  const instance = await reads.runtime(workspace.latestRunId);
  if (!["failed", "cancelled"].includes(attempt.status) && instance?.status !== "failed")
    return undefined;
  return {
    runId: workspace.latestRunId,
    attemptStatus: attempt.status,
    runtimeStatus: instance?.status ?? null,
    errorCode: instance?.errorCode ?? null,
    errorMessage: instance?.errorMessage ?? null,
  };
};
/** The checker reads canonical facts; it cannot manufacture a launch, readiness or deletion receipt. */
export interface BoatProofServices {
  readonly runtime: (session: ProofSession) => Promise<ProofRuntime | undefined>;
  /** Terminal launch failure for the session's current attempt, before or after allocation. */
  readonly failure: (session: ProofSession) => Promise<ProofFailure | undefined>;
  /** The current workspace attempt's catalog state, available before allocation or harness launch. */
  readonly publication: (
    session: ProofSession,
  ) => Promise<
    { readonly publicationId: string; readonly runId: string; readonly ready: boolean } | undefined
  >;
  readonly inventory: () => Promise<BoatProofInventory>;
  readonly privacy: (publicationId: string) => Promise<unknown>;
  readonly withdraw: (publicationId: string) => Promise<void>;
  readonly record: (event: Readonly<Record<string, unknown>>) => void;
}
const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const empty = (inventory: BoatProofInventory) =>
  inventory.sandboxes.length === 0 &&
  inventory.snapshots.every(
    (name) => inventory.retainedSnapshots?.some((saved) => saved.name === name) === true,
  );
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** Mend issues every token and terminal ticket through its ordinary authenticated API. */
export class MendProofClient {
  constructor(
    private readonly origin: string,
    private readonly token: string,
  ) {}
  async request(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    options?: { readonly signal: AbortSignal; readonly timeoutMs: number },
  ) {
    const response = await fetch(`${this.origin.replace(/\/$/, "")}/api${path}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal:
        options === undefined
          ? AbortSignal.timeout(method === "POST" ? 12 * 60_000 : 15_000)
          : AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)]),
      redirect: "error",
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new BoatProofError(`mend-http-${response.status}`);
    }
    const text = await response.text();
    return text === "" ? null : JSON.parse(text);
  }
  /** Read one Session without accepting a response for another ID. */
  async session(sessionId: string): Promise<ProofSession> {
    const result = z
      .object({ session: sessionSchema })
      .safeParse(await this.request("GET", `/sessions/${sessionId}`));
    if (!result.success) throw new BoatProofError("mend-session-response");
    if (result.data.session.id !== sessionId) throw new BoatProofError("session-identity");
    return result.data.session;
  }
  /** Persist the returned ID before parsing fields that could prevent recovery. */
  async create(
    projectId: string,
    name: string,
    recordCreated: (sessionId: string) => void,
  ): Promise<ProofSession> {
    const response = await this.request("POST", `/projects/${projectId}/sessions`, {
      harness: "codex",
      label: null,
      name,
      base: null,
    });
    const identity = z.object({ id }).safeParse(response);
    if (!identity.success) throw new BoatProofError("mend-create-identity");
    recordCreated(identity.data.id);
    const session = sessionSchema.safeParse(response);
    if (!session.success) throw new BoatProofError("mend-session-response");
    if (session.data.projectId !== projectId || session.data.worktree !== name)
      throw new BoatProofError("session-ownership");
    return session.data;
  }
  /** Resolve the same exact project/worktree for observation and interrupted cleanup. */
  async find(
    projectId: string,
    worktree: string,
    sessionId?: string,
  ): Promise<ProofSession | undefined> {
    if (sessionId === undefined) {
      const listed = z
        .array(z.object({ id, projectId: id, worktree: z.string() }))
        .safeParse(await this.request("GET", "/sessions?retained=1"));
      if (!listed.success) throw new BoatProofError("mend-session-list-response");
      const sessions = listed.data.filter(
        (s) => s.worktree === worktree && s.projectId === projectId,
      );
      if (sessions.length > 1) throw new BoatProofError("ambiguous-session");
      sessionId = sessions[0]?.id;
      if (sessionId === undefined) return undefined;
    }
    const session = await this.session(sessionId);
    if (session.projectId !== projectId || session.worktree !== worktree)
      throw new BoatProofError("session-ownership");
    return session;
  }
  async captured(worktreeId: string, path: string, expected: string) {
    const response = await fetch(
      `${this.origin.replace(/\/$/, "")}/api/worktrees/${worktreeId}/raw?${new URLSearchParams({ path })}`,
      {
        headers: { authorization: `Bearer ${this.token}` },
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok || (await response.text()) !== expected)
      throw new BoatProofError("captured-edit-mismatch");
  }
  async shell(sessionId: string, program: string, marker: string) {
    const process = z
      .object({ id })
      .parse(await this.request("POST", `/sessions/${sessionId}/shell`));
    try {
      const { ticket } = z
        .object({ ticket: z.string().min(1) })
        .parse(
          await this.request("POST", "/upgrade-tickets", { target: "tty", process: process.id }),
        );
      const url = new URL("/api/tty", this.origin);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.search = new URLSearchParams({ process: process.id, ticket, from: "0" }).toString();
      const socket = new WebSocket(url, { handshakeTimeout: 15_000, maxPayload: 1024 * 1024 });
      try {
        const completion = Promise.withResolvers<BoatProofError | undefined>();
        {
          let output = "";
          let proved = false;
          let finished = false;
          const finish = (error?: BoatProofError) => {
            if (finished) return;
            finished = true;
            clearTimeout(deadline);
            completion.resolve(error);
          };
          const deadline = setTimeout(() => {
            finish(new BoatProofError("shell-deadline"));
            socket.terminate();
          }, 60_000);
          socket.once("error", () => finish(new BoatProofError("shell-transport")));
          socket.once("close", () =>
            finish(proved ? undefined : new BoatProofError("shell-proof-missing")),
          );
          socket.on("message", (data, binary) => {
            if (binary) {
              output = (output + messageText(data)).slice(-4096);
              if (output.includes(marker)) proved = true;
            } else {
              let raw: unknown;
              try {
                raw = JSON.parse(messageText(data));
              } catch {
                finish(new BoatProofError("shell-control"));
                socket.terminate();
                return;
              }
              const frame = z.object({ t: z.string() }).safeParse(raw);
              if (frame.success && frame.data.t === "end") {
                finish(proved ? undefined : new BoatProofError("shell-proof-missing"));
                socket.close();
              }
            }
          });
          socket.once("open", () => {
            socket.send(JSON.stringify({ t: "resize", cols: 120, rows: 30 }));
            // The marker is base64 inside the input, so terminal echo cannot satisfy the proof.
            socket.send(Buffer.from(`python3 -c ${shellQuote(program)}; exit\n`), { binary: true });
          });
        }
        const outcome = await completion.promise;
        if (outcome !== undefined) throw outcome;
      } finally {
        socket.terminate();
      }
    } finally {
      // A live shell holds idle stop. Stop only the shell this call created, including on failure.
      await this.request("POST", `/processes/${process.id}/stop`);
    }
  }
}

const fixtureProgram = (input: {
  file: string;
  bytes: string;
  marker: string;
  config: BoatProofConfig;
  write: boolean;
  subnet: string;
}) => {
  const encoded = Buffer.from(JSON.stringify(input)).toString("base64");
  return (
    `import base64,json,pathlib,socket,ipaddress\nx=json.loads(base64.b64decode('${encoded}'))\np=pathlib.Path(x['file'])\n` +
    (input.write
      ? `p.write_text(x['bytes'])\nh=x['config']['resourceHost']; port=x['config']['resourcePort']\na=socket.getaddrinfo(h,port,family=socket.AF_INET,type=socket.SOCK_STREAM)\nassert a and all(ipaddress.ip_address(v[4][0]) in ipaddress.ip_network(x['subnet']) for v in a)\ns=socket.create_connection((h,port),10);s.close()\n`
      : "") +
    `assert p.read_text()==x['bytes']\nprint(x['marker'],flush=True)\n`
  );
};
const waitFor = async <A>(
  phase: string,
  budget: number,
  observe: () => Promise<A | undefined>,
): Promise<A> => {
  const deadline = Date.now() + budget;
  do {
    const value = await observe();
    if (value !== undefined) return value;
    await pause(2000);
  } while (Date.now() < deadline);
  throw new BoatProofError(phase);
};

const trackProofSession = (input: {
  config: BoatProofConfig;
  mend: MendProofClient;
  io: BoatProofServices;
  worktree: string;
  publications: Set<string>;
  sessionId?: string;
}) => {
  let sessionId = input.sessionId;
  const created = (createdId: string) => {
    sessionId = createdId;
    input.io.record({ event: "session", id: createdId, name: input.worktree });
  };
  const remember = async () => {
    const session = await input.mend.find(input.config.projectId, input.worktree, sessionId);
    if (session === undefined) return undefined;
    if (sessionId === undefined) created(session.id);
    const runtime = await input.io.runtime(session);
    if (runtime !== undefined) {
      input.publications.add(runtime.publicationId);
      input.io.record({ event: "runtime", ...runtime });
    }
    return { session, runtime, failure: await input.io.failure(session) };
  };
  const close = async () => {
    const current = await remember();
    if (current === undefined) return;
    await input.mend.request("POST", `/sessions/${current.session.id}/stop`);
    await waitFor("FINAL-cleanup", 5 * 60_000, async () => {
      const observed = await remember();
      if (observed === undefined) return undefined;
      if (observed.runtime?.closed) return true;
      // A create that never launched has no sealant runtime or provider deletion to await.
      return observed.runtime === undefined &&
        observed.session.sealantRunId === null &&
        ["stopped", "completed", "failed"].includes(observed.session.status)
        ? true
        : undefined;
    });
  };
  return { created, remember, close };
};

// A ready publication is a reusable catalog artifact, including one retained by another consumer.
// Only unexplained snapshots fail the census; the checker never deletes a retained publication.
const withdrawProofPublication = async (io: BoatProofServices, publication: string) => {
  const inventory = await io.inventory();
  if (inventory.retainedSnapshots?.some((saved) => saved.publicationId === publication)) {
    io.record({ event: "publication-retained", publication });
    return;
  }
  await io.withdraw(publication);
  io.record({ event: "publication-withdrawn", publication });
};

/** Recover a prior create using its journaled ID, or its exact project/worktree if no ID was saved. */
export const cleanupBoatLiveCheck = async (
  config: BoatProofConfig,
  mend: MendProofClient,
  io: BoatProofServices,
  previous: readonly Readonly<Record<string, unknown>>[],
): Promise<void> => {
  const intent = z
    .object({
      event: z.literal("create-intent"),
      // Keep the historical ledger key: Mend's create input names the worktree.
      name: z.string(),
      ...boatProofConfigSchema.shape,
    })
    .parse(previous.find((e) => e.event === "create-intent"));
  if (JSON.stringify(boatProofConfigSchema.strip().parse(intent)) !== JSON.stringify(config))
    throw new BoatProofError("ledger-context-mismatch");
  const saved = previous.find((e) => e.event === "session");
  const publications = new Set(
    previous.filter((e) => e.event === "runtime").map((e) => z.uuid().parse(e.publicationId)),
  );
  const owned = trackProofSession({
    config,
    mend,
    io,
    worktree: intent.name,
    publications,
    ...(saved === undefined ? {} : { sessionId: id.parse(saved.id) }),
  });
  await owned.close();
  for (const publication of publications) await withdrawProofPublication(io, publication);
  const inventory = await io.inventory();
  io.record({ event: "cleanup-inventory", ...inventory });
  if (!empty(inventory)) throw new BoatProofError("cleanup-inventory-not-empty");
};

/** No retries of create/launch/resume; cleanup reuses the original session and durable owners. */
export const runBoatLiveCheck = async (
  config: BoatProofConfig,
  mend: MendProofClient,
  io: BoatProofServices,
): Promise<void> => {
  const name = `boat-proof-${randomUUID()}`;
  const publications = new Set<string>();
  const owned = trackProofSession({ config, mend, io, worktree: name, publications });
  const launchReady = async (
    phase: string,
    path: string,
    body: unknown,
    previousRunId?: string,
  ) => {
    const controller = new AbortController();
    let answer: { readonly ok: true } | { readonly ok: false; readonly error: unknown } | undefined;
    const launching = mend
      .request("POST", path, body, {
        signal: controller.signal,
        timeoutMs: config.buildBudgetMs + 12 * 60_000,
      })
      .then(
        () => {
          answer = { ok: true };
          return;
        },
        (error: unknown) => {
          answer = { ok: false, error };
          return;
        },
      );
    const checkAnswer = () => {
      if (answer?.ok === false) throw answer.error;
    };
    // sealant's verdict is final. Waiting out the budget after it only delays cleanup by minutes.
    const checkCore = (failure: ProofFailure | undefined) => {
      if (failure === undefined || failure.runId === previousRunId) return;
      io.record({ event: "core-launch-failed", phase, ...failure });
      process.stderr.write(
        `Boat proof ${phase}: sealant failed the launch (${failure.errorCode ?? failure.attemptStatus}): ${failure.errorMessage ?? "no recorded cause"}\n`,
      );
      throw new BoatProofError(`${phase}-core-failed`);
    };
    try {
      const built = await waitFor("native-build", config.buildBudgetMs, async () => {
        checkAnswer();
        const observed = await owned.remember();
        if (observed === undefined) return undefined;
        checkCore(observed.failure);
        const publication = await io.publication(observed.session);
        return publication?.ready && publication.runId !== previousRunId ? publication : undefined;
      });
      // This clock starts on a fresh observation of catalog readiness, even for a reused image.
      io.record({ event: "publication-ready", phase, publicationId: built.publicationId });
      const readyAt = Date.now();
      return await waitFor(phase, 12 * 60_000, async () => {
        checkAnswer();
        const observed = await owned.remember();
        checkCore(observed?.failure);
        const runtime = observed?.runtime;
        if (!answer?.ok || !runtime?.ready || runtime.runId === previousRunId) return undefined;
        io.record({ event: "readiness-budget", phase, elapsedMs: Date.now() - readyAt });
        return runtime;
      });
    } finally {
      controller.abort();
      await launching;
    }
  };
  let failed: BoatProofError | undefined;
  try {
    const baseline = await io.inventory();
    io.record({ event: "baseline", ...baseline });
    if (!empty(baseline)) throw new BoatProofError("baseline-not-empty");
    io.record({ event: "create-intent", name, ...config });
    const session = await mend.create(config.projectId, name, owned.created);
    const started = Date.now();
    const first = await launchReady("authenticated-readiness", `/sessions/${session.id}/launch`, {
      mode: "protocol",
    });
    io.record({ event: "ready", elapsedMs: Date.now() - started, ...first });
    io.record({ event: "privacy", result: await io.privacy(first.publicationId) });
    const file = `.boat-proof-${randomUUID()}.txt`;
    const bytes = `Boat proof ${randomUUID()}\n`;
    const marker = `BOAT_PROOF_${randomUUID()}`;
    await mend.shell(
      session.id,
      fixtureProgram({
        file,
        bytes,
        marker,
        config,
        write: true,
        subnet: first.resourceSubnet ?? "invalid",
      }),
      marker,
    );
    io.record({
      event: "edit-and-resource-reach",
      file,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    const stopped = await waitFor("actual-Mend-idle-stop", config.idleBudgetMs, async () => {
      const observed = await owned.remember();
      return observed !== undefined &&
        observed.session.idleStoppedAt !== null &&
        observed.runtime?.closed === true
        ? observed.session
        : undefined;
    });
    io.record({ event: "idle-stopped", runId: first.runId, sandboxId: first.sandboxId });
    await mend.captured(stopped.worktreeId, file, bytes);
    const resumed = await launchReady(
      "fresh-resume",
      `/sessions/${session.id}/resume`,
      { harness: null },
      first.runId,
    );
    if (resumed.sandboxId === first.sandboxId) throw new BoatProofError("resume-reused-vm");
    await mend.shell(
      session.id,
      fixtureProgram({
        file,
        bytes,
        marker,
        config,
        write: false,
        subnet: resumed.resourceSubnet ?? "invalid",
      }),
      marker,
    );
    io.record({ event: "resumed-edits-intact", ...resumed });
    io.record({ event: "flow-passed" });
  } catch (error) {
    failed = error instanceof BoatProofError ? error : new BoatProofError("unexpected-error");
    io.record({ event: "failed", phase: failed.phase });
  }
  {
    let cleanupHeld = false;
    try {
      await owned.close();
    } catch {
      cleanupHeld = true;
      io.record({ event: "cleanup-held", operation: "FINAL" });
    }
    for (const publication of publications) {
      try {
        await withdrawProofPublication(io, publication);
      } catch {
        cleanupHeld = true;
        io.record({ event: "cleanup-held", operation: "publication", publication });
      }
    }
    try {
      const inventory = await io.inventory();
      io.record({ event: "final-inventory", ...inventory });
      if (!empty(inventory)) cleanupHeld = true;
    } catch {
      cleanupHeld = true;
      io.record({ event: "inventory-unavailable" });
    }
    if (cleanupHeld) throw new BoatProofError(failed?.phase ?? "cleanup", true);
  }
  if (failed !== undefined) throw failed;
};
