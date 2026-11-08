import type { EndpointUrl, InferenceReceipt } from "@sealant/api-contracts";
import { extractCodexSecrets } from "@sealant/credentials";

import { exchangeRedaction } from "./support.js";

/**
 * The decrypted login, in the shape its engine is wired for. A key with a `baseUrl` is sent there
 * and nowhere else.
 */
export type ExchangeLogin =
  | { readonly shape: "claude-key"; readonly apiKey: string; readonly baseUrl?: EndpointUrl }
  | { readonly shape: "claude-setup-token"; readonly token: string }
  | {
      readonly shape: "claude-session";
      readonly credentialsJson: string;
      readonly accessToken: string;
      readonly refreshToken: string | undefined;
    }
  | { readonly shape: "codex-key"; readonly apiKey: string; readonly baseUrl?: EndpointUrl }
  | { readonly shape: "codex-auth-json"; readonly authJson: string };

/**
 * One inference exchange from its start to its last turn. A Claude engine's live session holds it,
 * so the decrypted login lives exactly as long as the session does, and nothing else keeps it.
 */
export interface Exchange {
  readonly ownerUserId: string;
  readonly receipt: InferenceReceipt;
  readonly login: ExchangeLogin;
  /**
   * Strips from text what must never leave the exchange: the login's secrets, and its endpoint's
   * URL and path. Built once from the login.
   */
  readonly redact: (text: string) => string;
}

const secretsOf = (login: ExchangeLogin): readonly string[] => {
  switch (login.shape) {
    case "claude-key":
    case "codex-key": {
      return [login.apiKey];
    }
    case "claude-setup-token": {
      return [login.token];
    }
    case "claude-session": {
      return login.refreshToken === undefined
        ? [login.accessToken]
        : [login.accessToken, login.refreshToken];
    }
    case "codex-auth-json": {
      return extractCodexSecrets(login.authJson);
    }
  }
};

export const openExchange = (input: {
  readonly ownerUserId: string;
  readonly receipt: InferenceReceipt;
  readonly login: ExchangeLogin;
}): Exchange => ({
  ...input,
  redact: exchangeRedaction(
    secretsOf(input.login),
    "baseUrl" in input.login ? input.login.baseUrl : undefined,
  ),
});
