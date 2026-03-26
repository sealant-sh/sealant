import { createHmac, createPrivateKey, sign, timingSafeEqual } from "node:crypto";

const defaultGitHubApiBaseUrl = "https://api.github.com";
const gitHubApiVersion = "2022-11-28";
const installationRepositoryAuthRefPrefix = "github-installation-repository:";

export interface GitHubSourceIntegrationOptions {
  readonly appId?: string;
  readonly privateKey?: string;
  readonly webhookSecret?: string;
  readonly apiBaseUrl?: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
}

export interface GitHubInstallationAccessToken {
  readonly token: string;
  readonly expiresAt: Date;
}

export interface GitHubRemoteInstallation {
  readonly externalInstallationId: string;
  readonly externalAccountId?: string;
  readonly accountLogin: string;
  readonly accountType: "organization" | "user";
  readonly targetType: "organization" | "user";
  readonly permissions: Record<string, string>;
  readonly repositorySelection: "all" | "selected";
  readonly suspendedAt?: Date;
}

export interface GitHubRemoteInstallationRepository {
  readonly externalRepositoryId: string;
  readonly owner: string;
  readonly name: string;
  readonly fullName: string;
  readonly defaultBranch: string;
  readonly isPrivate: boolean;
  readonly isArchived: boolean;
  readonly pushedAt?: Date;
  readonly url: string;
}

const base64UrlEncode = (value: string): string => {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
};

const normalizePrivateKey = (value: string): string => {
  return value.includes("BEGIN") ? value : value.replace(/\\n/g, "\n");
};

const toAuthorizationHeaders = (token: string) => {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": gitHubApiVersion,
  };
};

const assertObject = (value: unknown, message: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null) {
    throw new Error(message);
  }

  return value as Record<string, unknown>;
};

const assertString = (value: unknown, message: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(message);
  }

  return value;
};

const assertBoolean = (value: unknown, message: string): boolean => {
  if (typeof value !== "boolean") {
    throw new Error(message);
  }

  return value;
};

const toDate = (value: unknown): Date | undefined => {
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
};

const toGitHubInstallationAccountType = (value: unknown): "organization" | "user" => {
  return value === "Organization" ? "organization" : "user";
};

const parsePermissions = (value: unknown): Record<string, string> => {
  if (typeof value !== "object" || value === null) {
    return {};
  }

  const entries = Object.entries(value).filter((entry): entry is [string, string] => {
    return typeof entry[1] === "string";
  });

  return Object.fromEntries(entries);
};

const parseInstallationResponse = (payload: unknown): GitHubRemoteInstallation => {
  const parsed = assertObject(payload, "GitHub installation response must be an object.");
  const account = assertObject(parsed.account, "GitHub installation account must be an object.");
  const accountType = toGitHubInstallationAccountType(account.type);
  const suspendedAt = toDate(parsed.suspended_at);
  const targetType =
    typeof parsed.target_type === "string"
      ? toGitHubInstallationAccountType(parsed.target_type)
      : accountType;

  return {
    externalInstallationId: String(parsed.id),
    ...(typeof account.id === "number" || typeof account.id === "string"
      ? { externalAccountId: String(account.id) }
      : {}),
    accountLogin: assertString(account.login, "GitHub installation account login is required."),
    accountType,
    targetType,
    permissions: parsePermissions(parsed.permissions),
    repositorySelection: parsed.repository_selection === "selected" ? "selected" : "all",
    ...(suspendedAt === undefined ? {} : { suspendedAt }),
  };
};

const parseRepositoriesResponse = (
  payload: unknown,
): readonly GitHubRemoteInstallationRepository[] => {
  const parsed = assertObject(payload, "GitHub repositories response must be an object.");
  const repositories = parsed.repositories;

  if (!Array.isArray(repositories)) {
    throw new Error("GitHub repositories response did not include a repositories array.");
  }

  return repositories.map((repository, index) => {
    const parsedRepository = assertObject(
      repository,
      `GitHub repository payload at index ${index} must be an object.`,
    );
    const owner = assertObject(
      parsedRepository.owner,
      `GitHub repository owner payload at index ${index} must be an object.`,
    );
    const ownerLogin = assertString(owner.login, `GitHub repository owner login is required.`);
    const name = assertString(parsedRepository.name, `GitHub repository name is required.`);
    const pushedAt = toDate(parsedRepository.pushed_at);

    return {
      externalRepositoryId: String(parsedRepository.id),
      owner: ownerLogin,
      name,
      fullName: assertString(
        parsedRepository.full_name,
        "GitHub repository full_name is required.",
      ),
      defaultBranch: assertString(
        parsedRepository.default_branch,
        "GitHub repository default_branch is required.",
      ),
      isPrivate: assertBoolean(
        parsedRepository.private,
        "GitHub repository private flag is required.",
      ),
      isArchived: assertBoolean(
        parsedRepository.archived,
        "GitHub repository archived flag is required.",
      ),
      ...(pushedAt === undefined ? {} : { pushedAt }),
      url: assertString(parsedRepository.clone_url, "GitHub repository clone_url is required."),
    };
  });
};

const parseInstallationTokenResponse = (payload: unknown): GitHubInstallationAccessToken => {
  const parsed = assertObject(payload, "GitHub installation token response must be an object.");
  const expiresAt = toDate(parsed.expires_at);

  if (expiresAt === undefined) {
    throw new Error("GitHub installation token response did not include a valid expires_at.");
  }

  return {
    token: assertString(
      parsed.token,
      "GitHub installation token response did not include a token.",
    ),
    expiresAt,
  };
};

export const createGitHubInstallationRepositoryAuthRef = (
  installationRepositoryId: string,
): string => {
  return `${installationRepositoryAuthRefPrefix}${installationRepositoryId}`;
};

export const parseGitHubInstallationRepositoryAuthRef = (
  authRef: string | undefined,
): string | undefined => {
  if (
    authRef === undefined ||
    !authRef.startsWith(installationRepositoryAuthRefPrefix) ||
    authRef.length <= installationRepositoryAuthRefPrefix.length
  ) {
    return undefined;
  }

  return authRef.slice(installationRepositoryAuthRefPrefix.length);
};

export class GitHubSourceIntegration {
  private readonly appId: string | undefined;

  private readonly privateKey: string | undefined;

  private readonly webhookSecret: string | undefined;

  private readonly apiBaseUrl: string;

  private readonly fetchImpl: typeof fetch;

  private readonly now: () => Date;

  public constructor(options: GitHubSourceIntegrationOptions = {}) {
    this.appId = options.appId;
    this.privateKey = options.privateKey;
    this.webhookSecret = options.webhookSecret;
    this.apiBaseUrl = options.apiBaseUrl ?? defaultGitHubApiBaseUrl;
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  public isConfigured(): boolean {
    return this.appId !== undefined && this.privateKey !== undefined;
  }

  public isWebhookVerificationConfigured(): boolean {
    return this.webhookSecret !== undefined;
  }

  public createAppJwt(): string {
    if (this.appId === undefined || this.privateKey === undefined) {
      throw new Error("GitHub App credentials are not configured.");
    }

    const issuedAtSeconds = Math.floor(this.now().getTime() / 1000) - 60;
    const expiresAtSeconds = issuedAtSeconds + 9 * 60;
    const encodedHeader = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const encodedPayload = base64UrlEncode(
      JSON.stringify({
        iat: issuedAtSeconds,
        exp: expiresAtSeconds,
        iss: this.appId,
      }),
    );
    const signingInput = `${encodedHeader}.${encodedPayload}`;
    const signature = sign(
      "RSA-SHA256",
      Buffer.from(signingInput, "utf8"),
      createPrivateKey(normalizePrivateKey(this.privateKey)),
    )
      .toString("base64")
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");

    return `${signingInput}.${signature}`;
  }

  public verifyWebhookSignature(input: {
    readonly payload: string;
    readonly signature256: string | undefined;
  }): boolean {
    if (this.webhookSecret === undefined || input.signature256 === undefined) {
      return false;
    }

    const expected = `sha256=${createHmac("sha256", this.webhookSecret).update(input.payload).digest("hex")}`;
    const expectedBuffer = Buffer.from(expected, "utf8");
    const receivedBuffer = Buffer.from(input.signature256, "utf8");

    return (
      expectedBuffer.length === receivedBuffer.length &&
      timingSafeEqual(expectedBuffer, receivedBuffer)
    );
  }

  public async createInstallationAccessToken(
    externalInstallationId: string,
  ): Promise<GitHubInstallationAccessToken> {
    const appJwt = this.createAppJwt();
    const response = await this.fetchImpl(
      `${this.apiBaseUrl}/app/installations/${encodeURIComponent(externalInstallationId)}/access_tokens`,
      {
        method: "POST",
        headers: {
          ...toAuthorizationHeaders(appJwt),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      },
    );

    if (!response.ok) {
      throw new Error(`GitHub installation token request failed with status ${response.status}.`);
    }

    return parseInstallationTokenResponse(await response.json());
  }

  public async getInstallation(externalInstallationId: string): Promise<GitHubRemoteInstallation> {
    const appJwt = this.createAppJwt();
    const response = await this.fetchImpl(
      `${this.apiBaseUrl}/app/installations/${encodeURIComponent(externalInstallationId)}`,
      {
        headers: toAuthorizationHeaders(appJwt),
      },
    );

    if (!response.ok) {
      throw new Error(`GitHub installation request failed with status ${response.status}.`);
    }

    return parseInstallationResponse(await response.json());
  }

  public async listInstallationRepositories(
    externalInstallationId: string,
  ): Promise<readonly GitHubRemoteInstallationRepository[]> {
    const installationToken = await this.createInstallationAccessToken(externalInstallationId);
    const repositories: GitHubRemoteInstallationRepository[] = [];
    let page = 1;

    while (true) {
      const response = await this.fetchImpl(
        `${this.apiBaseUrl}/installation/repositories?per_page=100&page=${page}`,
        {
          headers: toAuthorizationHeaders(installationToken.token),
        },
      );

      if (!response.ok) {
        throw new Error(
          `GitHub installation repositories request failed with status ${response.status}.`,
        );
      }

      const pageRepositories = parseRepositoriesResponse(await response.json());
      repositories.push(...pageRepositories);

      if (pageRepositories.length < 100) {
        break;
      }

      page += 1;
    }

    return repositories;
  }
}

export const createGitHubSourceIntegration = (options: GitHubSourceIntegrationOptions = {}) => {
  return new GitHubSourceIntegration(options);
};
