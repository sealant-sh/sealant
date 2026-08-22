/**
 * The shell script that writes one connected-account credential file inside a workspace. Shared
 * by every runtime adapter: Docker pipes the base64 payload through `docker exec -i`, Kubernetes
 * streams it over the authenticated control channel's stdin. The payload is NEVER placed in argv,
 * so it cannot land in a process list or in the daemon's `processStarted` record.
 */
import type { CredentialFileInjection } from "./runtime-adapter.js";

const createAdapterError = (code: string, message: string): Error & { code: string } =>
  Object.assign(new Error(message), { code });

export const buildCredentialFileWriteScript = (file: CredentialFileInjection): string => {
  if (!/^[A-Za-z0-9_$/.-]+$/.test(file.path)) {
    throw createAdapterError(
      "credential-file-injection-failed",
      `Credential file path '${file.path}' contains characters that are not allowed in an injection path.`,
    );
  }
  if (!/^[0-7]{3,4}$/.test(file.mode)) {
    throw createAdapterError(
      "credential-file-injection-failed",
      `Credential file mode '${file.mode}' is not a valid octal mode.`,
    );
  }

  return `umask 077 && mkdir -p "$(dirname "${file.path}")" && base64 -d > "${file.path}" && chmod ${file.mode} "${file.path}"`;
};
