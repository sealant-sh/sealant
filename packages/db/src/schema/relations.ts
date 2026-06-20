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
    createdRepositoryProfileRevisions: r.many.repositoryProfileRevisions({
      from: r.user.id,
      to: r.repositoryProfileRevisions.createdByUserId,
    }),
    authoredIssues: r.many.issues({ from: r.user.id, to: r.issues.authorUserId }),
    assignedIssues: r.many.issues({ from: r.user.id, to: r.issues.assigneeUserId }),
    authoredPullRequests: r.many.pullRequests({
      from: r.user.id,
      to: r.pullRequests.authorUserId,
    }),
    ownedSandboxAttempts: r.many.sandboxAttempts({
      from: r.user.id,
      to: r.sandboxAttempts.ownerUserId,
    }),
    requestedSandboxAttempts: r.many.sandboxAttempts({
      from: r.user.id,
      to: r.sandboxAttempts.requestedByUserId,
    }),
    ownedSandboxes: r.many.sandboxes({ from: r.user.id, to: r.sandboxes.ownerUserId }),
    requestedSandboxes: r.many.sandboxes({
      from: r.user.id,
      to: r.sandboxes.requestedByUserId,
    }),
    ownedIssueWorkflows: r.many.issueWorkflows({
      from: r.user.id,
      to: r.issueWorkflows.ownerUserId,
    }),
    requestedIssueWorkflows: r.many.issueWorkflows({
      from: r.user.id,
      to: r.issueWorkflows.requestedByUserId,
    }),
    requestedIssueWorkflowExecutions: r.many.issueWorkflowExecutions({
      from: r.user.id,
      to: r.issueWorkflowExecutions.requestedByUserId,
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
    issues: r.many.issues({ from: r.repositories.id, to: r.issues.repositoryId }),
    pullRequests: r.many.pullRequests({
      from: r.repositories.id,
      to: r.pullRequests.repositoryId,
    }),
    sandboxAttempts: r.many.sandboxAttempts({
      from: r.repositories.id,
      to: r.sandboxAttempts.repositoryId,
    }),
    sandboxes: r.many.sandboxes({ from: r.repositories.id, to: r.sandboxes.repositoryId }),
    issueWorkflows: r.many.issueWorkflows({
      from: r.repositories.id,
      to: r.issueWorkflows.repositoryId,
    }),
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
    sandboxAttempts: r.many.sandboxAttempts({
      from: r.profileRevisions.id,
      to: r.sandboxAttempts.profileRevisionId,
    }),
    sandboxes: r.many.sandboxes({
      from: r.profileRevisions.id,
      to: r.sandboxes.profileRevisionId,
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
    sandboxAttempts: r.many.sandboxAttempts({
      from: r.repositoryProfileRevisions.id,
      to: r.sandboxAttempts.repositoryProfileRevisionId,
    }),
    sandboxes: r.many.sandboxes({
      from: r.repositoryProfileRevisions.id,
      to: r.sandboxes.repositoryProfileRevisionId,
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

  issues: {
    repository: r.one.repositories({ from: r.issues.repositoryId, to: r.repositories.id }),
    author: r.one.user({ from: r.issues.authorUserId, to: r.user.id }),
    assignee: r.one.user({ from: r.issues.assigneeUserId, to: r.user.id }),
    workflows: r.many.issueWorkflows({ from: r.issues.id, to: r.issueWorkflows.issueId }),
    sandboxAttempts: r.many.sandboxAttempts({ from: r.issues.id, to: r.sandboxAttempts.issueId }),
    pullRequestLinks: r.many.issuePullRequestLinks({
      from: r.issues.id,
      to: r.issuePullRequestLinks.issueId,
    }),
    pullRequests: r.many.pullRequests({
      from: r.issues.id.through(r.issuePullRequestLinks.issueId),
      to: r.pullRequests.id.through(r.issuePullRequestLinks.pullRequestId),
    }),
  },

  pullRequests: {
    repository: r.one.repositories({ from: r.pullRequests.repositoryId, to: r.repositories.id }),
    author: r.one.user({ from: r.pullRequests.authorUserId, to: r.user.id }),
    issueWorkflowExecutionLinks: r.many.issueWorkflowExecutionPullRequestLinks({
      from: r.pullRequests.id,
      to: r.issueWorkflowExecutionPullRequestLinks.pullRequestId,
    }),
    issueLinks: r.many.issuePullRequestLinks({
      from: r.pullRequests.id,
      to: r.issuePullRequestLinks.pullRequestId,
    }),
    issueWorkflowExecutions: r.many.issueWorkflowExecutions({
      from: r.pullRequests.id.through(r.issueWorkflowExecutionPullRequestLinks.pullRequestId),
      to: r.issueWorkflowExecutions.id.through(
        r.issueWorkflowExecutionPullRequestLinks.executionId,
      ),
    }),
    issues: r.many.issues({
      from: r.pullRequests.id.through(r.issuePullRequestLinks.pullRequestId),
      to: r.issues.id.through(r.issuePullRequestLinks.issueId),
    }),
  },

  sandboxAttempts: {
    owner: r.one.user({ from: r.sandboxAttempts.ownerUserId, to: r.user.id }),
    requestedByUser: r.one.user({ from: r.sandboxAttempts.requestedByUserId, to: r.user.id }),
    repository: r.one.repositories({
      from: r.sandboxAttempts.repositoryId,
      to: r.repositories.id,
    }),
    repositoryProfileRevision: r.one.repositoryProfileRevisions({
      from: r.sandboxAttempts.repositoryProfileRevisionId,
      to: r.repositoryProfileRevisions.id,
    }),
    profileRevision: r.one.profileRevisions({
      from: r.sandboxAttempts.profileRevisionId,
      to: r.profileRevisions.id,
    }),
    issue: r.one.issues({ from: r.sandboxAttempts.issueId, to: r.issues.id }),
    retryOfRun: r.one.sandboxAttempts({
      from: r.sandboxAttempts.retryOfRunId,
      to: r.sandboxAttempts.id,
    }),
    retries: r.many.sandboxAttempts({
      from: r.sandboxAttempts.id,
      to: r.sandboxAttempts.retryOfRunId,
    }),
    snapshot: r.one.sandboxAttemptSnapshots({
      from: r.sandboxAttempts.id,
      to: r.sandboxAttemptSnapshots.runId,
    }),
    sandboxRunLink: r.one.sandboxRunLinks({
      from: r.sandboxAttempts.id,
      to: r.sandboxRunLinks.runId,
    }),
    sandboxesAsLatestRun: r.many.sandboxes({
      from: r.sandboxAttempts.id,
      to: r.sandboxes.latestRunId,
    }),
    ociImageBuildJobs: r.many.ociImageBuildJobs({
      from: r.sandboxAttempts.id,
      to: r.ociImageBuildJobs.runId,
    }),
    runtimeInstance: r.one.sandboxRuntimeInstances({
      from: r.sandboxAttempts.id,
      to: r.sandboxRuntimeInstances.runId,
    }),
    issueWorkflowExecution: r.one.issueWorkflowExecutions({
      from: r.sandboxAttempts.id,
      to: r.issueWorkflowExecutions.sandboxAttemptId,
    }),
  },

  sandboxes: {
    owner: r.one.user({ from: r.sandboxes.ownerUserId, to: r.user.id }),
    requestedByUser: r.one.user({ from: r.sandboxes.requestedByUserId, to: r.user.id }),
    repository: r.one.repositories({ from: r.sandboxes.repositoryId, to: r.repositories.id }),
    repositoryProfileRevision: r.one.repositoryProfileRevisions({
      from: r.sandboxes.repositoryProfileRevisionId,
      to: r.repositoryProfileRevisions.id,
    }),
    profileRevision: r.one.profileRevisions({
      from: r.sandboxes.profileRevisionId,
      to: r.profileRevisions.id,
    }),
    latestRun: r.one.sandboxAttempts({ from: r.sandboxes.latestRunId, to: r.sandboxAttempts.id }),
    runLinks: r.many.sandboxRunLinks({
      from: r.sandboxes.id,
      to: r.sandboxRunLinks.sandboxId,
    }),
    issueWorkflowExecutions: r.many.issueWorkflowExecutions({
      from: r.sandboxes.id,
      to: r.issueWorkflowExecutions.sandboxId,
    }),
  },

  sandboxRunLinks: {
    sandbox: r.one.sandboxes({ from: r.sandboxRunLinks.sandboxId, to: r.sandboxes.id }),
    run: r.one.sandboxAttempts({ from: r.sandboxRunLinks.runId, to: r.sandboxAttempts.id }),
  },

  sandboxAttemptSnapshots: {
    run: r.one.sandboxAttempts({
      from: r.sandboxAttemptSnapshots.runId,
      to: r.sandboxAttempts.id,
    }),
  },

  issueWorkflows: {
    issue: r.one.issues({ from: r.issueWorkflows.issueId, to: r.issues.id }),
    repository: r.one.repositories({
      from: r.issueWorkflows.repositoryId,
      to: r.repositories.id,
    }),
    owner: r.one.user({ from: r.issueWorkflows.ownerUserId, to: r.user.id }),
    requestedByUser: r.one.user({ from: r.issueWorkflows.requestedByUserId, to: r.user.id }),
    executions: r.many.issueWorkflowExecutions({
      from: r.issueWorkflows.id,
      to: r.issueWorkflowExecutions.issueWorkflowId,
    }),
  },

  issueWorkflowExecutions: {
    issueWorkflow: r.one.issueWorkflows({
      from: r.issueWorkflowExecutions.issueWorkflowId,
      to: r.issueWorkflows.id,
    }),
    requestedByUser: r.one.user({
      from: r.issueWorkflowExecutions.requestedByUserId,
      to: r.user.id,
    }),
    summary: r.one.issueWorkflowExecutionSummaries({
      from: r.issueWorkflowExecutions.id,
      to: r.issueWorkflowExecutionSummaries.executionId,
    }),
    events: r.many.issueWorkflowExecutionEvents({
      from: r.issueWorkflowExecutions.id,
      to: r.issueWorkflowExecutionEvents.executionId,
    }),
    validationResults: r.many.issueWorkflowExecutionValidationResults({
      from: r.issueWorkflowExecutions.id,
      to: r.issueWorkflowExecutionValidationResults.executionId,
    }),
    diffFiles: r.many.issueWorkflowExecutionDiffFiles({
      from: r.issueWorkflowExecutions.id,
      to: r.issueWorkflowExecutionDiffFiles.executionId,
    }),
    artifacts: r.many.issueWorkflowExecutionArtifacts({
      from: r.issueWorkflowExecutions.id,
      to: r.issueWorkflowExecutionArtifacts.executionId,
    }),
    pullRequestLinks: r.many.issueWorkflowExecutionPullRequestLinks({
      from: r.issueWorkflowExecutions.id,
      to: r.issueWorkflowExecutionPullRequestLinks.executionId,
    }),
    pullRequests: r.many.pullRequests({
      from: r.issueWorkflowExecutions.id.through(
        r.issueWorkflowExecutionPullRequestLinks.executionId,
      ),
      to: r.pullRequests.id.through(r.issueWorkflowExecutionPullRequestLinks.pullRequestId),
    }),
    sandbox: r.one.sandboxes({ from: r.issueWorkflowExecutions.sandboxId, to: r.sandboxes.id }),
    sandboxAttempt: r.one.sandboxAttempts({
      from: r.issueWorkflowExecutions.sandboxAttemptId,
      to: r.sandboxAttempts.id,
    }),
  },

  issueWorkflowExecutionArtifacts: {
    execution: r.one.issueWorkflowExecutions({
      from: r.issueWorkflowExecutionArtifacts.executionId,
      to: r.issueWorkflowExecutions.id,
    }),
    diffFilesAsPatchArtifact: r.many.issueWorkflowExecutionDiffFiles({
      from: r.issueWorkflowExecutionArtifacts.id,
      to: r.issueWorkflowExecutionDiffFiles.patchArtifactId,
    }),
  },

  issueWorkflowExecutionEvents: {
    execution: r.one.issueWorkflowExecutions({
      from: r.issueWorkflowExecutionEvents.executionId,
      to: r.issueWorkflowExecutions.id,
    }),
  },

  issueWorkflowExecutionValidationResults: {
    execution: r.one.issueWorkflowExecutions({
      from: r.issueWorkflowExecutionValidationResults.executionId,
      to: r.issueWorkflowExecutions.id,
    }),
  },

  issueWorkflowExecutionDiffFiles: {
    execution: r.one.issueWorkflowExecutions({
      from: r.issueWorkflowExecutionDiffFiles.executionId,
      to: r.issueWorkflowExecutions.id,
    }),
    patchArtifact: r.one.issueWorkflowExecutionArtifacts({
      from: r.issueWorkflowExecutionDiffFiles.patchArtifactId,
      to: r.issueWorkflowExecutionArtifacts.id,
    }),
  },

  issueWorkflowExecutionSummaries: {
    execution: r.one.issueWorkflowExecutions({
      from: r.issueWorkflowExecutionSummaries.executionId,
      to: r.issueWorkflowExecutions.id,
    }),
  },

  issueWorkflowExecutionPullRequestLinks: {
    execution: r.one.issueWorkflowExecutions({
      from: r.issueWorkflowExecutionPullRequestLinks.executionId,
      to: r.issueWorkflowExecutions.id,
    }),
    pullRequest: r.one.pullRequests({
      from: r.issueWorkflowExecutionPullRequestLinks.pullRequestId,
      to: r.pullRequests.id,
    }),
  },

  issuePullRequestLinks: {
    issue: r.one.issues({ from: r.issuePullRequestLinks.issueId, to: r.issues.id }),
    pullRequest: r.one.pullRequests({
      from: r.issuePullRequestLinks.pullRequestId,
      to: r.pullRequests.id,
    }),
  },

  ociImageBuildJobs: {
    run: r.one.sandboxAttempts({ from: r.ociImageBuildJobs.runId, to: r.sandboxAttempts.id }),
  },

  sandboxRuntimeInstances: {
    run: r.one.sandboxAttempts({
      from: r.sandboxRuntimeInstances.runId,
      to: r.sandboxAttempts.id,
    }),
  },
}));
