import type {
  GitHubInstallationAccessToken,
  GitHubRemoteInstallation,
  GitHubRemoteInstallationRepository,
} from "./service.js";

export const defaultGitHubApiBaseUrl = "https://api.github.com";
export const gitHubApiVersion = "2022-11-28";

const installationRepositoryAuthRefPrefix = "github-installation-repository:";

export const base64UrlEncode = (value: string): string => {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
};

export const normalizePrivateKey = (value: string): string => {
  return value.includes("BEGIN") ? value : value.replace(/\\n/g, "\n");
};

export const toAuthorizationHeaders = (token: string) => {
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

export const parseInstallationResponse = (payload: unknown): GitHubRemoteInstallation => {
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

export const parseRepositoriesResponse = (
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
    const ownerLogin = assertString(owner.login, "GitHub repository owner login is required.");
    const name = assertString(parsedRepository.name, "GitHub repository name is required.");
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

export const parseInstallationTokenResponse = (payload: unknown): GitHubInstallationAccessToken => {
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
