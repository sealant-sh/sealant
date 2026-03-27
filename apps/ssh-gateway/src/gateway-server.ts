import { createRequire } from "node:module";
import { resolve as pathResolve } from "node:path";
import type { Duplex } from "node:stream";

import type {
  AuthContext,
  Client as SshClient,
  ClientChannel,
  ConnectConfig,
  Connection,
  PseudoTtyInfo,
} from "ssh2";

const cjsRequire = createRequire(pathResolve(process.cwd(), "package.json"));
const ssh2 = cjsRequire("ssh2") as typeof import("ssh2");
const { Client, Server } = ssh2;

import { findAuthorizedKey, type AuthorizedKeyEntry } from "./authorized-keys.js";
import {
  parseSandboxIdFromUsername,
  parseSshEndpoint,
  resolveSandboxSshTarget,
} from "./sandbox-target.js";

export interface SshGatewayServerConfig {
  readonly host: string;
  readonly port: number;
  readonly hostKey: string;
  readonly allowedClientKeys: ReadonlyArray<AuthorizedKeyEntry>;
  readonly sandboxUsernamePrefix: string;
  readonly coreApiBaseUrl: string;
  readonly gatewayToken: string;
  readonly upstreamPrivateKey: string;
  readonly upstreamReadyTimeoutMs: number;
  readonly strictUpstreamHostKeyChecking: boolean;
}

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

const connectToUpstream = async (input: {
  readonly config: SshGatewayServerConfig;
  readonly sandboxId: string;
}) => {
  const target = await resolveSandboxSshTarget({
    apiBaseUrl: input.config.coreApiBaseUrl,
    gatewayToken: input.config.gatewayToken,
    sandboxId: input.sandboxId,
  });
  const endpoint = parseSshEndpoint(target.runtime.endpoint);
  const client = new Client();

  const ready = new Promise<SshClient>((resolve, reject) => {
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
          hostHash: "sha256",
        }
      : {
          hostVerifier: () => {
            return true;
          },
        }),
  };

  client.connect(connectConfig);

  return ready;
};

const bindClientConnection = (incomingConnection: Connection, config: SshGatewayServerConfig) => {
  let sandboxId: string | undefined;
  let upstreamPromise: Promise<SshClient> | undefined;

  const ensureUpstream = async (): Promise<SshClient> => {
    if (sandboxId === undefined) {
      throw new Error("Incoming SSH connection is not mapped to a sandbox.");
    }

    if (upstreamPromise === undefined) {
      upstreamPromise = connectToUpstream({
        config,
        sandboxId,
      });
    }

    return upstreamPromise;
  };

  incomingConnection.on("authentication", (ctx: AuthContext) => {
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
      ctx.accept();
      return;
    }

    if (ctx.blob === undefined) {
      ctx.reject();
      return;
    }

    const hashAlgo = typeof ctx.hashAlgo === "string" ? ctx.hashAlgo : undefined;
    if (!key.verify(ctx.blob, ctx.signature, hashAlgo)) {
      ctx.reject();
      return;
    }

    ctx.accept();
  });

  incomingConnection.on("ready", () => {
    incomingConnection.on("session", (acceptSession) => {
      const session = acceptSession();
      let sessionPty: PseudoTtyInfo | undefined;
      const sessionEnv: Record<string, string> = {};
      let activeUpstreamChannel: ClientChannel | undefined;

      session.on("pty", (acceptPty, _rejectPty, info) => {
        sessionPty = info;
        acceptPty();
      });

      session.on("env", (acceptEnv, _rejectEnv, info) => {
        sessionEnv[info.key] = info.val;
        acceptEnv();
      });

      session.on("window-change", (acceptWindowChange, _rejectWindowChange, info) => {
        activeUpstreamChannel?.setWindow(info.rows, info.cols, info.height, info.width);
        acceptWindowChange();
      });

      session.on("signal", (acceptSignal, _rejectSignal, info) => {
        activeUpstreamChannel?.signal(info.name);
        acceptSignal();
      });

      session.on("shell", (acceptChannel, rejectChannel) => {
        const incomingChannel = acceptChannel();

        if (incomingChannel === undefined) {
          rejectChannel();
          return;
        }

        void (async () => {
          try {
            const upstream = await ensureUpstream();
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
        return upstream.end();
      })
      .catch(() => undefined);
  });
};

export const startSshGatewayServer = (config: SshGatewayServerConfig) => {
  const server = new Server(
    {
      hostKeys: [config.hostKey],
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
