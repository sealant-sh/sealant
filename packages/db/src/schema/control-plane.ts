import type { UserWorkspaceSpec, WorkspaceBlueprint } from "@sealant/workspace-composition";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

import { user } from "./auth.js";

export const sourceProviderValues = ["github", "gitlab", "generic"] as const;
export type SourceProvider = (typeof sourceProviderValues)[number];

export const profileStatusValues = ["active", "archived"] as const;
export type ProfileStatus = (typeof profileStatusValues)[number];

export const issueStateValues = ["open", "closed"] as const;
export type IssueState = (typeof issueStateValues)[number];

export const pullRequestStateValues = ["draft", "open", "merged", "closed"] as const;
export type PullRequestState = (typeof pullRequestStateValues)[number];

export const sandboxAttemptStatusValues = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
] as const;
export type SandboxAttemptStatus = (typeof sandboxAttemptStatusValues)[number];

export const sandboxAttemptTriggerTypeValues = [
  "manual",
  "issue",
  "schedule",
  "api",
  "retry",
] as const;
export type SandboxAttemptTriggerType = (typeof sandboxAttemptTriggerTypeValues)[number];

export const sandboxStatusValues = ["queued", "running", "ready", "failed", "stopped"] as const;
export type SandboxStatus = (typeof sandboxStatusValues)[number];

export const sandboxRunLinkRelationValues = ["launch", "rebuild", "retry", "resume"] as const;
export type SandboxRunLinkRelation = (typeof sandboxRunLinkRelationValues)[number];

export const profileSshKeyPurposeValues = ["login", "git-auth", "git-signing"] as const;
export type ProfileSshKeyPurpose = (typeof profileSshKeyPurposeValues)[number];

export const issueWorkflowStatusValues = ["active", "completed", "failed", "cancelled"] as const;
export type IssueWorkflowStatus = (typeof issueWorkflowStatusValues)[number];

export const issueWorkflowExecutionStatusValues = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
] as const;
export type IssueWorkflowExecutionStatus = (typeof issueWorkflowExecutionStatusValues)[number];

export const issueWorkflowExecutionTriggerTypeValues = ["manual", "api", "retry"] as const;
export type IssueWorkflowExecutionTriggerType =
  (typeof issueWorkflowExecutionTriggerTypeValues)[number];

export const issueWorkflowExecutionEventLevelValues = ["debug", "info", "warn", "error"] as const;
export type IssueWorkflowExecutionEventLevel =
  (typeof issueWorkflowExecutionEventLevelValues)[number];

export const issueWorkflowExecutionValidationStatusValues = [
  "pass",
  "warn",
  "fail",
  "skip",
] as const;
export type IssueWorkflowExecutionValidationStatus =
  (typeof issueWorkflowExecutionValidationStatusValues)[number];

export const issueWorkflowExecutionDiffChangeTypeValues = [
  "added",
  "modified",
  "deleted",
  "renamed",
] as const;
export type IssueWorkflowExecutionDiffChangeType =
  (typeof issueWorkflowExecutionDiffChangeTypeValues)[number];

export const issueWorkflowExecutionArtifactKindValues = [
  "log",
  "trace",
  "diff",
  "summary",
  "validation-report",
  "compiled-spec",
  "other",
] as const;
export type IssueWorkflowExecutionArtifactKind =
  (typeof issueWorkflowExecutionArtifactKindValues)[number];

export const issueWorkflowExecutionArtifactStorageBackendValues = [
  "inline",
  "database",
  "s3",
  "gcs",
  "azure-blob",
  "filesystem",
] as const;
export type IssueWorkflowExecutionArtifactStorageBackend =
  (typeof issueWorkflowExecutionArtifactStorageBackendValues)[number];

export const issueWorkflowExecutionPullRequestLinkRelationValues = [
  "created",
  "updated",
  "referenced",
] as const;
export type IssueWorkflowExecutionPullRequestLinkRelation =
  (typeof issueWorkflowExecutionPullRequestLinkRelationValues)[number];

export const issuePullRequestLinkRelationValues = ["fixes", "relates_to"] as const;
export type IssuePullRequestLinkRelation = (typeof issuePullRequestLinkRelationValues)[number];

export const repositories = sqliteTable(
  "repositories",
  {
    id: text().primaryKey(),
    provider: text({ enum: sourceProviderValues }).notNull().default("generic"),
    externalId: text("external_id"),
    owner: text().notNull(),
    name: text().notNull(),
    defaultBranch: text("default_branch").notNull().default("main"),
    url: text(),
    isArchived: integer("is_archived", { mode: "boolean" }).notNull().default(false),
    lastSyncedAt: integer("last_synced_at", { mode: "timestamp_ms" }),
    createdAt: integer({ mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer({ mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date())
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("repositories_provider_owner_name_idx").on(table.provider, table.owner, table.name),
    uniqueIndex("repositories_provider_external_id_idx").on(table.provider, table.externalId),
    index("repositories_owner_name_idx").on(table.owner, table.name),
    index("repositories_last_synced_at_idx").on(table.lastSyncedAt),
  ],
);

export const profiles = sqliteTable(
  "profiles",
  {
    id: text().primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    slug: text().notNull(),
    name: text().notNull(),
    description: text(),
    status: text({ enum: profileStatusValues }).notNull().default("active"),
    activeRevisionId: text("active_revision_id"),
    createdAt: integer({ mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer({ mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date())
      .$onUpdate(() => new Date()),
    archivedAt: integer("archived_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    uniqueIndex("profiles_owner_user_id_slug_idx").on(table.ownerUserId, table.slug),
    index("profiles_owner_user_id_status_idx").on(table.ownerUserId, table.status),
    index("profiles_active_revision_id_idx").on(table.activeRevisionId),
  ],
);

export const profileRevisions = sqliteTable(
  "profile_revisions",
  {
    id: text().primaryKey(),
    profileId: text("profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    version: integer({ mode: "number" }).notNull(),
    createdByUserId: text("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
    changeSummary: text("change_summary"),
    fingerprint: text().notNull(),
    configPatch: text("config_patch", { mode: "json" })
      .$type<Partial<UserWorkspaceSpec>>()
      .notNull(),
    createdAt: integer({ mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex("profile_revisions_profile_id_version_idx").on(table.profileId, table.version),
    uniqueIndex("profile_revisions_profile_id_fingerprint_idx").on(
      table.profileId,
      table.fingerprint,
    ),
    index("profile_revisions_created_by_user_id_idx").on(table.createdByUserId),
    index("profile_revisions_created_at_idx").on(table.createdAt),
  ],
);

export const profileEnvVars = sqliteTable(
  "profile_env_vars",
  {
    id: text().primaryKey(),
    profileRevisionId: text("profile_revision_id")
      .notNull()
      .references(() => profileRevisions.id, { onDelete: "cascade" }),
    key: text().notNull(),
    value: text().notNull(),
    createdAt: integer({ mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex("profile_env_vars_profile_revision_id_key_idx").on(
      table.profileRevisionId,
      table.key,
    ),
    index("profile_env_vars_profile_revision_id_idx").on(table.profileRevisionId),
  ],
);

export const secrets = sqliteTable(
  "secrets",
  {
    id: text().primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text().notNull(),
    description: text(),
    createdAt: integer({ mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer({ mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date())
      .$onUpdate(() => new Date()),
    archivedAt: integer("archived_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    uniqueIndex("secrets_owner_user_id_name_idx").on(table.ownerUserId, table.name),
    index("secrets_owner_user_id_idx").on(table.ownerUserId),
  ],
);

export const secretVersions = sqliteTable(
  "secret_versions",
  {
    id: text().primaryKey(),
    secretId: text("secret_id")
      .notNull()
      .references(() => secrets.id, { onDelete: "cascade" }),
    version: integer({ mode: "number" }).notNull(),
    encryptedValue: text("encrypted_value").notNull(),
    encryptionKeyId: text("encryption_key_id"),
    valueSha256: text("value_sha256").notNull(),
    createdByUserId: text("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
    createdAt: integer({ mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex("secret_versions_secret_id_version_idx").on(table.secretId, table.version),
    index("secret_versions_created_by_user_id_idx").on(table.createdByUserId),
    index("secret_versions_secret_id_created_at_idx").on(table.secretId, table.createdAt),
  ],
);

export const profileSecretBindings = sqliteTable(
  "profile_secret_bindings",
  {
    id: text().primaryKey(),
    profileRevisionId: text("profile_revision_id")
      .notNull()
      .references(() => profileRevisions.id, { onDelete: "cascade" }),
    targetKey: text("target_key").notNull(),
    secretId: text("secret_id")
      .notNull()
      .references(() => secrets.id),
    secretVersionId: text("secret_version_id").references(() => secretVersions.id),
    isRequired: integer("is_required", { mode: "boolean" }).notNull().default(true),
    createdAt: integer({ mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex("profile_secret_bindings_profile_revision_id_target_key_idx").on(
      table.profileRevisionId,
      table.targetKey,
    ),
    index("profile_secret_bindings_secret_id_idx").on(table.secretId),
    index("profile_secret_bindings_profile_revision_id_idx").on(table.profileRevisionId),
  ],
);

export const sshKeys = sqliteTable(
  "ssh_keys",
  {
    id: text().primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text().notNull(),
    publicKey: text("public_key").notNull(),
    privateKeySecretId: text("private_key_secret_id").references(() => secrets.id),
    passphraseSecretId: text("passphrase_secret_id").references(() => secrets.id),
    fingerprint: text().notNull(),
    createdAt: integer({ mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer({ mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date())
      .$onUpdate(() => new Date()),
    archivedAt: integer("archived_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    uniqueIndex("ssh_keys_owner_user_id_fingerprint_idx").on(table.ownerUserId, table.fingerprint),
    index("ssh_keys_owner_user_id_name_idx").on(table.ownerUserId, table.name),
  ],
);

export const profileSshSettings = sqliteTable(
  "profile_ssh_settings",
  {
    profileRevisionId: text("profile_revision_id")
      .primaryKey()
      .references(() => profileRevisions.id, { onDelete: "cascade" }),
    enabled: integer({ mode: "boolean" }).notNull().default(false),
    listenPort: integer("listen_port", { mode: "number" }).notNull().default(2222),
    hostAllowlist: text("host_allowlist", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .$defaultFn(() => []),
    sessionTimeoutMinutes: integer("session_timeout_minutes", { mode: "number" }),
    authorizedKeysRef: text("authorized_keys_ref"),
    createdAt: integer({ mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer({ mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date())
      .$onUpdate(() => new Date()),
  },
  (table) => [index("profile_ssh_settings_enabled_idx").on(table.enabled)],
);

export const profileSshKeyBindings = sqliteTable(
  "profile_ssh_key_bindings",
  {
    profileRevisionId: text("profile_revision_id")
      .notNull()
      .references(() => profileRevisions.id, { onDelete: "cascade" }),
    sshKeyId: text("ssh_key_id")
      .notNull()
      .references(() => sshKeys.id),
    purpose: text({ enum: profileSshKeyPurposeValues }).notNull().default("login"),
    createdAt: integer({ mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    primaryKey({
      columns: [table.profileRevisionId, table.sshKeyId, table.purpose],
    }),
    index("profile_ssh_key_bindings_ssh_key_id_idx").on(table.sshKeyId),
  ],
);

export const repositoryProfiles = sqliteTable(
  "repository_profiles",
  {
    id: text().primaryKey(),
    repositoryId: text("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    name: text().notNull(),
    description: text(),
    status: text({ enum: profileStatusValues }).notNull().default("active"),
    activeRevisionId: text("active_revision_id"),
    createdAt: integer({ mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer({ mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date())
      .$onUpdate(() => new Date()),
    archivedAt: integer("archived_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    uniqueIndex("repository_profiles_repository_id_name_idx").on(table.repositoryId, table.name),
    index("repository_profiles_repository_id_status_idx").on(table.repositoryId, table.status),
    index("repository_profiles_active_revision_id_idx").on(table.activeRevisionId),
  ],
);

export const repositoryProfileRevisions = sqliteTable(
  "repository_profile_revisions",
  {
    id: text().primaryKey(),
    repositoryProfileId: text("repository_profile_id")
      .notNull()
      .references(() => repositoryProfiles.id, { onDelete: "cascade" }),
    version: integer({ mode: "number" }).notNull(),
    createdByUserId: text("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
    changeSummary: text("change_summary"),
    fingerprint: text().notNull(),
    runTemplate: text("run_template", { mode: "json" })
      .$type<Partial<UserWorkspaceSpec>>()
      .notNull(),
    policyConfig: text("policy_config", { mode: "json" }).$type<Record<string, unknown>>(),
    createdAt: integer({ mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex("repository_profile_revisions_repository_profile_id_version_idx").on(
      table.repositoryProfileId,
      table.version,
    ),
    uniqueIndex("repository_profile_revisions_repository_profile_id_fingerprint_idx").on(
      table.repositoryProfileId,
      table.fingerprint,
    ),
    index("repository_profile_revisions_created_at_idx").on(table.createdAt),
  ],
);

export const repositoryProfileProfileLinks = sqliteTable(
  "repository_profile_profile_links",
  {
    id: text().primaryKey(),
    repositoryProfileRevisionId: text("repository_profile_revision_id")
      .notNull()
      .references(() => repositoryProfileRevisions.id, { onDelete: "cascade" }),
    profileRevisionId: text("profile_revision_id")
      .notNull()
      .references(() => profileRevisions.id),
    precedence: integer({ mode: "number" }).notNull().default(0),
    isRequired: integer("is_required", { mode: "boolean" }).notNull().default(true),
    createdAt: integer({ mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex(
      "repository_profile_profile_links_repository_profile_revision_id_profile_revision_id_idx",
    ).on(table.repositoryProfileRevisionId, table.profileRevisionId),
    index("repository_profile_profile_links_profile_revision_id_idx").on(table.profileRevisionId),
  ],
);

export const issues = sqliteTable(
  "issues",
  {
    id: text().primaryKey(),
    repositoryId: text("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    provider: text({ enum: sourceProviderValues }).notNull().default("github"),
    externalId: text("external_id"),
    number: integer({ mode: "number" }).notNull(),
    title: text().notNull(),
    state: text({ enum: issueStateValues }).notNull().default("open"),
    url: text(),
    authorUserId: text("author_user_id").references(() => user.id, { onDelete: "set null" }),
    assigneeUserId: text("assignee_user_id").references(() => user.id, { onDelete: "set null" }),
    openedAt: integer("opened_at", { mode: "timestamp_ms" }),
    closedAt: integer("closed_at", { mode: "timestamp_ms" }),
    syncedAt: integer("synced_at", { mode: "timestamp_ms" }),
    createdAt: integer({ mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer({ mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date())
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("issues_provider_repository_id_number_idx").on(
      table.provider,
      table.repositoryId,
      table.number,
    ),
    uniqueIndex("issues_provider_external_id_idx").on(table.provider, table.externalId),
    index("issues_repository_id_state_idx").on(table.repositoryId, table.state),
    index("issues_assignee_user_id_state_idx").on(table.assigneeUserId, table.state),
  ],
);

export const pullRequests = sqliteTable(
  "pull_requests",
  {
    id: text().primaryKey(),
    repositoryId: text("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    provider: text({ enum: sourceProviderValues }).notNull().default("github"),
    externalId: text("external_id"),
    number: integer({ mode: "number" }).notNull(),
    title: text().notNull(),
    state: text({ enum: pullRequestStateValues }).notNull().default("draft"),
    headBranch: text("head_branch").notNull(),
    baseBranch: text("base_branch").notNull(),
    headSha: text("head_sha"),
    url: text(),
    authorUserId: text("author_user_id").references(() => user.id, { onDelete: "set null" }),
    openedAt: integer("opened_at", { mode: "timestamp_ms" }),
    mergedAt: integer("merged_at", { mode: "timestamp_ms" }),
    closedAt: integer("closed_at", { mode: "timestamp_ms" }),
    syncedAt: integer("synced_at", { mode: "timestamp_ms" }),
    createdAt: integer({ mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer({ mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date())
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("pull_requests_provider_repository_id_number_idx").on(
      table.provider,
      table.repositoryId,
      table.number,
    ),
    uniqueIndex("pull_requests_provider_external_id_idx").on(table.provider, table.externalId),
    index("pull_requests_repository_id_state_idx").on(table.repositoryId, table.state),
    index("pull_requests_head_sha_idx").on(table.headSha),
  ],
);

export const sandboxAttempts = sqliteTable(
  "sandbox_attempts",
  {
    id: text().primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    repositoryId: text("repository_id").references(() => repositories.id, { onDelete: "set null" }),
    repositoryProfileRevisionId: text("repository_profile_revision_id").references(
      () => repositoryProfileRevisions.id,
      { onDelete: "set null" },
    ),
    profileRevisionId: text("profile_revision_id").references(() => profileRevisions.id, {
      onDelete: "set null",
    }),
    issueId: text("issue_id").references(() => issues.id, { onDelete: "set null" }),
    status: text({ enum: sandboxAttemptStatusValues }).notNull().default("queued"),
    triggerType: text("trigger_type", { enum: sandboxAttemptTriggerTypeValues })
      .notNull()
      .default("manual"),
    triggerRef: text("trigger_ref"),
    requestedByUserId: text("requested_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    retryOfRunId: text("retry_of_run_id"),
    cancelReason: text("cancel_reason"),
    queuedAt: integer("queued_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
    durationMs: integer("duration_ms", { mode: "number" }),
    createdAt: integer({ mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer({ mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date())
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("sandbox_attempts_owner_user_id_status_created_at_idx").on(
      table.ownerUserId,
      table.status,
      table.createdAt,
    ),
    index("sandbox_attempts_repository_id_created_at_idx").on(table.repositoryId, table.createdAt),
    index("sandbox_attempts_profile_revision_id_created_at_idx").on(
      table.profileRevisionId,
      table.createdAt,
    ),
    index("sandbox_attempts_repository_profile_revision_id_created_at_idx").on(
      table.repositoryProfileRevisionId,
      table.createdAt,
    ),
    index("sandbox_attempts_issue_id_created_at_idx").on(table.issueId, table.createdAt),
    index("sandbox_attempts_status_started_at_idx").on(table.status, table.startedAt),
  ],
);

export const sandboxes = sqliteTable(
  "sandboxes",
  {
    id: text().primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    repositoryId: text("repository_id").references(() => repositories.id, { onDelete: "set null" }),
    repositoryProfileRevisionId: text("repository_profile_revision_id").references(
      () => repositoryProfileRevisions.id,
      { onDelete: "set null" },
    ),
    profileRevisionId: text("profile_revision_id").references(() => profileRevisions.id, {
      onDelete: "set null",
    }),
    requestedByUserId: text("requested_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    status: text({ enum: sandboxStatusValues }).notNull().default("queued"),
    latestRunId: text("latest_run_id").references(() => sandboxAttempts.id, {
      onDelete: "set null",
    }),
    createdAt: integer({ mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer({ mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date())
      .$onUpdate(() => new Date()),
    archivedAt: integer("archived_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    index("sandboxes_owner_user_id_status_created_at_idx").on(
      table.ownerUserId,
      table.status,
      table.createdAt,
    ),
    index("sandboxes_repository_id_created_at_idx").on(table.repositoryId, table.createdAt),
    uniqueIndex("sandboxes_latest_run_id_idx").on(table.latestRunId),
  ],
);

export const sandboxRunLinks = sqliteTable(
  "sandbox_run_links",
  {
    sandboxId: text("sandbox_id")
      .notNull()
      .references(() => sandboxes.id, { onDelete: "cascade" }),
    runId: text("run_id")
      .notNull()
      .references(() => sandboxAttempts.id, { onDelete: "cascade" }),
    relation: text({ enum: sandboxRunLinkRelationValues }).notNull().default("launch"),
    linkedAt: integer("linked_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    primaryKey({ columns: [table.sandboxId, table.runId] }),
    uniqueIndex("sandbox_run_links_run_id_idx").on(table.runId),
    index("sandbox_run_links_sandbox_id_linked_at_idx").on(table.sandboxId, table.linkedAt),
  ],
);

export const sandboxAttemptSnapshots = sqliteTable("sandbox_attempt_snapshots", {
  runId: text("run_id")
    .primaryKey()
    .references(() => sandboxAttempts.id, { onDelete: "cascade" }),
  userSpecPayload: text("user_spec_payload", { mode: "json" }).$type<UserWorkspaceSpec>().notNull(),
  resolvedSpecPayload: text("resolved_spec_payload", { mode: "json" })
    .$type<UserWorkspaceSpec>()
    .notNull(),
  blueprintPayload: text("blueprint_payload", { mode: "json" })
    .$type<WorkspaceBlueprint>()
    .notNull(),
  profileConfigSnapshot: text("profile_config_snapshot", { mode: "json" }).$type<
    Record<string, unknown>
  >(),
  repositoryProfileConfigSnapshot: text("repository_profile_config_snapshot", {
    mode: "json",
  }).$type<Record<string, unknown>>(),
  createdAt: integer({ mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const packageResolutionCacheEntries = sqliteTable(
  "package_resolution_cache_entries",
  {
    query: text().primaryKey(),
    resolutionPayload: text("resolution_payload", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull(),
    fetchedAt: integer("fetched_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    hitCount: integer("hit_count", { mode: "number" }).notNull().default(0),
  },
  (table) => [
    index("package_resolution_cache_entries_expires_at_idx").on(table.expiresAt),
    index("package_resolution_cache_entries_last_used_at_idx").on(table.lastUsedAt),
  ],
);

export const issueWorkflows = sqliteTable(
  "issue_workflows",
  {
    id: text().primaryKey(),
    issueId: text("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    repositoryId: text("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    ownerUserId: text("owner_user_id").references(() => user.id, { onDelete: "set null" }),
    status: text({ enum: issueWorkflowStatusValues }).notNull().default("active"),
    requestedByUserId: text("requested_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: integer({ mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer({ mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date())
      .$onUpdate(() => new Date()),
    archivedAt: integer("archived_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    index("issue_workflows_issue_id_status_idx").on(table.issueId, table.status),
    index("issue_workflows_repository_id_status_idx").on(table.repositoryId, table.status),
    index("issue_workflows_owner_user_id_status_idx").on(table.ownerUserId, table.status),
  ],
);

export const issueWorkflowExecutions = sqliteTable(
  "issue_workflow_executions",
  {
    id: text().primaryKey(),
    issueWorkflowId: text("issue_workflow_id")
      .notNull()
      .references(() => issueWorkflows.id, { onDelete: "cascade" }),
    sandboxId: text("sandbox_id").references(() => sandboxes.id, { onDelete: "set null" }),
    sandboxAttemptId: text("sandbox_attempt_id").references(() => sandboxAttempts.id, {
      onDelete: "set null",
    }),
    status: text({ enum: issueWorkflowExecutionStatusValues }).notNull().default("queued"),
    triggerType: text("trigger_type", { enum: issueWorkflowExecutionTriggerTypeValues })
      .notNull()
      .default("manual"),
    requestedByUserId: text("requested_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    cancelReason: text("cancel_reason"),
    queuedAt: integer("queued_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
    durationMs: integer("duration_ms", { mode: "number" }),
    createdAt: integer({ mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer({ mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date())
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("issue_workflow_executions_workflow_id_created_at_idx").on(
      table.issueWorkflowId,
      table.createdAt,
    ),
    index("issue_workflow_executions_status_started_at_idx").on(table.status, table.startedAt),
    index("issue_workflow_executions_sandbox_id_created_at_idx").on(
      table.sandboxId,
      table.createdAt,
    ),
    uniqueIndex("issue_workflow_executions_sandbox_attempt_id_idx").on(table.sandboxAttemptId),
  ],
);

export const issueWorkflowExecutionArtifacts = sqliteTable(
  "issue_workflow_execution_artifacts",
  {
    id: text().primaryKey(),
    executionId: text("execution_id")
      .notNull()
      .references(() => issueWorkflowExecutions.id, { onDelete: "cascade" }),
    kind: text({ enum: issueWorkflowExecutionArtifactKindValues }).notNull().default("other"),
    storageBackend: text("storage_backend", {
      enum: issueWorkflowExecutionArtifactStorageBackendValues,
    })
      .notNull()
      .default("inline"),
    storageKey: text("storage_key"),
    contentType: text("content_type"),
    byteSize: integer("byte_size", { mode: "number" }),
    checksum: text(),
    inlineJson: text("inline_json", { mode: "json" }).$type<Record<string, unknown>>(),
    createdAt: integer({ mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index("issue_workflow_execution_artifacts_execution_id_kind_idx").on(
      table.executionId,
      table.kind,
    ),
    index("issue_workflow_execution_artifacts_storage_backend_storage_key_idx").on(
      table.storageBackend,
      table.storageKey,
    ),
  ],
);

export const issueWorkflowExecutionEvents = sqliteTable(
  "issue_workflow_execution_events",
  {
    id: text().primaryKey(),
    executionId: text("execution_id")
      .notNull()
      .references(() => issueWorkflowExecutions.id, { onDelete: "cascade" }),
    sequence: integer({ mode: "number" }).notNull(),
    phase: text().notNull(),
    level: text({ enum: issueWorkflowExecutionEventLevelValues }).notNull().default("info"),
    eventType: text("event_type").notNull(),
    message: text().notNull(),
    payload: text({ mode: "json" }).$type<Record<string, unknown>>(),
    occurredAt: integer("occurred_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex("issue_workflow_execution_events_execution_id_sequence_idx").on(
      table.executionId,
      table.sequence,
    ),
    index("issue_workflow_execution_events_execution_id_occurred_at_idx").on(
      table.executionId,
      table.occurredAt,
    ),
    index("issue_workflow_execution_events_execution_id_level_idx").on(
      table.executionId,
      table.level,
    ),
  ],
);

export const issueWorkflowExecutionValidationResults = sqliteTable(
  "issue_workflow_execution_validation_results",
  {
    id: text().primaryKey(),
    executionId: text("execution_id")
      .notNull()
      .references(() => issueWorkflowExecutions.id, { onDelete: "cascade" }),
    checkKey: text("check_key").notNull(),
    status: text({ enum: issueWorkflowExecutionValidationStatusValues }).notNull(),
    durationMs: integer("duration_ms", { mode: "number" }),
    message: text(),
    details: text({ mode: "json" }).$type<Record<string, unknown>>(),
    createdAt: integer({ mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex("issue_workflow_execution_validation_results_execution_id_check_key_idx").on(
      table.executionId,
      table.checkKey,
    ),
    index("issue_workflow_execution_validation_results_execution_id_status_idx").on(
      table.executionId,
      table.status,
    ),
  ],
);

export const issueWorkflowExecutionDiffFiles = sqliteTable(
  "issue_workflow_execution_diff_files",
  {
    id: text().primaryKey(),
    executionId: text("execution_id")
      .notNull()
      .references(() => issueWorkflowExecutions.id, { onDelete: "cascade" }),
    changeType: text("change_type", { enum: issueWorkflowExecutionDiffChangeTypeValues }).notNull(),
    path: text().notNull(),
    oldPath: text("old_path"),
    additions: integer({ mode: "number" }).notNull().default(0),
    deletions: integer({ mode: "number" }).notNull().default(0),
    isBinary: integer("is_binary", { mode: "boolean" }).notNull().default(false),
    patchArtifactId: text("patch_artifact_id").references(
      () => issueWorkflowExecutionArtifacts.id,
      {
        onDelete: "set null",
      },
    ),
    createdAt: integer({ mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index("issue_workflow_execution_diff_files_execution_id_path_idx").on(
      table.executionId,
      table.path,
    ),
    index("issue_workflow_execution_diff_files_execution_id_change_type_idx").on(
      table.executionId,
      table.changeType,
    ),
  ],
);

export const issueWorkflowExecutionSummaries = sqliteTable("issue_workflow_execution_summaries", {
  executionId: text("execution_id")
    .primaryKey()
    .references(() => issueWorkflowExecutions.id, { onDelete: "cascade" }),
  objective: text(),
  linkedIssueRef: text("linked_issue_ref"),
  filesChanged: integer("files_changed", { mode: "number" }).notNull().default(0),
  additions: integer({ mode: "number" }).notNull().default(0),
  deletions: integer({ mode: "number" }).notNull().default(0),
  assumptions: text({ mode: "json" })
    .$type<string[]>()
    .notNull()
    .$defaultFn(() => []),
  warnings: text({ mode: "json" })
    .$type<string[]>()
    .notNull()
    .$defaultFn(() => []),
  summaryMarkdown: text("summary_markdown"),
  generatedAt: integer("generated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer({ mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date())
    .$onUpdate(() => new Date()),
});

export const issueWorkflowExecutionPullRequestLinks = sqliteTable(
  "issue_workflow_execution_pull_request_links",
  {
    executionId: text("execution_id")
      .notNull()
      .references(() => issueWorkflowExecutions.id, { onDelete: "cascade" }),
    pullRequestId: text("pull_request_id")
      .notNull()
      .references(() => pullRequests.id, { onDelete: "cascade" }),
    relation: text({ enum: issueWorkflowExecutionPullRequestLinkRelationValues })
      .notNull()
      .default("created"),
    linkedAt: integer("linked_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    primaryKey({ columns: [table.executionId, table.pullRequestId] }),
    index("issue_workflow_execution_pull_request_links_pull_request_id_relation_idx").on(
      table.pullRequestId,
      table.relation,
    ),
  ],
);

export const issuePullRequestLinks = sqliteTable(
  "issue_pull_request_links",
  {
    issueId: text("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    pullRequestId: text("pull_request_id")
      .notNull()
      .references(() => pullRequests.id, { onDelete: "cascade" }),
    relation: text({ enum: issuePullRequestLinkRelationValues }).notNull().default("fixes"),
    linkedAt: integer("linked_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    primaryKey({ columns: [table.issueId, table.pullRequestId] }),
    index("issue_pull_request_links_pull_request_id_relation_idx").on(
      table.pullRequestId,
      table.relation,
    ),
  ],
);

export type Repository = typeof repositories.$inferSelect;
export type NewRepository = typeof repositories.$inferInsert;

export type Profile = typeof profiles.$inferSelect;
export type NewProfile = typeof profiles.$inferInsert;

export type ProfileRevision = typeof profileRevisions.$inferSelect;
export type NewProfileRevision = typeof profileRevisions.$inferInsert;

export type ProfileEnvVar = typeof profileEnvVars.$inferSelect;
export type NewProfileEnvVar = typeof profileEnvVars.$inferInsert;

export type Secret = typeof secrets.$inferSelect;
export type NewSecret = typeof secrets.$inferInsert;

export type SecretVersion = typeof secretVersions.$inferSelect;
export type NewSecretVersion = typeof secretVersions.$inferInsert;

export type ProfileSecretBinding = typeof profileSecretBindings.$inferSelect;
export type NewProfileSecretBinding = typeof profileSecretBindings.$inferInsert;

export type SshKey = typeof sshKeys.$inferSelect;
export type NewSshKey = typeof sshKeys.$inferInsert;

export type ProfileSshSetting = typeof profileSshSettings.$inferSelect;
export type NewProfileSshSetting = typeof profileSshSettings.$inferInsert;

export type ProfileSshKeyBinding = typeof profileSshKeyBindings.$inferSelect;
export type NewProfileSshKeyBinding = typeof profileSshKeyBindings.$inferInsert;

export type RepositoryProfile = typeof repositoryProfiles.$inferSelect;
export type NewRepositoryProfile = typeof repositoryProfiles.$inferInsert;

export type RepositoryProfileRevision = typeof repositoryProfileRevisions.$inferSelect;
export type NewRepositoryProfileRevision = typeof repositoryProfileRevisions.$inferInsert;

export type RepositoryProfileProfileLink = typeof repositoryProfileProfileLinks.$inferSelect;
export type NewRepositoryProfileProfileLink = typeof repositoryProfileProfileLinks.$inferInsert;

export type Issue = typeof issues.$inferSelect;
export type NewIssue = typeof issues.$inferInsert;

export type PullRequest = typeof pullRequests.$inferSelect;
export type NewPullRequest = typeof pullRequests.$inferInsert;

export type SandboxAttempt = typeof sandboxAttempts.$inferSelect;
export type NewSandboxAttempt = typeof sandboxAttempts.$inferInsert;

export type Sandbox = typeof sandboxes.$inferSelect;
export type NewSandbox = typeof sandboxes.$inferInsert;

export type SandboxRunLink = typeof sandboxRunLinks.$inferSelect;
export type NewSandboxRunLink = typeof sandboxRunLinks.$inferInsert;

export type SandboxAttemptSnapshot = typeof sandboxAttemptSnapshots.$inferSelect;
export type NewSandboxAttemptSnapshot = typeof sandboxAttemptSnapshots.$inferInsert;

export type PackageResolutionCacheEntry = typeof packageResolutionCacheEntries.$inferSelect;
export type NewPackageResolutionCacheEntry = typeof packageResolutionCacheEntries.$inferInsert;

export type IssueWorkflow = typeof issueWorkflows.$inferSelect;
export type NewIssueWorkflow = typeof issueWorkflows.$inferInsert;

export type IssueWorkflowExecution = typeof issueWorkflowExecutions.$inferSelect;
export type NewIssueWorkflowExecution = typeof issueWorkflowExecutions.$inferInsert;

export type IssueWorkflowExecutionArtifact = typeof issueWorkflowExecutionArtifacts.$inferSelect;
export type NewIssueWorkflowExecutionArtifact = typeof issueWorkflowExecutionArtifacts.$inferInsert;

export type IssueWorkflowExecutionEvent = typeof issueWorkflowExecutionEvents.$inferSelect;
export type NewIssueWorkflowExecutionEvent = typeof issueWorkflowExecutionEvents.$inferInsert;

export type IssueWorkflowExecutionValidationResult =
  typeof issueWorkflowExecutionValidationResults.$inferSelect;
export type NewIssueWorkflowExecutionValidationResult =
  typeof issueWorkflowExecutionValidationResults.$inferInsert;

export type IssueWorkflowExecutionDiffFile = typeof issueWorkflowExecutionDiffFiles.$inferSelect;
export type NewIssueWorkflowExecutionDiffFile = typeof issueWorkflowExecutionDiffFiles.$inferInsert;

export type IssueWorkflowExecutionSummary = typeof issueWorkflowExecutionSummaries.$inferSelect;
export type NewIssueWorkflowExecutionSummary = typeof issueWorkflowExecutionSummaries.$inferInsert;

export type IssueWorkflowExecutionPullRequestLink =
  typeof issueWorkflowExecutionPullRequestLinks.$inferSelect;
export type NewIssueWorkflowExecutionPullRequestLink =
  typeof issueWorkflowExecutionPullRequestLinks.$inferInsert;

export type IssuePullRequestLink = typeof issuePullRequestLinks.$inferSelect;
export type NewIssuePullRequestLink = typeof issuePullRequestLinks.$inferInsert;
