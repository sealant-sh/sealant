import type {
  ClaudeCredentialPayload,
  CodexCredentialPayload,
  GitHubCredentialPayload,
} from "./payloads.js";

/*
Pure injection planner (design doc §4/§6): decrypted provider payload -> the plan the runtime
adapter executes at launch. Env entries join the container's `-e` args; file entries are written
via `docker exec` with content piped over stdin ($HOME expansion happens inside the container
shell, which is why the path literally contains `$HOME/`).
*/

export type CredentialInjection =
  | { readonly kind: "env"; readonly key: string; readonly value: string }
  | {
      readonly kind: "file";
      readonly path: string;
      readonly contentBase64: string;
      readonly mode: string;
    };

export const CLAUDE_OAUTH_TOKEN_ENV_KEY = "CLAUDE_CODE_OAUTH_TOKEN";
export const CODEX_AUTH_JSON_PATH = "$HOME/.codex/auth.json";
export const GITHUB_TOKEN_ENV_KEYS = ["GITHUB_TOKEN", "GH_TOKEN"] as const;

type PlanCredentialInjectionsArgs =
  | readonly ["claude", ClaudeCredentialPayload]
  | readonly ["codex", CodexCredentialPayload]
  | readonly ["github", GitHubCredentialPayload];

export const planCredentialInjections = (
  ...args: PlanCredentialInjectionsArgs
): readonly CredentialInjection[] => {
  const [provider, payload] = args;

  switch (provider) {
    case "claude": {
      return [{ kind: "env", key: CLAUDE_OAUTH_TOKEN_ENV_KEY, value: payload.token }];
    }
    case "codex": {
      return [
        {
          kind: "file",
          path: CODEX_AUTH_JSON_PATH,
          contentBase64: Buffer.from(payload.authJson, "utf8").toString("base64"),
          mode: "600",
        },
      ];
    }
    case "github": {
      return GITHUB_TOKEN_ENV_KEYS.map((key) => ({
        kind: "env",
        key,
        value: payload.token,
      }));
    }
  }
};

// ---------------------------------------------------------------------------
// Blueprint credential refs — blueprints never carry secret material, only
// opaque `connected-account:<id>` refs the worker resolves and decrypts just
// before launch (mirrors the github-installation-repository authRef pattern).
// ---------------------------------------------------------------------------

export const CONNECTED_ACCOUNT_REF_PREFIX = "connected-account:";

export const createConnectedAccountRef = (connectedAccountId: string): string => {
  return `${CONNECTED_ACCOUNT_REF_PREFIX}${connectedAccountId}`;
};

export const parseConnectedAccountRef = (ref: string | undefined): string | undefined => {
  if (
    ref === undefined ||
    !ref.startsWith(CONNECTED_ACCOUNT_REF_PREFIX) ||
    ref.length <= CONNECTED_ACCOUNT_REF_PREFIX.length
  ) {
    return undefined;
  }

  return ref.slice(CONNECTED_ACCOUNT_REF_PREFIX.length);
};
