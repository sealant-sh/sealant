/**
 * The Cloudflare bridge Worker: the deploy-side half of the `cloudflare` runtime adapter
 * (`@sealant/workspaces`, runtime/cloudflare). Sandboxes can only be driven from inside a Worker,
 * so this Worker owns them and exposes exactly three things to the outside:
 *
 *   POST   /v1/workspaces                — launch (adopt on redelivery); auth: BRIDGE_TOKEN
 *   DELETE /v1/workspaces/:id            — destroy, idempotent;          auth: BRIDGE_TOKEN
 *   GET    /v1/workspaces/:id/control    — WebSocket carrying the sealantd control byte stream;
 *                                          auth: CONTROL_TOKEN (the deployment's
 *                                          SEALANT_CONTROL_BEARER_TOKEN)
 *
 * Inside the sandbox the same sealantd binary every runtime family boots binds its unix control
 * socket; a socat relay bridges it to a loopback TCP port and `wsConnect` proxies that port over
 * the authenticated WebSocket. The daemon wire protocol is untouched end to end.
 */
import { getSandbox, Sandbox } from "@cloudflare/sandbox";
import {
  bridgeErrorResponseSchema,
  bridgeLaunchRequestSchema,
  type BridgeLaunchRequest,
  type BridgeLaunchResponse,
  type BridgeStopResponse,
} from "@sealant/workspaces/cloudflare/bridge-contract";

import {
  bearerMatches,
  bootEnvForLaunch,
  CONTROL_RELAY_PORT,
  CONTROL_SOCKET_PATH,
  DOTFILES_ARCHIVE_DIR,
  sandboxNameForRun,
  SECRET_ENV_FILE_PATH,
} from "./plan.js";

export { Sandbox };

interface Env {
  readonly Sandbox: DurableObjectNamespace<Sandbox<Env>>;
  /** Authenticates the control plane's launch/stop calls (its SEALANT_CF_BRIDGE_TOKEN). */
  readonly BRIDGE_TOKEN: string;
  /** Authenticates control-channel connections (the deployment's SEALANT_CONTROL_BEARER_TOKEN). */
  readonly CONTROL_TOKEN: string;
  /** Public hostname of this worker; launch answers advertise wss://<host>/… endpoints. */
  readonly BRIDGE_PUBLIC_HOST: string;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const message = (status: number, text: string): Response =>
  json(status, bridgeErrorResponseSchema.parse({ message: text }));

/** How long a launch will wait for sealantd to clone the workspace and bind its socket. */
const BOOT_WAIT_SECONDS = 180;

type SandboxClient = ReturnType<typeof getSandbox<Sandbox<Env>>>;

/** Run a short foreground command and return its exit code. */
const execExit = async (
  sandbox: SandboxClient,
  command: readonly [string, ...string[]],
  env?: Record<string, string>,
): Promise<number> => {
  const handle = await sandbox.exec([...command], env === undefined ? {} : { env });
  const exit = await handle.waitForExit();
  return exit.code;
};

/**
 * Write one file whose PATH may contain `$HOME` (expanded by the in-sandbox shell, matching the
 * Docker adapter's credential-file contract). Content and path travel as ENV, never argv.
 */
const writeExpandedFile = async (
  sandbox: SandboxClient,
  file: { readonly path: string; readonly contentBase64: string; readonly mode: string },
): Promise<void> => {
  const exitCode = await execExit(
    sandbox,
    [
      "/bin/sh",
      "-c",
      'umask 077; mkdir -p "$(dirname "$SEALANT_WRITE_PATH")" && printf %s "$SEALANT_WRITE_B64" | base64 -d > "$SEALANT_WRITE_PATH" && chmod "$SEALANT_WRITE_MODE" "$SEALANT_WRITE_PATH"',
    ],
    {
      SEALANT_WRITE_PATH: file.path,
      SEALANT_WRITE_B64: file.contentBase64,
      SEALANT_WRITE_MODE: file.mode,
    },
  );
  if (exitCode !== 0) {
    throw new Error(`staging a workspace file failed (exit ${exitCode})`);
  }
};

/** Stage secret env, credential files, and dotfiles; start sealantd and the control relay. */
const bootWorkspace = async (
  sandbox: SandboxClient,
  request: BridgeLaunchRequest,
): Promise<void> => {
  if (request.secretEnv !== undefined) {
    await writeExpandedFile(sandbox, {
      path: SECRET_ENV_FILE_PATH,
      contentBase64: btoa(JSON.stringify(request.secretEnv)),
      mode: "600",
    });
  }
  for (const file of request.credentialFiles ?? []) {
    await writeExpandedFile(sandbox, file);
  }
  if (request.dotfiles !== undefined) {
    await writeExpandedFile(sandbox, {
      path: `${DOTFILES_ARCHIVE_DIR}/manifest.json`,
      contentBase64: btoa(request.dotfiles.manifestJson),
      mode: "644",
    });
    for (const archive of request.dotfiles.archives) {
      await writeExpandedFile(sandbox, {
        path: `${DOTFILES_ARCHIVE_DIR}/${archive.name}`,
        contentBase64: archive.contentBase64,
        mode: "644",
      });
    }
  }
  await sandbox.exec(["/usr/local/bin/sealantd", "boot"], { env: bootEnvForLaunch(request) });
};

/** Wait for sealantd's control socket, then ensure the TCP relay for `wsConnect` is up. */
const awaitControlReady = async (sandbox: SandboxClient): Promise<void> => {
  const socketReady = await execExit(sandbox, [
    "/bin/sh",
    "-c",
    `i=0; while [ "$i" -lt ${BOOT_WAIT_SECONDS} ]; do [ -S ${CONTROL_SOCKET_PATH} ] && exit 0; i=$((i+1)); sleep 1; done; exit 1`,
  ]);
  if (socketReady !== 0) {
    throw new Error(
      `sealantd did not bind ${CONTROL_SOCKET_PATH} within ${BOOT_WAIT_SECONDS}s (clone failure or boot crash; check the sandbox logs)`,
    );
  }
  const relay = await sandbox.exec([
    "/usr/local/bin/socat",
    `TCP-LISTEN:${CONTROL_RELAY_PORT},fork,reuseaddr`,
    `UNIX-CONNECT:${CONTROL_SOCKET_PATH}`,
  ]);
  await relay.waitForPort(CONTROL_RELAY_PORT, { mode: "tcp" });
};

const handleLaunch = async (env: Env, request: Request): Promise<Response> => {
  const parsed = bridgeLaunchRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return message(
      400,
      `launch request does not match the bridge contract: ${parsed.error.message}`,
    );
  }
  const body = parsed.data;
  const name = sandboxNameForRun(body.runId);
  const sandbox = getSandbox(env.Sandbox, name);

  // One launcher per sandbox: mkdir is atomic, so a redelivered launch loses the claim and just
  // waits for readiness instead of double-booting sealantd against the same workspace.
  const claimed =
    (await execExit(sandbox, [
      "/bin/sh",
      "-c",
      `[ -S ${CONTROL_SOCKET_PATH} ] && exit 10; mkdir /run/sealant-launch-claim 2>/dev/null && exit 0; exit 20`,
    ])) === 0;
  if (claimed) {
    await bootWorkspace(sandbox, body);
  }
  await awaitControlReady(sandbox);

  const response: BridgeLaunchResponse = {
    resourceId: name,
    reference: name,
    status: "ready",
    controlEndpoint: `wss://${env.BRIDGE_PUBLIC_HOST}/v1/workspaces/${name}/control`,
  };
  return json(200, response);
};

const handleStop = async (env: Env, resourceId: string): Promise<Response> => {
  // The bridge keeps no registry: destroy is idempotent on the sandbox id, so an unknown or
  // already-destroyed workspace reports the same terminal outcome as a live one.
  await getSandbox(env.Sandbox, resourceId).destroy();
  const response: BridgeStopResponse = { outcome: "stopped" };
  return json(200, response);
};

const handleControl = (env: Env, resourceId: string, request: Request): Promise<Response> => {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return Promise.resolve(message(426, "the control endpoint only speaks WebSocket"));
  }
  return getSandbox(env.Sandbox, resourceId).wsConnect(request, CONTROL_RELAY_PORT);
};

const WORKSPACE_ROUTE = /^\/v1\/workspaces\/([A-Za-z0-9._-]+)(\/control)?$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const authorization = request.headers.get("authorization");

    try {
      if (url.pathname === "/v1/workspaces" && request.method === "POST") {
        if (!bearerMatches(authorization, env.BRIDGE_TOKEN)) {
          return message(401, "bridge: missing or invalid bridge token");
        }
        return await handleLaunch(env, request);
      }

      const match = WORKSPACE_ROUTE.exec(url.pathname);
      if (match?.[1] !== undefined && match[2] === "/control" && request.method === "GET") {
        if (!bearerMatches(authorization, env.CONTROL_TOKEN)) {
          return message(401, "bridge: missing or invalid control token");
        }
        return await handleControl(env, match[1], request);
      }
      if (match?.[1] !== undefined && match[2] === undefined && request.method === "DELETE") {
        if (!bearerMatches(authorization, env.BRIDGE_TOKEN)) {
          return message(401, "bridge: missing or invalid bridge token");
        }
        return await handleStop(env, match[1]);
      }

      return message(404, "unknown bridge route");
    } catch (cause) {
      return message(502, cause instanceof Error ? cause.message : "bridge failure");
    }
  },
};
