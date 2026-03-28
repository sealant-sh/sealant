import type { Duplex } from "node:stream";

import type {
  AuthContext,
  Client as SshClient,
  ClientChannel,
  ConnectConfig,
  Connection,
  PseudoTtyInfo,
} from "ssh2";
import ssh2 from "ssh2";
const { Client, Server } = ssh2;

import { findAuthorizedKey, type AuthorizedKeyEntry } from "./authorized-keys.js";
import {
  parseSandboxIdFromUsername,
  parseSshEndpoint,
  resolveSandboxSshTarget,
} from "./sandbox-target.js";

/*
Gateway architecture in one sentence:
client SSH session <-> this process <-> upstream SSH session to sandbox runtime.

Important consequence:
- Every feature we want users to feel "as if they connected directly" must be forwarded
  through this middle hop (shell, exec, PTY resize, signals, tcp port forwarding, etc).
*/

export interface SshGatewayServerConfig {
  readonly host: string;
  readonly port: number;
  readonly hostKey: string;
  readonly banner?: string;
  readonly allowedClientKeys: ReadonlyArray<AuthorizedKeyEntry>;
  readonly sandboxUsernamePrefix: string;
  readonly coreApiBaseUrl: string;
  readonly gatewayToken: string;
  readonly upstreamPrivateKey: string;
  readonly upstreamReadyTimeoutMs: number;
  readonly strictUpstreamHostKeyChecking: boolean;
}

// Bi-directional piping with symmetric shutdown. We use this for every SSH channel
// pair (client<->gateway and gateway<->sandbox) so they behave like a direct connection.
const pipeStreams = (left: Duplex, right: Duplex) => {
  left.pipe(right);
  right.pipe(left);

  const closePair = () => {
    left.destroy();
    right.destroy();
  };

  left.on("error", closePair);
  right.on("error", closePair);
  left.on("close", () => {
    right.end();
  });
  right.on("close", () => {
    left.end();
  });
};

// Resolve the sandbox target via the API and then establish the upstream SSH session
// from the gateway to the runtime endpoint for that sandbox.
const connectToUpstream = async (input: {
  readonly config: SshGatewayServerConfig;
  readonly sandboxId: string;
}) => {
  // API is source-of-truth for current sandbox runtime endpoint.
  // We do not cache here yet because sandbox targets can rotate between attempts.
  const target = await resolveSandboxSshTarget({
    apiBaseUrl: input.config.coreApiBaseUrl,
    gatewayToken: input.config.gatewayToken,
    sandboxId: input.sandboxId,
  });
  const endpoint = parseSshEndpoint(target.runtime.endpoint);
  const client = new Client();

  const ready = new Promise<SshClient>((resolve, reject) => {
    // The first event wins this promise. Caller sees a simple await-able "connected or failed".
    client.once("ready", () => {
      resolve(client);
    });
    client.once("error", (error) => {
      console.error("[ssh-gateway] upstream connection error", {
        sandboxId: input.sandboxId,
        endpoint: target.runtime.endpoint,
        error: error.message,
      });
      reject(error);
    });
    client.once("close", () => {
      // If close happens before caller starts forwarding, treat as connect failure.
      reject(new Error(`Upstream SSH connection closed for sandbox ${input.sandboxId}.`));
    });
  });

  const connectConfig: ConnectConfig = {
    host: endpoint.host,
    port: endpoint.port,
    username: endpoint.user,
    privateKey: input.config.upstreamPrivateKey,
    readyTimeout: input.config.upstreamReadyTimeoutMs,
    ...(input.config.strictUpstreamHostKeyChecking
      ? {
          // Strict mode: require stable host key hashing/verification semantics.
          hostHash: "sha256",
        }
      : {
          // Dev mode: allow dynamic sandbox host keys without trust bootstrapping.
          hostVerifier: () => {
            return true;
          },
        }),
  };

  client.connect(connectConfig);

  return ready;
};

// One incoming client connection maps to exactly one sandbox and one lazily-opened
// upstream SSH connection. Session channels are then forwarded across that pair.
const bindClientConnection = (incomingConnection: Connection, config: SshGatewayServerConfig) => {
  // The sandbox routing decision comes from the SSH username (for example sbx-<id>).
  // We store it once auth passes and reuse it across all channels in this connection.
  let sandboxId: string | undefined;
  // A single client connection gets a single upstream SSH connection.
  // Channels multiplex over that one link.
  let upstreamPromise: Promise<SshClient> | undefined;

  const ensureUpstream = async (): Promise<SshClient> => {
    if (sandboxId === undefined) {
      throw new Error("Incoming SSH connection is not mapped to a sandbox.");
    }

    if (upstreamPromise === undefined) {
      // We intentionally defer upstream connection creation until the first channel request.
      // This avoids work for auth failures and lets us fail with precise request context.
      upstreamPromise = connectToUpstream({
        config,
        sandboxId,
      });
    }

    return upstreamPromise;
  };

  incomingConnection.on("authentication", (ctx: AuthContext) => {
    // We only support public-key auth at the gateway boundary.
    if (ctx.method !== "publickey") {
      ctx.reject(["publickey"]);
      return;
    }

    const resolvedSandboxId = parseSandboxIdFromUsername(
      ctx.username,
      config.sandboxUsernamePrefix,
    );

    if (resolvedSandboxId === undefined) {
      ctx.reject();
      return;
    }

    sandboxId = resolvedSandboxId;

    const key = findAuthorizedKey(config.allowedClientKeys, {
      algo: ctx.key.algo,
      data: ctx.key.data,
    });

    if (key === undefined) {
      ctx.reject();
      return;
    }

    if (ctx.signature === undefined) {
      // OpenSSH may probe a key before sending a signed proof. Accepting here means
      // "this key is recognized", not "auth is complete".
      ctx.accept();
      return;
    }

    if (ctx.blob === undefined) {
      ctx.reject();
      return;
    }

    const hashAlgo = typeof ctx.hashAlgo === "string" ? ctx.hashAlgo : undefined;
    // Signature verification proves possession of private key corresponding to allowed pubkey.
    if (!key.verify(ctx.blob, ctx.signature, hashAlgo)) {
      ctx.reject();
      return;
    }

    ctx.accept();
  });

  incomingConnection.on("ready", () => {
    incomingConnection.on("session", (acceptSession) => {
      const session = acceptSession();
      // These values are request metadata from the client side that must be replayed
      // on the upstream channel to preserve terminal behavior and process environment.
      let sessionPty: PseudoTtyInfo | undefined;
      const sessionEnv: Record<string, string> = {};
      let activeUpstreamChannel: ClientChannel | undefined;

      session.on("pty", (acceptPty, _rejectPty, info) => {
        // Client asked for a terminal. We remember dimensions and modes for upstream shell/exec.
        sessionPty = info;
        acceptPty();
      });

      session.on("env", (acceptEnv, _rejectEnv, info) => {
        // Forward client-requested env vars (for example TERM) to upstream command context.
        sessionEnv[info.key] = info.val;
        acceptEnv();
      });

      session.on("window-change", (acceptWindowChange, _rejectWindowChange, info) => {
        // Keep terminal resize events flowing to the sandbox shell.
        activeUpstreamChannel?.setWindow(info.rows, info.cols, info.height, info.width);
        acceptWindowChange();
      });

      session.on("signal", (acceptSignal, _rejectSignal, info) => {
        // Forward signals (for example Ctrl+C) so processes inside sandbox receive them.
        activeUpstreamChannel?.signal(info.name);
        acceptSignal();
      });

      session.on("shell", (acceptChannel, rejectChannel) => {
        // Accept inbound channel first so we always have a local endpoint ready to wire.
        const incomingChannel = acceptChannel();

        if (incomingChannel === undefined) {
          rejectChannel();
          return;
        }

        void (async () => {
          try {
            const upstream = await ensureUpstream();
            // ssh2 accepts either `false` (no PTY) or a PTY config object.
            const shellWindow =
              sessionPty === undefined
                ? false
                : {
                    cols: sessionPty.cols,
                    rows: sessionPty.rows,
                    width: sessionPty.width,
                    height: sessionPty.height,
                    modes: sessionPty.modes,
                  };

            upstream.shell(shellWindow, { env: sessionEnv }, (error, upstreamChannel) => {
              if (error != null || upstreamChannel === undefined) {
                console.error("[ssh-gateway] upstream shell request failed", {
                  sandboxId,
                  error:
                    error instanceof Error
                      ? error.message
                      : "Upstream shell channel was not established.",
                });
                rejectChannel();
                return;
              }

              activeUpstreamChannel = upstreamChannel;
              pipeStreams(incomingChannel, upstreamChannel);
            });
          } catch {
            console.error("[ssh-gateway] shell session setup failed", {
              sandboxId,
            });
            incomingChannel.end();
          }
        })();
      });

      session.on("exec", (acceptChannel, rejectChannel, info) => {
        const incomingChannel = acceptChannel();

        if (incomingChannel === undefined) {
          rejectChannel();
          return;
        }

        void (async () => {
          try {
            const upstream = await ensureUpstream();
            // Exec supports optional PTY as well (useful for tools expecting TTY).
            upstream.exec(
              info.command,
              {
                env: sessionEnv,
                ...(sessionPty === undefined ? {} : { pty: sessionPty }),
              },
              (error, upstreamChannel) => {
                if (error != null || upstreamChannel === undefined) {
                  console.error("[ssh-gateway] upstream exec request failed", {
                    sandboxId,
                    error:
                      error instanceof Error
                        ? error.message
                        : "Upstream exec channel was not established.",
                  });
                  rejectChannel();
                  return;
                }

                activeUpstreamChannel = upstreamChannel;
                pipeStreams(incomingChannel, upstreamChannel);
                // Preserve command exit status back to the original SSH client.
                upstreamChannel.on("exit", (code) => {
                  if (typeof code === "number") {
                    incomingChannel.exit(code);
                  }
                });
              },
            );
          } catch {
            console.error("[ssh-gateway] exec session setup failed", {
              sandboxId,
            });
            incomingChannel.exit(1);
            incomingChannel.end();
          }
        })();
      });

      session.on("subsystem", (acceptChannel, rejectChannel, info) => {
        const incomingChannel = acceptChannel();

        if (incomingChannel === undefined) {
          rejectChannel();
          return;
        }

        void (async () => {
          try {
            const upstream = await ensureUpstream();
            // Subsystems include SFTP and other SSH-level extension protocols.
            upstream.subsys(info.name, (error, upstreamChannel) => {
              if (error != null || upstreamChannel === undefined) {
                console.error("[ssh-gateway] upstream subsystem request failed", {
                  sandboxId,
                  subsystem: info.name,
                  error:
                    error instanceof Error
                      ? error.message
                      : "Upstream subsystem channel was not established.",
                });
                rejectChannel();
                return;
              }

              activeUpstreamChannel = upstreamChannel;
              pipeStreams(incomingChannel, upstreamChannel);
            });
          } catch {
            console.error("[ssh-gateway] subsystem session setup failed", {
              sandboxId,
              subsystem: info.name,
            });
            incomingChannel.end();
          }
        })();
      });
    });

    incomingConnection.on("tcpip", (acceptChannel, rejectChannel, info) => {
      void (async () => {
        try {
          const upstream = await ensureUpstream();
          // This is critical for VS Code Remote SSH. It uses dynamic forwarding (-D),
          // which arrives as tcpip requests on the gateway. We must open the matching
          // connection *through* the upstream SSH session, not from the gateway host.
          upstream.forwardOut(
            info.srcIP,
            info.srcPort,
            info.destIP,
            info.destPort,
            (error, upstreamChannel) => {
              if (error != null || upstreamChannel === undefined) {
                rejectChannel();
                return;
              }

              const incomingChannel = acceptChannel();

              if (incomingChannel === undefined) {
                upstreamChannel.end();
                return;
              }

              pipeStreams(incomingChannel, upstreamChannel);
            },
          );
        } catch {
          // If upstream is unavailable, deny this forwarded TCP request.
          rejectChannel();
        }
      })();
    });
  });

  incomingConnection.on("error", (error) => {
    console.error("[ssh-gateway] incoming connection error", {
      error: error.message,
      sandboxId,
    });
  });

  incomingConnection.on("close", () => {
    if (upstreamPromise === undefined) {
      return;
    }

    void upstreamPromise
      .then((upstream) => {
        // End upstream cleanly when client disconnects to avoid leaked sessions.
        return upstream.end();
      })
      .catch(() => undefined);
  });
};

// Start listening for incoming client SSH sessions.
export const startSshGatewayServer = (config: SshGatewayServerConfig) => {
  const server = new Server(
    {
      hostKeys: [config.hostKey],
      ...(config.banner === undefined ? {} : { banner: config.banner }),
    },
    (incomingConnection) => {
      bindClientConnection(incomingConnection, config);
    },
  );

  server.on("error", (error: Error) => {
    console.error("[ssh-gateway] server error", {
      error: error.message,
    });
  });

  return new Promise<{ stop: () => Promise<void> }>((resolve, reject) => {
    server.once("error", (error: Error) => {
      reject(error);
    });
    server.listen(config.port, config.host, () => {
      resolve({
        stop: async () => {
          await new Promise<void>((stopResolve, stopReject) => {
            server.close((error) => {
              if (error !== undefined) {
                stopReject(error);
                return;
              }

              stopResolve();
            });
          });
        },
      });
    });
  });
};
