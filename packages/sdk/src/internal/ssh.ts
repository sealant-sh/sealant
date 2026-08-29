/** Wire → public mapping for the workspace-SSH surface (gateway coordinates and SSH keys). */
import type { SetupStateResponse, SshKeySummary } from "@sealant/api-contracts";

import type { SshKey, WorkspaceSshInfo } from "../types.js";

export const mapWorkspaceSshInfo = (wire: SetupStateResponse): WorkspaceSshInfo | null =>
  wire.sshGateway === null
    ? null
    : {
        host: wire.sshGateway.host,
        port: wire.sshGateway.port,
        usernamePrefix: wire.sshGateway.usernamePrefix,
      };

export const mapSshKey = (wire: SshKeySummary): SshKey => ({
  sshKeyId: wire.sshKeyId,
  ownerUserId: wire.ownerUserId,
  name: wire.name,
  algorithm: wire.algorithm,
  fingerprint: wire.fingerprint,
  createdAt: wire.createdAt,
});
