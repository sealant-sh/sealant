import { defineRelations } from "drizzle-orm";

import * as schema from "../schema/index.js";

export const relations = defineRelations(schema, (r) => ({
  session: {
    user: r.one.user({ from: r.session.userId, to: r.user.id }),
  },
  account: {
    user: r.one.user({ from: r.account.userId, to: r.user.id }),
  },
  githubAppInstallations: {
    repositories: r.many.githubInstallationRepositories(),
    userGrants: r.many.githubInstallationUserGrants(),
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
  profiles: {
    revisions: r.many.profileRevisions(),
    activeRevision: r.one.profileRevisions({
      from: r.profiles.activeRevisionId,
      to: r.profileRevisions.id,
    }),
  },
  profileRevisions: {
    profile: r.one.profiles({ from: r.profileRevisions.profileId, to: r.profiles.id }),
    envVars: r.many.profileEnvVars(),
    secretBindings: r.many.profileSecretBindings(),
    sshSettings: r.one.profileSshSettings({
      from: r.profileRevisions.id,
      to: r.profileSshSettings.profileRevisionId,
    }),
    sshKeyBindings: r.many.profileSshKeyBindings(),
    repositoryProfileLinks: r.many.repositoryProfileProfileLinks(),
  },
  profileEnvVars: {
    profileRevision: r.one.profileRevisions({
      from: r.profileEnvVars.profileRevisionId,
      to: r.profileRevisions.id,
    }),
  },
  secretVersions: {
    secret: r.one.secrets({ from: r.secretVersions.secretId, to: r.secrets.id }),
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
    revisions: r.many.repositoryProfileRevisions(),
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
    profileLinks: r.many.repositoryProfileProfileLinks(),
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
  sandboxAttempts: {
    snapshot: r.one.sandboxAttemptSnapshots({
      from: r.sandboxAttempts.id,
      to: r.sandboxAttemptSnapshots.runId,
    }),
    sandboxRunLink: r.one.sandboxRunLinks({
      from: r.sandboxAttempts.id,
      to: r.sandboxRunLinks.runId,
    }),
    sandboxesAsLatestRun: r.many.sandboxes(),
    ociImageBuildJobs: r.many.ociImageBuildJobs(),
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
    latestRun: r.one.sandboxAttempts({ from: r.sandboxes.latestRunId, to: r.sandboxAttempts.id }),
    runLinks: r.many.sandboxRunLinks(),
    issueWorkflowExecutions: r.many.issueWorkflowExecutions(),
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
    executions: r.many.issueWorkflowExecutions(),
  },
  issueWorkflowExecutions: {
    issueWorkflow: r.one.issueWorkflows({
      from: r.issueWorkflowExecutions.issueWorkflowId,
      to: r.issueWorkflows.id,
    }),
    summary: r.one.issueWorkflowExecutionSummaries({
      from: r.issueWorkflowExecutions.id,
      to: r.issueWorkflowExecutionSummaries.executionId,
    }),
    events: r.many.issueWorkflowExecutionEvents(),
    validationResults: r.many.issueWorkflowExecutionValidationResults(),
    diffFiles: r.many.issueWorkflowExecutionDiffFiles(),
    artifacts: r.many.issueWorkflowExecutionArtifacts(),
    pullRequestLinks: r.many.issueWorkflowExecutionPullRequestLinks(),
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
  pullRequests: {
    issueWorkflowExecutionLinks: r.many.issueWorkflowExecutionPullRequestLinks(),
    issueLinks: r.many.issuePullRequestLinks(),
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
