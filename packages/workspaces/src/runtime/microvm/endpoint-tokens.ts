/**
 * Endpoint tokens for MicroVM control connections.
 *
 * Every request to a MicroVM's inbound endpoint — the launch-material push, health, and each
 * WebSocket upgrade for the control channel — must carry a token minted with
 * `CreateMicrovmAuthToken`, valid for at most 60 minutes and scoped to the VM and port
 * (https://docs.aws.amazon.com/lambda/latest/microvm-api/API_CreateMicrovmAuthToken.html). The
 * response carries no expiry, so it is computed here from the mint time.
 *
 * Policy:
 *   - one cached token per VM, re-minted (single-flight) when it is within the refresh margin of
 *     expiry, so a burst of connections shares a mint and no connection starts with a token
 *     about to lapse;
 *   - `hold` keeps a VM's token fresh on a timer for as long as something long-lived (a PTY
 *     attach, the telemetry ingester) is bound to it, so a reconnect after the proxy drops the
 *     connection needs no round trip. Whether the proxy cuts an ESTABLISHED WebSocket when its
 *     upgrade token expires is undocumented (POC note, risk #2); the consumer's reconnect path
 *     is what survives either answer, and this class only guarantees it a fresh token.
 *
 * Timers are `unref`'d: a hold never keeps a process alive on its own.
 */
import type { WebSocketConnectMaterial } from "../../sealantd/runtime.js";
import {
  PROXY_AUTH_HEADER,
  PROXY_PORT_HEADER,
  PROXY_SUBPROTOCOL,
  proxyAuthSubprotocol,
  proxyPortSubprotocol,
} from "./agent-contract.js";
import type { MicrovmApi } from "./api.js";

export interface MicrovmEndpointTokensOptions {
  readonly api: Pick<MicrovmApi, "createAuthToken">;
  /** The agent port every token is scoped to. */
  readonly port: number;
  readonly ttlMinutes: number;
  readonly refreshMarginMs: number;
  readonly webSocketAuth: "header" | "subprotocol";
  readonly now?: () => number;
}

interface CachedToken {
  readonly token: string;
  readonly expiresAt: number;
}

interface Hold {
  count: number;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export class MicrovmEndpointTokens {
  readonly #api: Pick<MicrovmApi, "createAuthToken">;
  readonly #port: number;
  readonly #ttlMs: number;
  readonly #refreshMarginMs: number;
  readonly #webSocketAuth: "header" | "subprotocol";
  readonly #now: () => number;
  readonly #cache = new Map<string, CachedToken>();
  readonly #minting = new Map<string, Promise<string>>();
  readonly #holds = new Map<string, Hold>();

  constructor(options: MicrovmEndpointTokensOptions) {
    if (options.refreshMarginMs >= options.ttlMinutes * 60_000) {
      throw new Error("the endpoint token refresh margin must be shorter than the token TTL");
    }
    this.#api = options.api;
    this.#port = options.port;
    this.#ttlMs = options.ttlMinutes * 60_000;
    this.#refreshMarginMs = options.refreshMarginMs;
    this.#webSocketAuth = options.webSocketAuth;
    this.#now = options.now ?? Date.now;
  }

  /** A token with at least the refresh margin of validity left; mints when needed. */
  async token(microvmId: string): Promise<string> {
    const cached = this.#cache.get(microvmId);
    if (cached !== undefined && cached.expiresAt - this.#refreshMarginMs > this.#now()) {
      return cached.token;
    }
    return this.#mint(microvmId);
  }

  /** Headers for a plain HTTPS request to the VM's endpoint. */
  async headers(microvmId: string): Promise<Record<string, string>> {
    return {
      [PROXY_AUTH_HEADER]: await this.token(microvmId),
      [PROXY_PORT_HEADER]: String(this.#port),
    };
  }

  /** The `prepare` hook for a websocket control target bound to this VM. */
  connectMaterial(microvmId: string): () => Promise<WebSocketConnectMaterial> {
    return async () => {
      const token = await this.token(microvmId);
      return this.#webSocketAuth === "header"
        ? { headers: { [PROXY_AUTH_HEADER]: token, [PROXY_PORT_HEADER]: String(this.#port) } }
        : {
            protocols: [
              PROXY_SUBPROTOCOL,
              proxyAuthSubprotocol(token),
              proxyPortSubprotocol(this.#port),
            ],
          };
    };
  }

  /**
   * Keep this VM's token fresh until released: a refresh is scheduled at the margin before
   * every expiry while at least one hold is open. Returns the release function; releasing more
   * than once is harmless.
   */
  hold(microvmId: string): () => void {
    const hold = this.#holds.get(microvmId) ?? { count: 0, timer: undefined };
    hold.count += 1;
    this.#holds.set(microvmId, hold);
    if (hold.timer === undefined) {
      this.#scheduleRefresh(microvmId, hold);
    }
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      hold.count -= 1;
      if (hold.count <= 0) {
        if (hold.timer !== undefined) {
          clearTimeout(hold.timer);
        }
        this.#holds.delete(microvmId);
      }
    };
  }

  /** Drop everything cached for a VM that is gone (stop, fence). Releases its holds. */
  forget(microvmId: string): void {
    this.#cache.delete(microvmId);
    this.#minting.delete(microvmId);
    const hold = this.#holds.get(microvmId);
    if (hold?.timer !== undefined) {
      clearTimeout(hold.timer);
    }
    this.#holds.delete(microvmId);
  }

  /** When the cached token for a VM expires (test/observability seam). */
  expiresAt(microvmId: string): number | undefined {
    return this.#cache.get(microvmId)?.expiresAt;
  }

  #mint(microvmId: string): Promise<string> {
    const inFlight = this.#minting.get(microvmId);
    if (inFlight !== undefined) {
      return inFlight;
    }
    const mintedAt = this.#now();
    const minting = this.#api
      .createAuthToken({
        microvmId,
        expirationInMinutes: this.#ttlMs / 60_000,
        port: this.#port,
      })
      .then((token) => {
        this.#cache.set(microvmId, { token, expiresAt: mintedAt + this.#ttlMs });
        return token;
      })
      .finally(() => {
        this.#minting.delete(microvmId);
      });
    this.#minting.set(microvmId, minting);
    return minting;
  }

  #scheduleRefresh(microvmId: string, hold: Hold): void {
    const expiresAt = this.#cache.get(microvmId)?.expiresAt;
    const dueIn =
      expiresAt === undefined ? 0 : Math.max(0, expiresAt - this.#refreshMarginMs - this.#now());
    hold.timer = setTimeout(() => {
      hold.timer = undefined;
      if (this.#holds.get(microvmId) !== hold) {
        return;
      }
      const refresh = async (): Promise<void> => {
        await this.#mint(microvmId).catch(() => undefined);
        if (this.#holds.get(microvmId) === hold) {
          // A failed mint retries after the margin; a successful one at the next margin.
          this.#scheduleRefresh(microvmId, hold);
        }
      };
      void refresh();
    }, dueIn);
    hold.timer.unref();
  }
}
