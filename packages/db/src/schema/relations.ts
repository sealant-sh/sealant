import { defineRelations } from "drizzle-orm";

import * as schema from "../schema/index.js";

export const relations = defineRelations(schema, (r) => ({
  user: {
    sessions: r.many.session({ from: r.user.id, to: r.session.userId }),
    accounts: r.many.account({ from: r.user.id, to: r.account.userId }),
    githubInstallationGrants: r.many.githubInstallationUserGrants({
      from: r.user.id,
      to: r.githubInstallationUserGrants.userId,
    }),
    grantedGitHubInstallationGrants: r.many.githubInstallationUserGrants({
      from: r.user.id,
      to: r.githubInstallationUserGrants.grantedByUserId,
    }),
    profiles: r.many.profiles({ from: r.user.id, to: r.profiles.ownerUserId }),
    createdProfileRevisions: r.many.profileRevisions({
      from: r.user.id,
      to: r.profileRevisions.createdByUserId,
    }),
    secrets: r.many.secrets({ from: r.user.id, to: r.secrets.ownerUserId }),
    createdSecretVersions: r.many.secretVersions({
      from: r.user.id,
      to: r.secretVersions.createdByUserId,
    }),
    sshKeys: r.many.sshKeys({ from: r.user.id, to: r.sshKeys.ownerUserId }),
    connectedAccounts: r.many.connectedAccounts({
      from: r.user.id,
      to: r.connectedAccounts.ownerUserId,
    }),
    createdRepositoryProfileRevisions: r.many.repositoryProfileRevisions({
      from: r.user.id,
      to: r.repositoryProfileRevisions.createdByUserId,
    }),
    ownedWorkspaceAttempts: r.many.workspaceAttempts({
      from: r.user.id,
      to: r.workspaceAttempts.ownerUserId,
    }),
    requestedWorkspaceAttempts: r.many.workspaceAttempts({
      from: r.user.id,
      to: r.workspaceAttempts.requestedByUserId,
    }),
    ownedWorkspaces: r.many.workspaces({ from: r.user.id, to: r.workspaces.ownerUserId }),
    requestedWorkspaces: r.many.workspaces({
      from: r.user.id,
      to: r.workspaces.requestedByUserId,
    }),
  },

  session: {
    user: r.one.user({ from: r.session.userId, to: r.user.id }),
  },

  account: {
    user: r.one.user({ from: r.account.userId, to: r.user.id }),
  },

  repositories: {
    githubInstallationRepositories: r.many.githubInstallationRepositories({
      from: r.repositories.id,
      to: r.githubInstallationRepositories.repositoryId,
    }),
    repositoryProfiles: r.many.repositoryProfiles({
      from: r.repositories.id,
      to: r.repositoryProfiles.repositoryId,
    }),
    workspaceAttempts: r.many.workspaceAttempts({
      from: r.repositories.id,
      to: r.workspaceAttempts.repositoryId,
    }),
    workspaces: r.many.workspaces({ from: r.repositories.id, to: r.workspaces.repositoryId }),
  },

  githubAppInstallations: {
    repositories: r.many.githubInstallationRepositories({
      from: r.githubAppInstallations.id,
      to: r.githubInstallationRepositories.installationId,
    }),
    userGrants: r.many.githubInstallationUserGrants({
      from: r.githubAppInstallations.id,
      to: r.githubInstallationUserGrants.installationId,
    }),
    webhookDeliveries: r.many.githubWebhookDeliveries({
      from: r.githubAppInstallations.externalInstallationId,
      to: r.githubWebhookDeliveries.installationExternalId,
    }),
  },

  githubInstallationRepositories: {
    installation: r.one.githubAppInstallations({
      from: r.githubInstallationRepositories.installationId,
      to: r.githubAppInstallations.id,
    }),
    repository: r.one.repositories({
      from: r.githubInstallationRepositories.repositoryId,
      to: r.repositories.id,
    }),
  },

  githubInstallationUserGrants: {
    installation: r.one.githubAppInstallations({
      from: r.githubInstallationUserGrants.installationId,
      to: r.githubAppInstallations.id,
    }),
    user: r.one.user({ from: r.githubInstallationUserGrants.userId, to: r.user.id }),
    grantedByUser: r.one.user({
      from: r.githubInstallationUserGrants.grantedByUserId,
      to: r.user.id,
    }),
  },

  githubWebhookDeliveries: {
    installation: r.one.githubAppInstallations({
      from: r.githubWebhookDeliveries.installationExternalId,
      to: r.githubAppInstallations.externalInstallationId,
    }),
  },

  profiles: {
    owner: r.one.user({ from: r.profiles.ownerUserId, to: r.user.id }),
    revisions: r.many.profileRevisions({ from: r.profiles.id, to: r.profileRevisions.profileId }),
    activeRevision: r.one.profileRevisions({
      from: r.profiles.activeRevisionId,
      to: r.profileRevisions.id,
    }),
    connectedAccountBindings: r.many.profileConnectedAccounts({
      from: r.profiles.id,
      to: r.profileConnectedAccounts.profileId,
    }),
  },

  connectedAccounts: {
    owner: r.one.user({ from: r.connectedAccounts.ownerUserId, to: r.user.id }),
    profileBindings: r.many.profileConnectedAccounts({
      from: r.connectedAccounts.id,
      to: r.profileConnectedAccounts.connectedAccountId,
    }),
  },

  profileConnectedAccounts: {
    profile: r.one.profiles({ from: r.profileConnectedAccounts.profileId, to: r.profiles.id }),
    connectedAccount: r.one.connectedAccounts({
      from: r.profileConnectedAccounts.connectedAccountId,
      to: r.connectedAccounts.id,
    }),
  },

  profileRevisions: {
    profile: r.one.profiles({ from: r.profileRevisions.profileId, to: r.profiles.id }),
    createdByUser: r.one.user({ from: r.profileRevisions.createdByUserId, to: r.user.id }),
    envVars: r.many.profileEnvVars({
      from: r.profileRevisions.id,
      to: r.profileEnvVars.profileRevisionId,
    }),
    secretBindings: r.many.profileSecretBindings({
      from: r.profileRevisions.id,
      to: r.profileSecretBindings.profileRevisionId,
    }),
    sshSettings: r.one.profileSshSettings({
      from: r.profileRevisions.id,
      to: r.profileSshSettings.profileRevisionId,
    }),
    sshKeyBindings: r.many.profileSshKeyBindings({
      from: r.profileRevisions.id,
      to: r.profileSshKeyBindings.profileRevisionId,
    }),
    repositoryProfileLinks: r.many.repositoryProfileProfileLinks({
      from: r.profileRevisions.id,
      to: r.repositoryProfileProfileLinks.profileRevisionId,
    }),
    repositoryProfileRevisions: r.many.repositoryProfileRevisions({
      from: r.profileRevisions.id.through(r.repositoryProfileProfileLinks.profileRevisionId),
      to: r.repositoryProfileRevisions.id.through(
        r.repositoryProfileProfileLinks.repositoryProfileRevisionId,
      ),
    }),
    activeProfiles: r.many.profiles({
      from: r.profileRevisions.id,
      to: r.profiles.activeRevisionId,
    }),
    workspaceAttempts: r.many.workspaceAttempts({
      from: r.profileRevisions.id,
      to: r.workspaceAttempts.profileRevisionId,
    }),
    workspaces: r.many.workspaces({
      from: r.profileRevisions.id,
      to: r.workspaces.profileRevisionId,
    }),
  },

  profileEnvVars: {
    profileRevision: r.one.profileRevisions({
      from: r.profileEnvVars.profileRevisionId,
      to: r.profileRevisions.id,
    }),
  },

  secrets: {
    owner: r.one.user({ from: r.secrets.ownerUserId, to: r.user.id }),
    versions: r.many.secretVersions({ from: r.secrets.id, to: r.secretVersions.secretId }),
    profileSecretBindings: r.many.profileSecretBindings({
      from: r.secrets.id,
      to: r.profileSecretBindings.secretId,
    }),
    privateKeySshKeys: r.many.sshKeys({ from: r.secrets.id, to: r.sshKeys.privateKeySecretId }),
    passphraseSshKeys: r.many.sshKeys({ from: r.secrets.id, to: r.sshKeys.passphraseSecretId }),
  },

  secretVersions: {
    secret: r.one.secrets({ from: r.secretVersions.secretId, to: r.secrets.id }),
    createdByUser: r.one.user({ from: r.secretVersions.createdByUserId, to: r.user.id }),
    profileSecretBindings: r.many.profileSecretBindings({
      from: r.secretVersions.id,
      to: r.profileSecretBindings.secretVersionId,
    }),
  },

  profileSecretBindings: {
    profileRevision: r.one.profileRevisions({
      from: r.profileSecretBindings.profileRevisionId,
      to: r.profileRevisions.id,
    }),
    secret: r.one.secrets({ from: r.profileSecretBindings.secretId, to: r.secrets.id }),
    secretVersion: r.one.secretVersions({
      from: r.profileSecretBindings.secretVersionId,
      to: r.secretVersions.id,
    }),
  },

  sshKeys: {
    owner: r.one.user({ from: r.sshKeys.ownerUserId, to: r.user.id }),
    privateKeySecret: r.one.secrets({ from: r.sshKeys.privateKeySecretId, to: r.secrets.id }),
    passphraseSecret: r.one.secrets({ from: r.sshKeys.passphraseSecretId, to: r.secrets.id }),
    profileBindings: r.many.profileSshKeyBindings({
      from: r.sshKeys.id,
      to: r.profileSshKeyBindings.sshKeyId,
    }),
  },

  profileSshSettings: {
    profileRevision: r.one.profileRevisions({
      from: r.profileSshSettings.profileRevisionId,
      to: r.profileRevisions.id,
    }),
  },

  profileSshKeyBindings: {
    profileRevision: r.one.profileRevisions({
      from: r.profileSshKeyBindings.profileRevisionId,
      to: r.profileRevisions.id,
    }),
    sshKey: r.one.sshKeys({ from: r.profileSshKeyBindings.sshKeyId, to: r.sshKeys.id }),
  },

  repositoryProfiles: {
    repository: r.one.repositories({
      from: r.repositoryProfiles.repositoryId,
      to: r.repositories.id,
    }),
    revisions: r.many.repositoryProfileRevisions({
      from: r.repositoryProfiles.id,
      to: r.repositoryProfileRevisions.repositoryProfileId,
    }),
    activeRevision: r.one.repositoryProfileRevisions({
      from: r.repositoryProfiles.activeRevisionId,
      to: r.repositoryProfileRevisions.id,
    }),
  },

  repositoryProfileRevisions: {
    repositoryProfile: r.one.repositoryProfiles({
      from: r.repositoryProfileRevisions.repositoryProfileId,
      to: r.repositoryProfiles.id,
    }),
    createdByUser: r.one.user({
      from: r.repositoryProfileRevisions.createdByUserId,
      to: r.user.id,
    }),
    profileLinks: r.many.repositoryProfileProfileLinks({
      from: r.repositoryProfileRevisions.id,
      to: r.repositoryProfileProfileLinks.repositoryProfileRevisionId,
    }),
    profileRevisions: r.many.profileRevisions({
      from: r.repositoryProfileRevisions.id.through(
        r.repositoryProfileProfileLinks.repositoryProfileRevisionId,
      ),
      to: r.profileRevisions.id.through(r.repositoryProfileProfileLinks.profileRevisionId),
    }),
    activeRepositoryProfiles: r.many.repositoryProfiles({
      from: r.repositoryProfileRevisions.id,
      to: r.repositoryProfiles.activeRevisionId,
    }),
    workspaceAttempts: r.many.workspaceAttempts({
      from: r.repositoryProfileRevisions.id,
      to: r.workspaceAttempts.repositoryProfileRevisionId,
    }),
    workspaces: r.many.workspaces({
      from: r.repositoryProfileRevisions.id,
      to: r.workspaces.repositoryProfileRevisionId,
    }),
  },

  repositoryProfileProfileLinks: {
    repositoryProfileRevision: r.one.repositoryProfileRevisions({
      from: r.repositoryProfileProfileLinks.repositoryProfileRevisionId,
      to: r.repositoryProfileRevisions.id,
    }),
    profileRevision: r.one.profileRevisions({
      from: r.repositoryProfileProfileLinks.profileRevisionId,
      to: r.profileRevisions.id,
    }),
  },

  workspaceAttempts: {
    owner: r.one.user({ from: r.workspaceAttempts.ownerUserId, to: r.user.id }),
    requestedByUser: r.one.user({ from: r.workspaceAttempts.requestedByUserId, to: r.user.id }),
    repository: r.one.repositories({
      from: r.workspaceAttempts.repositoryId,
      to: r.repositories.id,
    }),
    repositoryProfileRevision: r.one.repositoryProfileRevisions({
      from: r.workspaceAttempts.repositoryProfileRevisionId,
      to: r.repositoryProfileRevisions.id,
    }),
    profileRevision: r.one.profileRevisions({
      from: r.workspaceAttempts.profileRevisionId,
      to: r.profileRevisions.id,
    }),
    retryOfRun: r.one.workspaceAttempts({
      from: r.workspaceAttempts.retryOfRunId,
      to: r.workspaceAttempts.id,
    }),
    retries: r.many.workspaceAttempts({
      from: r.workspaceAttempts.id,
      to: r.workspaceAttempts.retryOfRunId,
    }),
    snapshot: r.one.workspaceAttemptSnapshots({
      from: r.workspaceAttempts.id,
      to: r.workspaceAttemptSnapshots.runId,
    }),
    workspaceRunLink: r.one.workspaceRunLinks({
      from: r.workspaceAttempts.id,
      to: r.workspaceRunLinks.runId,
    }),
    workspacesAsLatestRun: r.many.workspaces({
      from: r.workspaceAttempts.id,
      to: r.workspaces.latestRunId,
    }),
    ociImageBuildJobs: r.many.ociImageBuildJobs({
      from: r.workspaceAttempts.id,
      to: r.ociImageBuildJobs.runId,
    }),
    runtimeInstance: r.one.workspaceRuntimeInstances({
      from: r.workspaceAttempts.id,
      to: r.workspaceRuntimeInstances.runId,
    }),
  },

  workspaces: {
    owner: r.one.user({ from: r.workspaces.ownerUserId, to: r.user.id }),
    requestedByUser: r.one.user({ from: r.workspaces.requestedByUserId, to: r.user.id }),
    repository: r.one.repositories({ from: r.workspaces.repositoryId, to: r.repositories.id }),
    repositoryProfileRevision: r.one.repositoryProfileRevisions({
      from: r.workspaces.repositoryProfileRevisionId,
      to: r.repositoryProfileRevisions.id,
    }),
    profileRevision: r.one.profileRevisions({
      from: r.workspaces.profileRevisionId,
      to: r.profileRevisions.id,
    }),
    latestRun: r.one.workspaceAttempts({
      from: r.workspaces.latestRunId,
      to: r.workspaceAttempts.id,
    }),
    runLinks: r.many.workspaceRunLinks({
      from: r.workspaces.id,
      to: r.workspaceRunLinks.workspaceId,
    }),
  },

  workspaceRunLinks: {
    workspace: r.one.workspaces({ from: r.workspaceRunLinks.workspaceId, to: r.workspaces.id }),
    run: r.one.workspaceAttempts({ from: r.workspaceRunLinks.runId, to: r.workspaceAttempts.id }),
  },

  workspaceAttemptSnapshots: {
    run: r.one.workspaceAttempts({
      from: r.workspaceAttemptSnapshots.runId,
      to: r.workspaceAttempts.id,
    }),
  },

  ociImageBuildJobs: {
    run: r.one.workspaceAttempts({ from: r.ociImageBuildJobs.runId, to: r.workspaceAttempts.id }),
  },

  workspaceRuntimeInstances: {
    run: r.one.workspaceAttempts({
      from: r.workspaceRuntimeInstances.runId,
      to: r.workspaceAttempts.id,
    }),
  },
}));
