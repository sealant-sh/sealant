import { createHash, randomUUID } from "node:crypto";

import { WebSocket } from "ws";
import { z } from "zod";

/** Safe phase only: neither endpoint responses nor credentials belong in proof errors. */
export class BoatProofError extends Error {
  readonly _tag = "BoatProofError";
  constructor(readonly phase: string) {
    super(`Boat live proof refused: ${phase}`);
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
  name: z.string().nullable(),
  projectId: id,
  sealantRunId: id.nullable(),
  worktreeId: id.nullable(),
  idleStoppedAt: z.string().nullable(),
});
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
}
/** The checker reads canonical facts; it cannot manufacture a launch, readiness or deletion receipt. */
export interface BoatProofServices {
  readonly runtime: (session: ProofSession) => Promise<ProofRuntime | undefined>;
  readonly inventory: () => Promise<BoatProofInventory>;
  readonly privacy: (publicationId: string) => Promise<unknown>;
  readonly withdraw: (publicationId: string) => Promise<void>;
  readonly record: (event: Readonly<Record<string, unknown>>) => void;
}
const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const empty = (inventory: BoatProofInventory) =>
  inventory.sandboxes.length === 0 && inventory.snapshots.length === 0;
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** Mend issues every token and terminal ticket through its ordinary authenticated API. */
export class MendProofClient {
  constructor(
    private readonly origin: string,
    private readonly token: string,
  ) {}
  async request(method: "GET" | "POST", path: string, body?: unknown) {
    const response = await fetch(`${this.origin.replace(/\/$/, "")}/api${path}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(method === "POST" ? 12 * 60_000 : 15_000),
      redirect: "error",
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new BoatProofError(`mend-http-${response.status}`);
    }
    const text = await response.text();
    return text === "" ? null : JSON.parse(text);
  }
  async session(sessionId: string): Promise<ProofSession> {
    return z
      .object({ session: sessionSchema })
      .parse(await this.request("GET", `/sessions/${sessionId}`)).session;
  }
  async create(projectId: string, name: string): Promise<ProofSession> {
    return sessionSchema.parse(
      await this.request("POST", `/projects/${projectId}/sessions`, {
        harness: "codex",
        label: null,
        name,
        base: null,
      }),
    );
  }
  async find(projectId: string, name: string): Promise<ProofSession | undefined> {
    const sessions = z
      .array(sessionSchema.extend({ name: z.string().nullable() }))
      .parse(await this.request("GET", "/sessions?retained=1"))
      .filter((s) => s.name === name && s.projectId === projectId);
    if (sessions.length > 1) throw new BoatProofError("ambiguous-session");
    return sessions[0];
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
              output = (output + data.toString()).slice(-4096);
              if (output.includes(marker)) proved = true;
            } else {
              let raw: unknown;
              try {
                raw = JSON.parse(data.toString());
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

/** No retries of create/launch/resume; cleanup reuses the original session and durable owners. */
export const runBoatLiveCheck = async (
  config: BoatProofConfig,
  mend: MendProofClient,
  io: BoatProofServices,
) => {
  const name = `boat-proof-${randomUUID()}`;
  let session: ProofSession | undefined;
  const publications = new Set<string>();
  const remember = async (value: ProofSession) => {
    session = value;
    if (value.projectId !== config.projectId || value.name !== name)
      throw new BoatProofError("project-mismatch");
    const runtime = await io.runtime(value);
    if (runtime !== undefined) {
      publications.add(runtime.publicationId);
      io.record({ event: "runtime", ...runtime });
    }
    return runtime;
  };
  const close = async () => {
    if (session === undefined) session = await mend.find(config.projectId, name);
    if (session === undefined) return;
    const currentSession = await mend.session(session.id);
    await remember(currentSession);
    await mend.request("POST", `/sessions/${session.id}/stop`);
    await waitFor("FINAL-cleanup", 5 * 60_000, async () => {
      const runtime = await io.runtime(currentSession);
      return runtime?.closed ? runtime : undefined;
    });
  };
  let failed: unknown;
  try {
    const baseline = await io.inventory();
    io.record({ event: "baseline", ...baseline });
    if (!empty(baseline)) throw new BoatProofError("baseline-not-empty");
    io.record({ event: "create-intent", name, ...config });
    session = await mend.create(config.projectId, name);
    io.record({ event: "session", id: session.id, name });
    const started = Date.now();
    await mend.request("POST", `/sessions/${session.id}/launch`, { mode: "protocol" });
    const first = await waitFor("authenticated-readiness", 12 * 60_000, async () => {
      if (session === undefined) throw new BoatProofError("missing-session");
      const runtime = await remember(await mend.session(session.id));
      return runtime?.ready ? runtime : undefined;
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
      if (session === undefined) throw new BoatProofError("missing-session");
      const observed = await mend.session(session.id);
      return observed.idleStoppedAt !== null && (await io.runtime(observed))?.closed === true
        ? observed
        : undefined;
    });
    io.record({ event: "idle-stopped", runId: first.runId, sandboxId: first.sandboxId });
    if (stopped.worktreeId === null) throw new BoatProofError("missing-worktree");
    await mend.captured(stopped.worktreeId, file, bytes);
    await mend.request("POST", `/sessions/${session.id}/resume`, { harness: null });
    const resumed = await waitFor("fresh-resume", 12 * 60_000, async () => {
      if (session === undefined) throw new BoatProofError("missing-session");
      const runtime = await remember(await mend.session(session.id));
      return runtime?.ready && runtime.runId !== first.runId ? runtime : undefined;
    });
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
    failed = error;
  }
  {
    let cleanupHeld = false;
    try {
      await close();
    } catch {
      cleanupHeld = true;
      io.record({ event: "cleanup-held", operation: "FINAL" });
    }
    for (const publication of publications) {
      try {
        await io.withdraw(publication);
        io.record({ event: "publication-withdrawn", publication });
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
    if (cleanupHeld) throw new BoatProofError("cleanup-held; use cleanup with this ledger");
  }
  if (failed !== undefined) throw failed;
};
