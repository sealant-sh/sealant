import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  assertImageRequirement,
  DEFAULT_IMAGE_REF,
  docker,
  isImagePresent,
} from "../sealantd/boot.js";
import { SealantRuntime, SealantRuntimeControlLive } from "../sealantd/runtime.js";
import { sealantTargetForDockerContainer } from "../sealantd/target.js";
import {
  DockerRuntimeAdapter,
  parseRuntimeAdapterLaunchInput,
  type RuntimeAdapterLaunchInput,
} from "./index.js";

const IMAGE_REF = process.env["SEALANT_CAPTURE_E2E_IMAGE"] ?? DEFAULT_IMAGE_REF;
const CAPTURE_TOKEN = "capture-harness-home-e2e-token";
const WORKTREE_ID = "capture-harness-home-e2e-worktree";
const HARNESS_HOME = "/workspace/harness-home";
const HARNESS_FILE = `${HARNESS_HOME}/state.json`;
const HARNESS_CONTENT = '{"session":"restored"}\n';

const uploadUrlsRequestSchema = z.strictObject({
  worktree_id: z.string(),
  epoch: z.number().int().nonnegative(),
  keys: z.array(z.string()),
  sizes: z.record(z.string(), z.number().int().nonnegative()).optional(),
});

const registerRequestSchema = z.strictObject({
  worktree_id: z.string(),
  epoch: z.number().int().nonnegative(),
  n: z.number().int().nonnegative(),
  parent: z.string().nullable(),
  capture_id: z.string(),
  manifest_key: z.string(),
  manifest: z.unknown(),
});

interface CaptureHead {
  readonly n: number;
  readonly capture_id: string;
  readonly manifest_key: string;
  readonly manifest: unknown;
}

interface CaptureChannelState {
  readonly objects: Map<string, Buffer>;
  readonly errors: Array<unknown>;
  head: CaptureHead | undefined;
  planRequests: number;
}

interface CaptureChannel {
  readonly endpoint: string;
  readonly state: CaptureChannelState;
  readonly close: () => Promise<void>;
}

const readBody = async (request: IncomingMessage): Promise<Buffer> => {
  const chunks: Array<Uint8Array> = [];
  for await (const chunk of request) {
    if (typeof chunk === "string") {
      chunks.push(Buffer.from(chunk));
    } else if (chunk instanceof Uint8Array) {
      chunks.push(chunk);
    } else {
      throw new Error("Capture channel received a non-byte request body.");
    }
  }
  return Buffer.concat(chunks);
};

const readJsonBody = async (request: IncomingMessage): Promise<unknown> => {
  const body = await readBody(request);
  try {
    const parsed: unknown = JSON.parse(body.toString("utf8"));
    return parsed;
  } catch (cause) {
    throw new Error("Capture channel received invalid JSON.", { cause });
  }
};

const writeJson = (response: ServerResponse, status: number, value: unknown): void => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
};

const startCaptureChannel = async (): Promise<CaptureChannel> => {
  const state: CaptureChannelState = {
    objects: new Map(),
    errors: [],
    head: undefined,
    planRequests: 0,
  };
  let endpoint: string | undefined;

  const objectUrl = (key: string): string => {
    if (endpoint === undefined) {
      throw new Error("Capture channel URL requested before the server started.");
    }
    return `${endpoint}/objects/${Buffer.from(key).toString("base64url")}`;
  };

  const handleRequest = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const url = new URL(request.url ?? "/", "http://capture-channel.invalid");
    const authorization = request.headers.authorization;
    if (authorization !== `Bearer ${CAPTURE_TOKEN}` && !url.pathname.startsWith("/objects/")) {
      writeJson(response, 401, { reason: "unauthorized" });
      return;
    }

    if (url.pathname.startsWith("/objects/")) {
      const encodedKey = url.pathname.slice("/objects/".length);
      const key = Buffer.from(encodedKey, "base64url").toString("utf8");
      if (request.method === "PUT") {
        state.objects.set(key, await readBody(request));
        response.writeHead(200);
        response.end();
        return;
      }
      if (request.method === "GET") {
        const object = state.objects.get(key);
        if (object === undefined) {
          response.writeHead(404);
          response.end();
          return;
        }
        response.writeHead(200, { "content-type": "application/octet-stream" });
        response.end(object);
        return;
      }
      response.writeHead(405);
      response.end();
      return;
    }

    if (request.method !== "POST") {
      response.writeHead(405);
      response.end();
      return;
    }

    switch (url.pathname) {
      case "/plan.get": {
        state.planRequests += 1;
        await readJsonBody(request);
        const getUrls = Object.fromEntries(
          Array.from(state.objects.keys(), (key) => [key, objectUrl(key)] as const),
        );
        writeJson(response, 200, {
          worktree_id: WORKTREE_ID,
          epoch: 1,
          head: state.head ?? null,
          get_urls: getUrls,
        });
        return;
      }
      case "/upload.urls": {
        const parsed = uploadUrlsRequestSchema.parse(await readJsonBody(request));
        writeJson(response, 200, {
          urls: Object.fromEntries(parsed.keys.map((key) => [key, objectUrl(key)])),
          multipart: {},
        });
        return;
      }
      case "/capture.register": {
        const parsed = registerRequestSchema.parse(await readJsonBody(request));
        state.head = {
          n: parsed.n,
          capture_id: parsed.capture_id,
          manifest_key: parsed.manifest_key,
          manifest: parsed.manifest,
        };
        writeJson(response, 200, {
          head_n: parsed.n,
          head_capture_id: parsed.capture_id,
        });
        return;
      }
      case "/lease.heartbeat": {
        await readJsonBody(request);
        writeJson(response, 200, { expires_in_secs: 300 });
        return;
      }
      case "/change.summary": {
        await readJsonBody(request);
        writeJson(response, 200, {});
        return;
      }
      default: {
        response.writeHead(404);
        response.end();
      }
    }
  };

  const server = createServer((request, response) => {
    void handleRequest(request, response).catch((error: unknown) => {
      state.errors.push(error);
      if (!response.headersSent) {
        writeJson(response, 500, { reason: "capture-channel-test-error" });
      } else {
        response.destroy(error instanceof Error ? error : undefined);
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Capture channel did not bind a TCP port.");
  }
  endpoint = `http://127.0.0.1:${address.port}`;

  return {
    endpoint,
    state,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      }),
  };
};

const createCaptureLaunchInput = (input: {
  readonly endpoint: string;
  readonly secretEnvDir: string;
  readonly runId: string;
}): RuntimeAdapterLaunchInput =>
  parseRuntimeAdapterLaunchInput({
    blueprint: {
      version: "1",
      sources: {
        workspace: {
          kind: "capture",
          endpoint: input.endpoint,
          worktreeId: WORKTREE_ID,
          harnessHome: HARNESS_HOME,
        },
        inputs: [],
        mounts: [],
      },
      harness: { id: "opencode" },
      access: { ssh: { enabled: false, listenPort: 2222 } },
      tooling: { packages: [] },
      customization: {
        defaultShell: "bash",
        dotfilesManager: "auto",
        dotfilesTarget: "home",
        applyDotfiles: true,
        dotfilesBootstrap: true,
      },
      lifecycle: {
        setup: [],
        startup: { steps: [], foreground: { kind: "harness" } },
      },
      runtime: {
        env: { SEALANT_FOREGROUND_COMMAND: "sleep infinity" },
        workspaceRoot: "/workspace",
        workingDirectory: "/workspace/repo",
        persistence: "ephemeral",
        ociRuntime: "runc",
        network: { outbound: true },
      },
      target: {
        os: { family: "nix", mode: "prefer" },
        runtime: { family: "docker", mode: "prefer" },
      },
    },
    publishedImage: {
      repository: "sealant-workspace-fedora",
      tag: "latest",
      reference: IMAGE_REF,
      digestReference: IMAGE_REF,
      digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    },
    runId: input.runId,
    secretEnvDir: input.secretEnvDir,
    secretEnv: { SEALANT_CAPTURE_TOKEN: CAPTURE_TOKEN },
  });

const flushCapture = (containerId: string) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* SealantRuntime;
        const session = yield* runtime.connect(sealantTargetForDockerContainer(containerId));
        return yield* session.captureFlush();
      }),
    ).pipe(Effect.provide(SealantRuntimeControlLive)),
  );

const imageAvailable = await isImagePresent(IMAGE_REF);
assertImageRequirement(imageAvailable);

const containers = new Set<string>();
const temporaryDirectories = new Set<string>();
let channel: CaptureChannel | undefined;

afterAll(async () => {
  await Promise.all(
    Array.from(containers, (containerId) =>
      docker(["rm", "-f", containerId]).catch(() => undefined),
    ),
  );
  if (channel !== undefined) await channel.close();
  await Promise.all(
    Array.from(temporaryDirectories, (directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe.skipIf(!imageAvailable)("capture harness home restoration through the real daemon", () => {
  it("captures harness state from one executor and restores it into another", async () => {
    channel = await startCaptureChannel();
    const secretEnvDir = await mkdtemp(join(tmpdir(), "sealant-capture-home-secrets-"));
    temporaryDirectories.add(secretEnvDir);
    await chmod(secretEnvDir, 0o700);
    await writeFile(
      join(secretEnvDir, "env.json"),
      JSON.stringify({ SEALANT_CAPTURE_TOKEN: CAPTURE_TOKEN }),
      { mode: 0o600 },
    );

    const adapter = new DockerRuntimeAdapter({
      autoRemove: false,
      containerNamePrefix: "sealant-capture-home-e2e",
      runtimeCatalogLoader: async () => ({
        defaultRuntime: "runc",
        runtimes: new Set(["runc"]),
      }),
      workspaceNetwork: "host",
    });

    const first = await adapter.launch(
      createCaptureLaunchInput({
        endpoint: channel.endpoint,
        secretEnvDir,
        runId: `capture-home-source-${randomUUID()}`,
      }),
    );
    containers.add(first.resourceId);

    await docker(["exec", first.resourceId, "mkdir", "-p", HARNESS_HOME]);
    await docker([
      "exec",
      first.resourceId,
      "sh",
      "-c",
      `printf '%s' '${HARNESS_CONTENT.trimEnd()}' > '${HARNESS_FILE}'`,
    ]);

    const flush = await flushCapture(first.resourceId);
    expect(flush.fenced).toBe(false);
    expect(flush.pending).toBe(0);
    expect(channel.state.head).toBeDefined();
    expect(channel.state.objects.size).toBeGreaterThan(0);

    await docker(["rm", "-f", first.resourceId]);
    containers.delete(first.resourceId);

    const second = await adapter.launch(
      createCaptureLaunchInput({
        endpoint: channel.endpoint,
        secretEnvDir,
        runId: `capture-home-restore-${randomUUID()}`,
      }),
    );
    containers.add(second.resourceId);

    expect(await docker(["exec", second.resourceId, "cat", HARNESS_FILE])).toBe(
      HARNESS_CONTENT.trimEnd(),
    );
    expect(channel.state.planRequests).toBeGreaterThanOrEqual(2);
    expect(channel.state.errors).toEqual([]);
  }, 180_000);
});
