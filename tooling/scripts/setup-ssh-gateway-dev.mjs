import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/*
This script bootstraps a local dev environment for gateway-based SSH:
- generates key material if missing,
- updates .env with gateway vars (managed block),
- wires SSH host aliases so `ssh sbx-<sandboxId>` works,
- avoids clobbering user-managed config by writing managed blocks only.
*/

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const secretsDirectory = resolve(repoRoot, ".secrets");
const envPath = resolve(repoRoot, ".env");

const managedBlockStart = "# >>> sealant ssh-gateway dev >>>";
const managedBlockEnd = "# <<< sealant ssh-gateway dev <<<";
const sshConfigManagedBlockStart = "# >>> sealant ssh-gateway host mapping >>>";
const sshConfigManagedBlockEnd = "# <<< sealant ssh-gateway host mapping <<<";

const readTextFileIfExists = (filePath) => {
  return existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
};

const escapeForRegExp = (value) => {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
};

const removeManagedBlock = (
  content,
  markers = { start: managedBlockStart, end: managedBlockEnd },
) => {
  // We only rewrite the block that this script owns, so user-managed content stays intact.
  const pattern = new RegExp(
    `\\n?${escapeForRegExp(markers.start)}[\\s\\S]*?${escapeForRegExp(markers.end)}\\n?`,
    "g",
  );

  return content
    .replace(pattern, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
};

const readEnvValue = (content, key) => {
  const pattern = new RegExp(`^\\s*${escapeForRegExp(key)}\\s*=\\s*(.*)\\s*$`, "m");
  const match = content.match(pattern);

  if (match?.[1] === undefined) {
    return undefined;
  }

  const rawValue = match[1].trim();

  if (
    (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
    (rawValue.startsWith("'") && rawValue.endsWith("'"))
  ) {
    return rawValue.slice(1, -1);
  }

  return rawValue;
};

const runSshKeygen = (args) => {
  const result = spawnSync("ssh-keygen", args, { encoding: "utf8" });

  if (result.error !== undefined) {
    throw new Error(`Failed to execute ssh-keygen: ${result.error.message}`);
  }

  if (result.status !== 0) {
    throw new Error(`ssh-keygen failed with status ${result.status}: ${result.stderr}`);
  }
};

const ensureSshKeyPair = (input) => {
  // Idempotent key creation: if keys already exist, we keep them stable.
  const privateKeyPath = input.privateKeyPath;
  const publicKeyPath = `${privateKeyPath}.pub`;
  const hasPrivate = existsSync(privateKeyPath);
  const hasPublic = existsSync(publicKeyPath);

  if (hasPrivate && hasPublic) {
    return;
  }

  if (hasPrivate && !hasPublic) {
    // Recover a missing public key from an existing private key.
    const result = spawnSync("ssh-keygen", ["-y", "-f", privateKeyPath], { encoding: "utf8" });

    if (result.error !== undefined) {
      throw new Error(`Failed to derive public key for ${privateKeyPath}: ${result.error.message}`);
    }

    if (result.status !== 0 || result.stdout.trim().length === 0) {
      throw new Error(`Unable to derive public key for ${privateKeyPath}: ${result.stderr}`);
    }

    writeFileSync(publicKeyPath, `${result.stdout.trim()}\n`, "utf8");
    chmodSync(publicKeyPath, 0o644);
    return;
  }

  runSshKeygen(["-t", "ed25519", "-N", "", "-C", input.comment, "-f", privateKeyPath]);
  chmodSync(privateKeyPath, 0o600);
  chmodSync(publicKeyPath, 0o644);
};

const ensureAuthorizedKeyLine = (filePath, keyLine) => {
  // Append-only behavior keeps existing authorized keys valid while adding Sealant keys.
  const currentLines = readTextFileIfExists(filePath)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (!currentLines.includes(keyLine)) {
    currentLines.push(keyLine);
  }

  writeFileSync(filePath, `${currentLines.join("\n")}\n`, "utf8");
  chmodSync(filePath, 0o600);
};

const appendManagedBlock = (
  content,
  entries,
  markers = { start: managedBlockStart, end: managedBlockEnd },
) => {
  const lines = [
    markers.start,
    ...Object.entries(entries).map(([key, value]) => `${key}=${value}`),
    markers.end,
  ];
  const base = content.trimEnd();

  return `${base.length === 0 ? "" : `${base}\n\n`}${lines.join("\n")}\n`;
};

const appendManagedTextBlock = (content, lines, markers) => {
  const block = [markers.start, ...lines, markers.end].join("\n");
  const base = content.trimEnd();

  return `${base.length === 0 ? "" : `${base}\n\n`}${block}\n`;
};

const ensureFileContainsLine = (filePath, line) => {
  const currentLines = readTextFileIfExists(filePath)
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (currentLines.includes(line)) {
    return;
  }

  const nextContent = readTextFileIfExists(filePath).trimEnd();
  const withLine = `${nextContent.length === 0 ? "" : `${nextContent}\n`}${line}\n`;
  writeFileSync(filePath, withLine, "utf8");
};

const main = () => {
  // All generated material lives inside repo-local .secrets for dev convenience.
  mkdirSync(secretsDirectory, { recursive: true });

  const gatewayHostKeyPath = resolve(secretsDirectory, "ssh_gateway_host_key");
  const gatewayUpstreamKeyPath = resolve(secretsDirectory, "gateway_upstream_key");
  const gatewayClientKeyPath = resolve(secretsDirectory, "dev_client_key");
  const gatewayAllowedKeysPath = resolve(secretsDirectory, "gateway_allowed_keys");
  const sandboxAuthorizedKeysPath = resolve(secretsDirectory, "authorized_keys");

  ensureSshKeyPair({
    privateKeyPath: gatewayHostKeyPath,
    comment: "sealant-ssh-gateway-host",
  });
  ensureSshKeyPair({
    privateKeyPath: gatewayUpstreamKeyPath,
    comment: "sealant-ssh-gateway-upstream",
  });
  ensureSshKeyPair({
    privateKeyPath: gatewayClientKeyPath,
    comment: "sealant-ssh-gateway-dev-client",
  });

  const gatewayClientPublicKey = readFileSync(`${gatewayClientKeyPath}.pub`, "utf8").trim();
  const gatewayUpstreamPublicKey = readFileSync(`${gatewayUpstreamKeyPath}.pub`, "utf8").trim();

  // gateway_allowed_keys controls who can SSH into the gateway.
  ensureAuthorizedKeyLine(gatewayAllowedKeysPath, gatewayClientPublicKey);
  // authorized_keys controls what key the gateway can use against sandbox runtimes.
  ensureAuthorizedKeyLine(sandboxAuthorizedKeysPath, gatewayUpstreamPublicKey);

  const existingEnvLocal = readTextFileIfExists(envPath);
  const unmanagedContent = removeManagedBlock(existingEnvLocal);
  const token =
    readEnvValue(existingEnvLocal, "SANDBOX_SSH_GATEWAY_TOKEN") ?? randomBytes(24).toString("hex");
  const host = readEnvValue(existingEnvLocal, "SANDBOX_SSH_GATEWAY_HOST") ?? "127.0.0.1";
  const port = readEnvValue(existingEnvLocal, "SANDBOX_SSH_GATEWAY_PORT") ?? "2222";
  const prefix = readEnvValue(existingEnvLocal, "SANDBOX_SSH_GATEWAY_USERNAME_PREFIX") ?? "sbx";

  const nextEnvLocal = appendManagedBlock(unmanagedContent, {
    SANDBOX_SSH_GATEWAY_TOKEN: token,
    SANDBOX_SSH_GATEWAY_HOST: host,
    SANDBOX_SSH_GATEWAY_PORT: port,
    SANDBOX_SSH_GATEWAY_USERNAME_PREFIX: prefix,
  });

  writeFileSync(envPath, nextEnvLocal, "utf8");

  const homeDirectory = process.env.HOME ?? homedir();
  const userSshDirectory = resolve(homeDirectory, ".ssh");
  const userSshConfigPath = resolve(userSshDirectory, "config");
  const sealantConfigDirectory = resolve(homeDirectory, ".config", "sealant");
  const sealantSshConfigPath = resolve(sealantConfigDirectory, "ssh_config");
  const sealantKnownHostsPath = resolve(sealantConfigDirectory, "known_hosts");
  const normalizedPrefix = prefix.endsWith("-") ? prefix.slice(0, -1) : prefix;

  const writeManagedSshConfig = (sshConfigPath, knownHostsPath) => {
    if (!existsSync(knownHostsPath)) {
      writeFileSync(knownHostsPath, "", "utf8");
    }

    const existingSshConfig = readTextFileIfExists(sshConfigPath);
    const unmanagedSshConfig = removeManagedBlock(existingSshConfig, {
      start: sshConfigManagedBlockStart,
      end: sshConfigManagedBlockEnd,
    });
    const nextSshConfig = appendManagedTextBlock(
      unmanagedSshConfig,
      [
        `Host ${normalizedPrefix}-*`,
        // We keep HostName stable at gateway host and route by SSH username alias.
        `  HostName ${host}`,
        `  Port ${port}`,
        "  User %n",
        // %n keeps original alias (sbx-<id>) instead of resolved host (127.0.0.1).
        // This is required because gateway extracts sandbox id from SSH username.
        `  IdentityFile ${gatewayClientKeyPath}`,
        "  IdentitiesOnly yes",
        `  UserKnownHostsFile ${knownHostsPath}`,
        "  StrictHostKeyChecking accept-new",
      ],
      {
        start: sshConfigManagedBlockStart,
        end: sshConfigManagedBlockEnd,
      },
    );

    writeFileSync(sshConfigPath, nextSshConfig, "utf8");
    chmodSync(sshConfigPath, 0o600);
    chmodSync(knownHostsPath, 0o600);
  };

  let effectiveSshConfigPath = sealantSshConfigPath;
  let effectiveKnownHostsPath = sealantKnownHostsPath;
  let includeDirective = "Include ~/.config/sealant/ssh_config";

  try {
    // Preferred path: user-scoped config under ~/.config/sealant.
    mkdirSync(sealantConfigDirectory, { recursive: true });
    writeManagedSshConfig(sealantSshConfigPath, sealantKnownHostsPath);
  } catch {
    // Fallback when home is managed/read-only (common in Nix setups).
    effectiveSshConfigPath = resolve(secretsDirectory, "ssh_config");
    effectiveKnownHostsPath = resolve(secretsDirectory, "known_hosts");
    writeManagedSshConfig(effectiveSshConfigPath, effectiveKnownHostsPath);
    includeDirective = `Include ${effectiveSshConfigPath}`;
  }

  let includeDirectiveConfigured = false;

  try {
    // If possible, automatically include the generated config from ~/.ssh/config.
    mkdirSync(userSshDirectory, { recursive: true });
    ensureFileContainsLine(userSshConfigPath, includeDirective);
    chmodSync(userSshConfigPath, 0o600);
    includeDirectiveConfigured = true;
  } catch {
    // If this fails, we print exact manual instructions below.
    includeDirectiveConfigured = false;
  }

  console.log("[ssh-gateway-setup] prepared local gateway dev assets");
  console.log(`[ssh-gateway-setup] env file: ${envPath}`);
  console.log(`[ssh-gateway-setup] secrets dir: ${secretsDirectory}`);
  console.log("[ssh-gateway-setup] generated/verified keys:");
  console.log(`  - ${gatewayHostKeyPath}`);
  console.log(`  - ${gatewayUpstreamKeyPath}`);
  console.log(`  - ${gatewayClientKeyPath}`);
  console.log("[ssh-gateway-setup] updated key allowlists:");
  console.log(`  - ${gatewayAllowedKeysPath}`);
  console.log(`  - ${sandboxAuthorizedKeysPath}`);
  console.log("[ssh-gateway-setup] wrote SSH client config:");
  console.log(`  - ${effectiveSshConfigPath}`);
  console.log(`  - ${effectiveKnownHostsPath}`);
  if (includeDirectiveConfigured) {
    console.log(`  - ${userSshConfigPath} (Include directive ensured)`);
  } else {
    console.log(
      `  - ${userSshConfigPath} is read-only; skipped the Include (connect with -F instead — see below).`,
    );
    console.log(
      `    To enable the short \`ssh sbx-<id>\` form, add this line yourself: ${includeDirective}`,
    );
  }
  console.log("[ssh-gateway-setup] next steps:");
  console.log("  1) Infra:          docker compose up -d");
  console.log("  2) Migrate DB:     pnpm db:migrate");
  console.log(
    "  3) Seed DB:        pnpm --filter @sealant/db db:seed   (registers the dev client key for usr_local)",
  );
  console.log("  4) API + web:      pnpm --filter @sealant/api dev   (and --filter @sealant/web)");
  console.log("  5) Worker+gateway: docker compose --profile apps up -d --build");
  console.log(`  6) Connect:        ssh -F ${effectiveSshConfigPath} sbx-<sandboxId>`);
};

main();
