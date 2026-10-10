/**
 * The gateway before and after login, against a stand-in API (no daemon): what an outsider can
 * cost before logging in, and what a connection can still open once its key is removed.
 *
 * Every connection here comes from a loopback address of its own (127.0.0.x), so the per-source
 * limits of one test never touch another's.
 */
import { createServer, type Server } from "node:http";
import { connect, createServer as createNetServer, type Socket } from "node:net";

import { computeSshPublicKeyFingerprint } from "@sealant/validators/ssh-public-key";
import ssh2 from "ssh2";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startSshGatewayServer } from "./gateway-server.js";
import { createPrincipalResolver } from "./principal-resolver.js";

const { Client, utils } = ssh2;

const OWNER = "usr_alice";
const WORKSPACE_ID = "wks_limits";
const LOOKUPS_PER_MINUTE = 10;
const MAX_AUTH_TRIES = 6;
const PER_SOURCE_STARTUPS = 3;
const GRACE_MS = 600;
const RECHECK_MS = 300;

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => {
        if (address === null || typeof address === "string") {
          reject(new Error("no port"));
          return;
        }
        resolve(address.port);
      });
    });
  });

const publicBlob = (publicKey: string): Buffer => {
  const parsed = utils.parseKey(publicKey);
  const key = Array.isArray(parsed) ? parsed[0] : parsed;
  if (key === undefined || key instanceof Error) throw new Error("bad key");
  return key.getPublicSSH();
};

const alice = utils.generateKeyPairSync("ed25519");
const aliceBlob = publicBlob(alice.public);
const aliceFingerprint = computeSshPublicKeyFingerprint(aliceBlob);

/** Whether Alice's key is registered; a test removes it. */
let aliceRegistered = true;
let keyLookups = 0;
/** The key fingerprint each `ssh-target` request named. */
const targetKeys: Array<string | undefined> = [];

let api: Server | undefined;
let gateway: { stop: () => Promise<void> } | undefined;
let gatewayPort = 0;

beforeAll(async () => {
  // The stand-in API, answering as the real one does: a key resolves to its owner while
  // registered; the target goes to the owner only while the named key is still theirs.
  api = createServer((request, response) => {
    const reply = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    request.on("end", () => {
      if (request.method === "POST" && request.url === "/v1/ssh-keys/resolve-principal") {
        keyLookups += 1;
        const parsed: unknown = JSON.parse(body);
        const offered =
          typeof parsed === "object" && parsed !== null && "publicKeyBase64" in parsed
            ? parsed.publicKeyBase64
            : undefined;
        if (aliceRegistered && offered === aliceBlob.toString("base64")) {
          reply(200, { principalId: OWNER, sshKeyId: "key_alice", fingerprint: aliceFingerprint });
          return;
        }
        reply(404, { message: "No SSH key matches the offered public key." });
        return;
      }
      if (request.url === `/v1/workspaces/${WORKSPACE_ID}/ssh-target`) {
        const named = request.headers["x-sealant-ssh-key-fingerprint"];
        const fingerprint = typeof named === "string" ? named : undefined;
        targetKeys.push(fingerprint);
        if (request.headers["x-sealant-principal-id"] !== OWNER) {
          reply(401, { message: "Principal is not authorized for this workspace." });
          return;
        }
        if (fingerprint !== undefined && !(aliceRegistered && fingerprint === aliceFingerprint)) {
          reply(401, {
            message: "The SSH key this connection logged in with is no longer registered.",
          });
          return;
        }
        reply(200, {
          workspaceId: WORKSPACE_ID,
          attemptId: "run_1",
          runtime: {
            adapter: "docker",
            resourceId: "container-1",
            reference: "container-1",
            status: "ready",
            // No daemon answers here: a channel's command fails, and the connection stays.
            endpoint: "unix:///nonexistent/sealant-limits-test.sock",
          },
          sessionUser: null,
          ...(fingerprint === undefined ? {} : { sshKeyFingerprint: fingerprint }),
        });
        return;
      }
      reply(404, { message: "not here" });
    });
  });
  const apiPort = await freePort();
  await new Promise<void>((resolve) => api?.listen(apiPort, "127.0.0.1", resolve));
  const apiBaseUrl = `http://127.0.0.1:${String(apiPort)}`;

  gatewayPort = await freePort();
  gateway = await startSshGatewayServer({
    host: "127.0.0.1",
    port: gatewayPort,
    hostKey: utils.generateKeyPairSync("ed25519").private,
    allowedClientKeys: [],
    workspaceUsernamePrefix: "ws",
    coreApiBaseUrl: apiBaseUrl,
    gatewayToken: "gateway-test-token",
    lookupPrincipal: createPrincipalResolver({ apiBaseUrl, gatewayToken: "gateway-test-token" }),
    limits: {
      loginGraceMs: GRACE_MS,
      maxAuthTries: MAX_AUTH_TRIES,
      maxStartups: 100,
      perSourceMaxStartups: PER_SOURCE_STARTUPS,
      perSourceKeyLookupsPerMinute: LOOKUPS_PER_MINUTE,
    },
    keyRecheckIntervalMs: RECHECK_MS,
  });
});

afterAll(async () => {
  await gateway?.stop().catch(() => undefined);
  await new Promise<void>((resolve) =>
    api === undefined ? resolve() : api.close(() => resolve()),
  );
});

/** A TCP connection to the gateway from `source`, once connected. */
const tcpFrom = (source: string) =>
  new Promise<Socket>((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port: gatewayPort, localAddress: source });
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });

/** A promise and a resolver that only the first call settles. */
const once = <A>() => {
  const { promise, resolve } = Promise.withResolvers<A>();
  let settled = false;
  const settle = (value: A) => {
    if (settled) return;
    settled = true;
    resolve(value);
  };
  return { promise, settle };
};

/** Whether the gateway closes `socket` within `ms`, and whether it said anything first. */
const closedWithin = (socket: Socket, ms: number) => {
  const outcome = once<{ readonly closed: boolean; readonly spoke: boolean }>();
  let spoke = false;
  socket.on("data", () => {
    spoke = true;
  });
  socket.on("error", () => undefined);
  const timer = setTimeout(() => outcome.settle({ closed: false, spoke }), ms);
  socket.once("close", () => {
    clearTimeout(timer);
    outcome.settle({ closed: true, spoke });
  });
  return outcome.promise;
};

type SshClient = InstanceType<typeof Client>;

type LoginOutcome =
  | { readonly kind: "in"; readonly client: SshClient }
  | { readonly kind: "out"; readonly offered: number };

/** Logs in from `source` with `keys` offered in order; resolves the client, or that it failed. */
const login = async (source: string, keys: ReadonlyArray<string>): Promise<LoginOutcome> => {
  const sock = await tcpFrom(source).catch(() => undefined);
  if (sock === undefined) return { kind: "out", offered: 0 };
  const outcome = once<LoginOutcome>();
  const client = new Client();
  let offered = 0;
  client.on("ready", () => outcome.settle({ kind: "in", client }));
  client.on("error", () => outcome.settle({ kind: "out", offered }));
  client.on("close", () => outcome.settle({ kind: "out", offered }));
  client.connect({
    sock,
    username: `ws-${WORKSPACE_ID}`,
    readyTimeout: 10_000,
    authHandler: (_methodsLeft, _partial, offer) => {
      const key = keys[offered];
      if (key === undefined) {
        client.end();
        return;
      }
      offered += 1;
      offer({ type: "publickey", username: `ws-${WORKSPACE_ID}`, key });
    },
  });
  return outcome.promise;
};

const unknownKeys = (count: number) =>
  Array.from({ length: count }, () => utils.generateKeyPairSync("ed25519").private);

/** Runs `command`; resolves its exit code, or `"closed"` when the connection ended instead. */
const exec = (client: SshClient, command: string) => {
  const outcome = once<number | "closed">();
  client.once("close", () => outcome.settle("closed"));
  client.exec(command, (error, channel) => {
    if (error !== undefined) {
      outcome.settle("closed");
      return;
    }
    channel.on("data", () => undefined);
    channel.stderr.on("data", () => undefined);
    channel.on("exit", (code: number | null) => outcome.settle(code ?? -1));
    channel.on("close", () => outcome.settle(-1));
  });
  return outcome.promise;
};

/** Whether the connection ends within `ms`. */
const ended = (client: SshClient, ms: number) => {
  const outcome = once<boolean>();
  const timer = setTimeout(() => outcome.settle(false), ms);
  client.once("close", () => {
    clearTimeout(timer);
    outcome.settle(true);
  });
  return outcome.promise;
};

describe("before login", () => {
  it("drops a connection that has not logged in within the grace time", async () => {
    const socket = await tcpFrom("127.0.0.11");
    const outcome = await closedWithin(socket, GRACE_MS * 4);
    expect(outcome.closed).toBe(true);
  });

  it("drops one more connection from a source already holding its share, and no other source's", async () => {
    const held = await Promise.all(
      Array.from({ length: PER_SOURCE_STARTUPS }, () => tcpFrom("127.0.0.12")),
    );
    const extra = await closedWithin(await tcpFrom("127.0.0.12"), 300);
    // Dropped as it arrived, before the gateway said a word of SSH.
    expect(extra).toEqual({ closed: true, spoke: false });

    const other = await tcpFrom("127.0.0.13");
    const spoke = once<boolean>();
    other.once("data", (chunk: Buffer) =>
      spoke.settle(chunk.toString("utf8").startsWith("SSH-2.0")),
    );
    other.once("close", () => spoke.settle(false));
    const otherSpoke = await spoke.promise;
    expect(otherSpoke).toBe(true);
    for (const socket of [...held, other]) socket.destroy();
  });

  it("ends a connection at its last refused attempt", async () => {
    const before = keyLookups;
    const outcome = await login("127.0.0.14", unknownKeys(20));
    expect(outcome.kind).toBe("out");
    // Whatever the client had already sent is not looked up either.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(keyLookups - before).toBeLessThanOrEqual(MAX_AUTH_TRIES);
  });

  it("lets an outsider spend only its own key lookups: a person elsewhere still logs in", async () => {
    const before = keyLookups;
    // The outsider keeps connecting and offering keys nobody registered.
    const rounds = Array.from({ length: 6 }, () => unknownKeys(4));
    for (const keys of rounds) {
      await login("127.0.0.15", keys);
    }
    expect(keyLookups - before).toBe(LOOKUPS_PER_MINUTE);
    // Spent: its next connection is dropped before any lookup.
    const refused = await closedWithin(await tcpFrom("127.0.0.15"), 300);
    expect(refused).toEqual({ closed: true, spoke: false });

    const person = await login("127.0.0.16", [alice.private]);
    expect(person.kind).toBe("in");
    if (person.kind === "in") person.client.end();
  });
});

describe("after a key is removed", () => {
  it("refuses a new channel on a connection opened with it, and ends the connection", async () => {
    aliceRegistered = true;
    const outcome = await login("127.0.0.21", [alice.private]);
    if (outcome.kind !== "in") throw new Error("Alice did not log in");
    const { client } = outcome;

    // While registered, a channel is authorized against the key itself (no daemon here, so the
    // command fails, and the connection stays).
    targetKeys.length = 0;
    expect(await exec(client, "true")).toBe(1);
    expect(targetKeys).toContain(aliceFingerprint);

    aliceRegistered = false;
    try {
      expect(await exec(client, "true")).toBe("closed");
    } finally {
      aliceRegistered = true;
    }
  });

  it("refuses a port forward on a connection opened with it", async () => {
    aliceRegistered = true;
    const outcome = await login("127.0.0.22", [alice.private]);
    if (outcome.kind !== "in") throw new Error("Alice did not log in");
    const { client } = outcome;

    aliceRegistered = false;
    try {
      const closing = ended(client, 2_000);
      const forwarded = await new Promise<"opened" | "refused">((resolve) => {
        client.forwardOut("127.0.0.1", 0, "127.0.0.1", 8080, (error) => {
          resolve(error === undefined ? "opened" : "refused");
        });
      });
      expect(forwarded).toBe("refused");
      expect(await closing).toBe(true);
    } finally {
      aliceRegistered = true;
    }
  });

  it("ends a connection that opens nothing new, at its next check", async () => {
    aliceRegistered = true;
    const outcome = await login("127.0.0.23", [alice.private]);
    if (outcome.kind !== "in") throw new Error("Alice did not log in");
    const { client } = outcome;

    // Logged in, the grace time no longer applies.
    expect(await ended(client, GRACE_MS * 2)).toBe(false);

    aliceRegistered = false;
    try {
      expect(await ended(client, RECHECK_MS * 5)).toBe(true);
    } finally {
      aliceRegistered = true;
    }
  });

  it("refuses the key itself on a new connection", async () => {
    aliceRegistered = false;
    try {
      const outcome = await login("127.0.0.24", [alice.private]);
      expect(outcome.kind).toBe("out");
    } finally {
      aliceRegistered = true;
    }
  });
});
