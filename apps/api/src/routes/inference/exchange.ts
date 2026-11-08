import type { InferenceReceipt } from "@sealant/api-contracts";
import { extractCodexSecrets } from "@sealant/credentials";

/** The decrypted login, in the shape its engine is wired for. */
export type ExchangeLogin =
  | { readonly shape: "claude-key"; readonly apiKey: string }
  | { readonly shape: "claude-setup-token"; readonly token: string }
  | {
      readonly shape: "claude-session";
      readonly credentialsJson: string;
      readonly accessToken: string;
      readonly refreshToken: string | undefined;
    }
  | { readonly shape: "codex-key"; readonly apiKey: string }
  | { readonly shape: "codex-auth-json"; readonly authJson: string };

/**
 * One inference exchange from its start to its last turn. A Claude engine's live session holds it,
 * so the decrypted login lives exactly as long as the session does, and nothing else keeps it.
 */
export interface Exchange {
  readonly ownerUserId: string;
  readonly receipt: InferenceReceipt;
  readonly login: ExchangeLogin;
  /** The login's literal secrets, read once, for redaction. */
  readonly secrets: readonly string[];
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
}): Exchange => ({ ...input, secrets: secretsOf(input.login) });
