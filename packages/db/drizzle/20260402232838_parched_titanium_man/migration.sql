CREATE TABLE "account" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"id_token" text,
	"password" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "github_app_installations" (
	"id" text PRIMARY KEY,
	"provider" text DEFAULT 'github' NOT NULL,
	"external_installation_id" text NOT NULL,
	"external_account_id" text,
	"account_login" text NOT NULL,
	"account_type" text NOT NULL,
	"target_type" text,
	"status" text DEFAULT 'active' NOT NULL,
	"permissions" jsonb NOT NULL,
	"repository_selection" text DEFAULT 'all' NOT NULL,
	"installed_at" timestamp with time zone,
	"suspended_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "github_installation_repositories" (
	"id" text PRIMARY KEY,
	"installation_id" text NOT NULL,
	"repository_id" text NOT NULL,
	"external_repository_id" text NOT NULL,
	"owner" text NOT NULL,
	"name" text NOT NULL,
	"full_name" text NOT NULL,
	"default_branch" text DEFAULT 'main' NOT NULL,
	"is_private" boolean DEFAULT true NOT NULL,
	"is_archived" boolean DEFAULT false NOT NULL,
	"pushed_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"removed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "github_installation_user_grants" (
	"installation_id" text,
	"user_id" text,
	"granted_by_user_id" text,
	"granted_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "github_installation_user_grants_pkey" PRIMARY KEY("installation_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "github_webhook_deliveries" (
	"id" text PRIMARY KEY,
	"delivery_id" text NOT NULL,
	"event_type" text NOT NULL,
	"action" text,
	"installation_external_id" text,
	"payload" jsonb,
	"received_at" timestamp with time zone NOT NULL,
	"processed_at" timestamp with time zone,
	"status" text DEFAULT 'received' NOT NULL,
	"error_message" text
);
--> statement-breakpoint
CREATE TABLE "issue_pull_request_links" (
	"issue_id" text,
	"pull_request_id" text,
	"relation" text DEFAULT 'fixes' NOT NULL,
	"linked_at" timestamp with time zone NOT NULL,
	CONSTRAINT "issue_pull_request_links_pkey" PRIMARY KEY("issue_id","pull_request_id")
);
--> statement-breakpoint
CREATE TABLE "issue_workflow_execution_artifacts" (
	"id" text PRIMARY KEY,
	"execution_id" text NOT NULL,
	"kind" text DEFAULT 'other' NOT NULL,
	"storage_backend" text DEFAULT 'inline' NOT NULL,
	"storage_key" text,
	"content_type" text,
	"byte_size" integer,
	"checksum" text,
	"inline_json" jsonb,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issue_workflow_execution_diff_files" (
	"id" text PRIMARY KEY,
	"execution_id" text NOT NULL,
	"change_type" text NOT NULL,
	"path" text NOT NULL,
	"old_path" text,
	"additions" integer DEFAULT 0 NOT NULL,
	"deletions" integer DEFAULT 0 NOT NULL,
	"is_binary" boolean DEFAULT false NOT NULL,
	"patch_artifact_id" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issue_workflow_execution_events" (
	"id" text PRIMARY KEY,
	"execution_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"phase" text NOT NULL,
	"level" text DEFAULT 'info' NOT NULL,
	"event_type" text NOT NULL,
	"message" text NOT NULL,
	"payload" jsonb,
	"occurred_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issue_workflow_execution_pull_request_links" (
	"execution_id" text,
	"pull_request_id" text,
	"relation" text DEFAULT 'created' NOT NULL,
	"linked_at" timestamp with time zone NOT NULL,
	CONSTRAINT "issue_workflow_execution_pull_request_links_pkey" PRIMARY KEY("execution_id","pull_request_id")
);
--> statement-breakpoint
CREATE TABLE "issue_workflow_execution_summaries" (
	"execution_id" text PRIMARY KEY,
	"objective" text,
	"linked_issue_ref" text,
	"files_changed" integer DEFAULT 0 NOT NULL,
	"additions" integer DEFAULT 0 NOT NULL,
	"deletions" integer DEFAULT 0 NOT NULL,
	"assumptions" jsonb NOT NULL,
	"warnings" jsonb NOT NULL,
	"summary_markdown" text,
	"generated_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issue_workflow_execution_validation_results" (
	"id" text PRIMARY KEY,
	"execution_id" text NOT NULL,
	"check_key" text NOT NULL,
	"status" text NOT NULL,
	"duration_ms" integer,
	"message" text,
	"details" jsonb,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issue_workflow_executions" (
	"id" text PRIMARY KEY,
	"issue_workflow_id" text NOT NULL,
	"sandbox_id" text,
	"sandbox_attempt_id" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"trigger_type" text DEFAULT 'manual' NOT NULL,
	"requested_by_user_id" text,
	"cancel_reason" text,
	"queued_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"duration_ms" integer,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issue_workflows" (
	"id" text PRIMARY KEY,
	"issue_id" text NOT NULL,
	"repository_id" text NOT NULL,
	"owner_user_id" text,
	"status" text DEFAULT 'active' NOT NULL,
	"requested_by_user_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "issues" (
	"id" text PRIMARY KEY,
	"repository_id" text NOT NULL,
	"provider" text DEFAULT 'github' NOT NULL,
	"external_id" text,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"url" text,
	"author_user_id" text,
	"assignee_user_id" text,
	"opened_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"synced_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "package_resolution_cache_entries" (
	"query" text PRIMARY KEY,
	"resolution_payload" jsonb NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone NOT NULL,
	"hit_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "profile_env_vars" (
	"id" text PRIMARY KEY,
	"profile_revision_id" text NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "profile_revisions" (
	"id" text PRIMARY KEY,
	"profile_id" text NOT NULL,
	"version" integer NOT NULL,
	"created_by_user_id" text,
	"change_summary" text,
	"fingerprint" text NOT NULL,
	"config_patch" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "profile_secret_bindings" (
	"id" text PRIMARY KEY,
	"profile_revision_id" text NOT NULL,
	"target_key" text NOT NULL,
	"secret_id" text NOT NULL,
	"secret_version_id" text,
	"is_required" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "profile_ssh_key_bindings" (
	"profile_revision_id" text,
	"ssh_key_id" text,
	"purpose" text DEFAULT 'login',
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "profile_ssh_key_bindings_pkey" PRIMARY KEY("profile_revision_id","ssh_key_id","purpose")
);
--> statement-breakpoint
CREATE TABLE "profile_ssh_settings" (
	"profile_revision_id" text PRIMARY KEY,
	"enabled" boolean DEFAULT false NOT NULL,
	"listen_port" integer DEFAULT 2222 NOT NULL,
	"host_allowlist" jsonb NOT NULL,
	"session_timeout_minutes" integer,
	"authorized_keys_ref" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "profiles" (
	"id" text PRIMARY KEY,
	"owner_user_id" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'active' NOT NULL,
	"active_revision_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "pull_requests" (
	"id" text PRIMARY KEY,
	"repository_id" text NOT NULL,
	"provider" text DEFAULT 'github' NOT NULL,
	"external_id" text,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"head_branch" text NOT NULL,
	"base_branch" text NOT NULL,
	"head_sha" text,
	"url" text,
	"author_user_id" text,
	"opened_at" timestamp with time zone,
	"merged_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"synced_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repositories" (
	"id" text PRIMARY KEY,
	"provider" text DEFAULT 'generic' NOT NULL,
	"external_id" text,
	"owner" text NOT NULL,
	"name" text NOT NULL,
	"default_branch" text DEFAULT 'main' NOT NULL,
	"url" text,
	"is_archived" boolean DEFAULT false NOT NULL,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repository_profile_profile_links" (
	"id" text PRIMARY KEY,
	"repository_profile_revision_id" text NOT NULL,
	"profile_revision_id" text NOT NULL,
	"precedence" integer DEFAULT 0 NOT NULL,
	"is_required" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repository_profile_revisions" (
	"id" text PRIMARY KEY,
	"repository_profile_id" text NOT NULL,
	"version" integer NOT NULL,
	"created_by_user_id" text,
	"change_summary" text,
	"fingerprint" text NOT NULL,
	"run_template" jsonb NOT NULL,
	"policy_config" jsonb,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repository_profiles" (
	"id" text PRIMARY KEY,
	"repository_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'active' NOT NULL,
	"active_revision_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sandbox_attempt_snapshots" (
	"run_id" text PRIMARY KEY,
	"user_spec_payload" jsonb NOT NULL,
	"resolved_spec_payload" jsonb NOT NULL,
	"blueprint_payload" jsonb NOT NULL,
	"profile_config_snapshot" jsonb,
	"repository_profile_config_snapshot" jsonb,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sandbox_attempts" (
	"id" text PRIMARY KEY,
	"owner_user_id" text NOT NULL,
	"repository_id" text,
	"repository_profile_revision_id" text,
	"profile_revision_id" text,
	"issue_id" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"trigger_type" text DEFAULT 'manual' NOT NULL,
	"trigger_ref" text,
	"requested_by_user_id" text,
	"retry_of_run_id" text,
	"cancel_reason" text,
	"queued_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"duration_ms" integer,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sandbox_run_links" (
	"sandbox_id" text,
	"run_id" text,
	"relation" text DEFAULT 'launch' NOT NULL,
	"linked_at" timestamp with time zone NOT NULL,
	CONSTRAINT "sandbox_run_links_pkey" PRIMARY KEY("sandbox_id","run_id")
);
--> statement-breakpoint
CREATE TABLE "sandboxes" (
	"id" text PRIMARY KEY,
	"name" text DEFAULT '' NOT NULL,
	"owner_user_id" text NOT NULL,
	"repository_id" text,
	"repository_profile_revision_id" text,
	"profile_revision_id" text,
	"requested_by_user_id" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"latest_run_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "secret_versions" (
	"id" text PRIMARY KEY,
	"secret_id" text NOT NULL,
	"version" integer NOT NULL,
	"encrypted_value" text NOT NULL,
	"encryption_key_id" text,
	"value_sha256" text NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "secrets" (
	"id" text PRIMARY KEY,
	"owner_user_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ssh_keys" (
	"id" text PRIMARY KEY,
	"owner_user_id" text NOT NULL,
	"name" text NOT NULL,
	"public_key" text NOT NULL,
	"private_key_secret_id" text,
	"passphrase_secret_id" text,
	"fingerprint" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "oci_image_build_jobs" (
	"id" text PRIMARY KEY,
	"run_id" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"registry_id" text NOT NULL,
	"repository" text NOT NULL,
	"tag" text NOT NULL,
	"request_payload" jsonb NOT NULL,
	"idempotency_key" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"available_at" timestamp with time zone NOT NULL,
	"claimed_at" timestamp with time zone,
	"lease_expires_at" timestamp with time zone,
	"worker_id" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"builder_id" text,
	"result_payload" jsonb,
	"published_reference" text,
	"published_digest_reference" text,
	"published_digest" text,
	"error_code" text,
	"error_message" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sandbox_runtime_instances" (
	"run_id" text PRIMARY KEY,
	"status" text DEFAULT 'pending' NOT NULL,
	"adapter" text,
	"resource_id" text,
	"reference" text,
	"endpoint" text,
	"error_code" text,
	"error_message" text,
	"launched_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "account_provider_account_idx" ON "account" ("provider_id","account_id");--> statement-breakpoint
CREATE INDEX "account_user_id_idx" ON "account" ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "session_token_idx" ON "session" ("token");--> statement-breakpoint
CREATE INDEX "session_user_id_idx" ON "session" ("user_id");--> statement-breakpoint
CREATE INDEX "session_expires_at_idx" ON "session" ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "user_email_idx" ON "user" ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "verification_identifier_value_idx" ON "verification" ("identifier","value");--> statement-breakpoint
CREATE INDEX "verification_expires_at_idx" ON "verification" ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "github_app_installations_external_installation_id_idx" ON "github_app_installations" ("external_installation_id");--> statement-breakpoint
CREATE INDEX "github_app_installations_account_login_idx" ON "github_app_installations" ("account_login");--> statement-breakpoint
CREATE INDEX "github_app_installations_status_idx" ON "github_app_installations" ("status");--> statement-breakpoint
CREATE INDEX "github_app_installations_last_synced_at_idx" ON "github_app_installations" ("last_synced_at");--> statement-breakpoint
CREATE UNIQUE INDEX "github_installation_repositories_installation_external_repo_idx" ON "github_installation_repositories" ("installation_id","external_repository_id");--> statement-breakpoint
CREATE UNIQUE INDEX "github_installation_repositories_installation_repository_id_idx" ON "github_installation_repositories" ("installation_id","repository_id");--> statement-breakpoint
CREATE INDEX "github_installation_repositories_full_name_idx" ON "github_installation_repositories" ("full_name");--> statement-breakpoint
CREATE INDEX "github_installation_repositories_removed_at_idx" ON "github_installation_repositories" ("removed_at");--> statement-breakpoint
CREATE INDEX "github_installation_repositories_last_synced_at_idx" ON "github_installation_repositories" ("last_synced_at");--> statement-breakpoint
CREATE INDEX "github_installation_user_grants_user_id_revoked_at_idx" ON "github_installation_user_grants" ("user_id","revoked_at");--> statement-breakpoint
CREATE INDEX "github_installation_user_grants_installation_id_revoked_at_idx" ON "github_installation_user_grants" ("installation_id","revoked_at");--> statement-breakpoint
CREATE UNIQUE INDEX "github_webhook_deliveries_delivery_id_idx" ON "github_webhook_deliveries" ("delivery_id");--> statement-breakpoint
CREATE INDEX "github_webhook_deliveries_event_type_received_at_idx" ON "github_webhook_deliveries" ("event_type","received_at");--> statement-breakpoint
CREATE INDEX "github_webhook_deliveries_status_received_at_idx" ON "github_webhook_deliveries" ("status","received_at");--> statement-breakpoint
CREATE INDEX "issue_pull_request_links_pull_request_id_relation_idx" ON "issue_pull_request_links" ("pull_request_id","relation");--> statement-breakpoint
CREATE INDEX "issue_workflow_execution_artifacts_execution_id_kind_idx" ON "issue_workflow_execution_artifacts" ("execution_id","kind");--> statement-breakpoint
CREATE INDEX "iwf_exec_artifacts_storage_backend_storage_key_idx" ON "issue_workflow_execution_artifacts" ("storage_backend","storage_key");--> statement-breakpoint
CREATE INDEX "issue_workflow_execution_diff_files_execution_id_path_idx" ON "issue_workflow_execution_diff_files" ("execution_id","path");--> statement-breakpoint
CREATE INDEX "iwf_exec_diff_files_execution_id_change_type_idx" ON "issue_workflow_execution_diff_files" ("execution_id","change_type");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_workflow_execution_events_execution_id_sequence_idx" ON "issue_workflow_execution_events" ("execution_id","sequence");--> statement-breakpoint
CREATE INDEX "issue_workflow_execution_events_execution_id_occurred_at_idx" ON "issue_workflow_execution_events" ("execution_id","occurred_at");--> statement-breakpoint
CREATE INDEX "issue_workflow_execution_events_execution_id_level_idx" ON "issue_workflow_execution_events" ("execution_id","level");--> statement-breakpoint
CREATE INDEX "iwf_exec_pr_links_pull_request_id_relation_idx" ON "issue_workflow_execution_pull_request_links" ("pull_request_id","relation");--> statement-breakpoint
CREATE UNIQUE INDEX "iwf_exec_validation_results_execution_id_check_key_idx" ON "issue_workflow_execution_validation_results" ("execution_id","check_key");--> statement-breakpoint
CREATE INDEX "iwf_exec_validation_results_execution_id_status_idx" ON "issue_workflow_execution_validation_results" ("execution_id","status");--> statement-breakpoint
CREATE INDEX "issue_workflow_executions_workflow_id_created_at_idx" ON "issue_workflow_executions" ("issue_workflow_id","created_at");--> statement-breakpoint
CREATE INDEX "issue_workflow_executions_status_started_at_idx" ON "issue_workflow_executions" ("status","started_at");--> statement-breakpoint
CREATE INDEX "issue_workflow_executions_sandbox_id_created_at_idx" ON "issue_workflow_executions" ("sandbox_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_workflow_executions_sandbox_attempt_id_idx" ON "issue_workflow_executions" ("sandbox_attempt_id");--> statement-breakpoint
CREATE INDEX "issue_workflows_issue_id_status_idx" ON "issue_workflows" ("issue_id","status");--> statement-breakpoint
CREATE INDEX "issue_workflows_repository_id_status_idx" ON "issue_workflows" ("repository_id","status");--> statement-breakpoint
CREATE INDEX "issue_workflows_owner_user_id_status_idx" ON "issue_workflows" ("owner_user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "issues_provider_repository_id_number_idx" ON "issues" ("provider","repository_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "issues_provider_external_id_idx" ON "issues" ("provider","external_id");--> statement-breakpoint
CREATE INDEX "issues_repository_id_state_idx" ON "issues" ("repository_id","state");--> statement-breakpoint
CREATE INDEX "issues_assignee_user_id_state_idx" ON "issues" ("assignee_user_id","state");--> statement-breakpoint
CREATE INDEX "package_resolution_cache_entries_expires_at_idx" ON "package_resolution_cache_entries" ("expires_at");--> statement-breakpoint
CREATE INDEX "package_resolution_cache_entries_last_used_at_idx" ON "package_resolution_cache_entries" ("last_used_at");--> statement-breakpoint
CREATE UNIQUE INDEX "profile_env_vars_profile_revision_id_key_idx" ON "profile_env_vars" ("profile_revision_id","key");--> statement-breakpoint
CREATE INDEX "profile_env_vars_profile_revision_id_idx" ON "profile_env_vars" ("profile_revision_id");--> statement-breakpoint
CREATE UNIQUE INDEX "profile_revisions_profile_id_version_idx" ON "profile_revisions" ("profile_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "profile_revisions_profile_id_fingerprint_idx" ON "profile_revisions" ("profile_id","fingerprint");--> statement-breakpoint
CREATE INDEX "profile_revisions_created_by_user_id_idx" ON "profile_revisions" ("created_by_user_id");--> statement-breakpoint
CREATE INDEX "profile_revisions_created_at_idx" ON "profile_revisions" ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "profile_secret_bindings_profile_revision_id_target_key_idx" ON "profile_secret_bindings" ("profile_revision_id","target_key");--> statement-breakpoint
CREATE INDEX "profile_secret_bindings_secret_id_idx" ON "profile_secret_bindings" ("secret_id");--> statement-breakpoint
CREATE INDEX "profile_secret_bindings_profile_revision_id_idx" ON "profile_secret_bindings" ("profile_revision_id");--> statement-breakpoint
CREATE INDEX "profile_ssh_key_bindings_ssh_key_id_idx" ON "profile_ssh_key_bindings" ("ssh_key_id");--> statement-breakpoint
CREATE INDEX "profile_ssh_settings_enabled_idx" ON "profile_ssh_settings" ("enabled");--> statement-breakpoint
CREATE UNIQUE INDEX "profiles_owner_user_id_slug_idx" ON "profiles" ("owner_user_id","slug");--> statement-breakpoint
CREATE INDEX "profiles_owner_user_id_status_idx" ON "profiles" ("owner_user_id","status");--> statement-breakpoint
CREATE INDEX "profiles_active_revision_id_idx" ON "profiles" ("active_revision_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pull_requests_provider_repository_id_number_idx" ON "pull_requests" ("provider","repository_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "pull_requests_provider_external_id_idx" ON "pull_requests" ("provider","external_id");--> statement-breakpoint
CREATE INDEX "pull_requests_repository_id_state_idx" ON "pull_requests" ("repository_id","state");--> statement-breakpoint
CREATE INDEX "pull_requests_head_sha_idx" ON "pull_requests" ("head_sha");--> statement-breakpoint
CREATE UNIQUE INDEX "repositories_provider_owner_name_idx" ON "repositories" ("provider","owner","name");--> statement-breakpoint
CREATE UNIQUE INDEX "repositories_provider_external_id_idx" ON "repositories" ("provider","external_id");--> statement-breakpoint
CREATE INDEX "repositories_owner_name_idx" ON "repositories" ("owner","name");--> statement-breakpoint
CREATE INDEX "repositories_last_synced_at_idx" ON "repositories" ("last_synced_at");--> statement-breakpoint
CREATE UNIQUE INDEX "repository_profile_profile_links_repository_profile_revision_id_profile_revision_id_idx" ON "repository_profile_profile_links" ("repository_profile_revision_id","profile_revision_id");--> statement-breakpoint
CREATE INDEX "repository_profile_profile_links_profile_revision_id_idx" ON "repository_profile_profile_links" ("profile_revision_id");--> statement-breakpoint
CREATE UNIQUE INDEX "repository_profile_revisions_repository_profile_id_version_idx" ON "repository_profile_revisions" ("repository_profile_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "repository_profile_revisions_profile_id_fingerprint_idx" ON "repository_profile_revisions" ("repository_profile_id","fingerprint");--> statement-breakpoint
CREATE INDEX "repository_profile_revisions_created_at_idx" ON "repository_profile_revisions" ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "repository_profiles_repository_id_name_idx" ON "repository_profiles" ("repository_id","name");--> statement-breakpoint
CREATE INDEX "repository_profiles_repository_id_status_idx" ON "repository_profiles" ("repository_id","status");--> statement-breakpoint
CREATE INDEX "repository_profiles_active_revision_id_idx" ON "repository_profiles" ("active_revision_id");--> statement-breakpoint
CREATE INDEX "sandbox_attempts_owner_user_id_status_created_at_idx" ON "sandbox_attempts" ("owner_user_id","status","created_at");--> statement-breakpoint
CREATE INDEX "sandbox_attempts_repository_id_created_at_idx" ON "sandbox_attempts" ("repository_id","created_at");--> statement-breakpoint
CREATE INDEX "sandbox_attempts_profile_revision_id_created_at_idx" ON "sandbox_attempts" ("profile_revision_id","created_at");--> statement-breakpoint
CREATE INDEX "sandbox_attempts_repository_profile_revision_id_created_at_idx" ON "sandbox_attempts" ("repository_profile_revision_id","created_at");--> statement-breakpoint
CREATE INDEX "sandbox_attempts_issue_id_created_at_idx" ON "sandbox_attempts" ("issue_id","created_at");--> statement-breakpoint
CREATE INDEX "sandbox_attempts_status_started_at_idx" ON "sandbox_attempts" ("status","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sandbox_run_links_run_id_idx" ON "sandbox_run_links" ("run_id");--> statement-breakpoint
CREATE INDEX "sandbox_run_links_sandbox_id_linked_at_idx" ON "sandbox_run_links" ("sandbox_id","linked_at");--> statement-breakpoint
CREATE INDEX "sandboxes_owner_user_id_status_created_at_idx" ON "sandboxes" ("owner_user_id","status","created_at");--> statement-breakpoint
CREATE INDEX "sandboxes_repository_id_created_at_idx" ON "sandboxes" ("repository_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sandboxes_latest_run_id_idx" ON "sandboxes" ("latest_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "secret_versions_secret_id_version_idx" ON "secret_versions" ("secret_id","version");--> statement-breakpoint
CREATE INDEX "secret_versions_created_by_user_id_idx" ON "secret_versions" ("created_by_user_id");--> statement-breakpoint
CREATE INDEX "secret_versions_secret_id_created_at_idx" ON "secret_versions" ("secret_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "secrets_owner_user_id_name_idx" ON "secrets" ("owner_user_id","name");--> statement-breakpoint
CREATE INDEX "secrets_owner_user_id_idx" ON "secrets" ("owner_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ssh_keys_owner_user_id_fingerprint_idx" ON "ssh_keys" ("owner_user_id","fingerprint");--> statement-breakpoint
CREATE INDEX "ssh_keys_owner_user_id_name_idx" ON "ssh_keys" ("owner_user_id","name");--> statement-breakpoint
CREATE INDEX "oci_image_build_jobs_status_available_at_idx" ON "oci_image_build_jobs" ("status","available_at");--> statement-breakpoint
CREATE INDEX "oci_image_build_jobs_status_claimed_at_idx" ON "oci_image_build_jobs" ("status","claimed_at");--> statement-breakpoint
CREATE INDEX "oci_image_build_jobs_created_at_idx" ON "oci_image_build_jobs" ("created_at");--> statement-breakpoint
CREATE INDEX "oci_image_build_jobs_run_id_idx" ON "oci_image_build_jobs" ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "oci_image_build_jobs_idempotency_key_idx" ON "oci_image_build_jobs" ("idempotency_key");--> statement-breakpoint
CREATE INDEX "sandbox_runtime_instances_status_updated_at_idx" ON "sandbox_runtime_instances" ("status","updated_at");--> statement-breakpoint
CREATE INDEX "sandbox_runtime_instances_adapter_status_idx" ON "sandbox_runtime_instances" ("adapter","status");--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "github_installation_repositories" ADD CONSTRAINT "github_installation_repositories_EczgruDGqXK4_fkey" FOREIGN KEY ("installation_id") REFERENCES "github_app_installations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "github_installation_repositories" ADD CONSTRAINT "github_installation_repositories_T7EYEqoYhULZ_fkey" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "github_installation_user_grants" ADD CONSTRAINT "github_installation_user_grants_4P7GtWFXLOXD_fkey" FOREIGN KEY ("installation_id") REFERENCES "github_app_installations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "github_installation_user_grants" ADD CONSTRAINT "github_installation_user_grants_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "github_installation_user_grants" ADD CONSTRAINT "github_installation_user_grants_granted_by_user_id_user_id_fkey" FOREIGN KEY ("granted_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "issue_pull_request_links" ADD CONSTRAINT "issue_pull_request_links_issue_id_issues_id_fkey" FOREIGN KEY ("issue_id") REFERENCES "issues"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "issue_pull_request_links" ADD CONSTRAINT "issue_pull_request_links_pull_request_id_pull_requests_id_fkey" FOREIGN KEY ("pull_request_id") REFERENCES "pull_requests"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "issue_workflow_execution_artifacts" ADD CONSTRAINT "issue_workflow_execution_artifacts_OdGAsUrt386T_fkey" FOREIGN KEY ("execution_id") REFERENCES "issue_workflow_executions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "issue_workflow_execution_diff_files" ADD CONSTRAINT "issue_workflow_execution_diff_files_PzU4XOEQ7QxX_fkey" FOREIGN KEY ("execution_id") REFERENCES "issue_workflow_executions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "issue_workflow_execution_diff_files" ADD CONSTRAINT "issue_workflow_execution_diff_files_FA6U7Ig7C1I3_fkey" FOREIGN KEY ("patch_artifact_id") REFERENCES "issue_workflow_execution_artifacts"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "issue_workflow_execution_events" ADD CONSTRAINT "issue_workflow_execution_events_mlq9ZWGhmBK7_fkey" FOREIGN KEY ("execution_id") REFERENCES "issue_workflow_executions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "issue_workflow_execution_pull_request_links" ADD CONSTRAINT "issue_workflow_execution_pull_request_links_PoNs2I1qO9XB_fkey" FOREIGN KEY ("execution_id") REFERENCES "issue_workflow_executions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "issue_workflow_execution_pull_request_links" ADD CONSTRAINT "issue_workflow_execution_pull_request_links_wS7DhgGITOBB_fkey" FOREIGN KEY ("pull_request_id") REFERENCES "pull_requests"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "issue_workflow_execution_summaries" ADD CONSTRAINT "issue_workflow_execution_summaries_Ti8d5GTYEnNS_fkey" FOREIGN KEY ("execution_id") REFERENCES "issue_workflow_executions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "issue_workflow_execution_validation_results" ADD CONSTRAINT "issue_workflow_execution_validation_results_mK2N9rPghzKK_fkey" FOREIGN KEY ("execution_id") REFERENCES "issue_workflow_executions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "issue_workflow_executions" ADD CONSTRAINT "issue_workflow_executions_ucqHCWr1cwUG_fkey" FOREIGN KEY ("issue_workflow_id") REFERENCES "issue_workflows"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "issue_workflow_executions" ADD CONSTRAINT "issue_workflow_executions_sandbox_id_sandboxes_id_fkey" FOREIGN KEY ("sandbox_id") REFERENCES "sandboxes"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "issue_workflow_executions" ADD CONSTRAINT "issue_workflow_executions_kulwqXrrGOlE_fkey" FOREIGN KEY ("sandbox_attempt_id") REFERENCES "sandbox_attempts"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "issue_workflow_executions" ADD CONSTRAINT "issue_workflow_executions_requested_by_user_id_user_id_fkey" FOREIGN KEY ("requested_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "issue_workflows" ADD CONSTRAINT "issue_workflows_issue_id_issues_id_fkey" FOREIGN KEY ("issue_id") REFERENCES "issues"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "issue_workflows" ADD CONSTRAINT "issue_workflows_repository_id_repositories_id_fkey" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "issue_workflows" ADD CONSTRAINT "issue_workflows_owner_user_id_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "issue_workflows" ADD CONSTRAINT "issue_workflows_requested_by_user_id_user_id_fkey" FOREIGN KEY ("requested_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_repository_id_repositories_id_fkey" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_author_user_id_user_id_fkey" FOREIGN KEY ("author_user_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_assignee_user_id_user_id_fkey" FOREIGN KEY ("assignee_user_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "profile_env_vars" ADD CONSTRAINT "profile_env_vars_profile_revision_id_profile_revisions_id_fkey" FOREIGN KEY ("profile_revision_id") REFERENCES "profile_revisions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "profile_revisions" ADD CONSTRAINT "profile_revisions_profile_id_profiles_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "profiles"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "profile_revisions" ADD CONSTRAINT "profile_revisions_created_by_user_id_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "profile_secret_bindings" ADD CONSTRAINT "profile_secret_bindings_0D5nVEwOMuDq_fkey" FOREIGN KEY ("profile_revision_id") REFERENCES "profile_revisions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "profile_secret_bindings" ADD CONSTRAINT "profile_secret_bindings_secret_id_secrets_id_fkey" FOREIGN KEY ("secret_id") REFERENCES "secrets"("id");--> statement-breakpoint
ALTER TABLE "profile_secret_bindings" ADD CONSTRAINT "profile_secret_bindings_Iz65b4piLqry_fkey" FOREIGN KEY ("secret_version_id") REFERENCES "secret_versions"("id");--> statement-breakpoint
ALTER TABLE "profile_ssh_key_bindings" ADD CONSTRAINT "profile_ssh_key_bindings_4xyaNv6gLvLu_fkey" FOREIGN KEY ("profile_revision_id") REFERENCES "profile_revisions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "profile_ssh_key_bindings" ADD CONSTRAINT "profile_ssh_key_bindings_ssh_key_id_ssh_keys_id_fkey" FOREIGN KEY ("ssh_key_id") REFERENCES "ssh_keys"("id");--> statement-breakpoint
ALTER TABLE "profile_ssh_settings" ADD CONSTRAINT "profile_ssh_settings_a1y2A7BNnJiD_fkey" FOREIGN KEY ("profile_revision_id") REFERENCES "profile_revisions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_owner_user_id_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_repository_id_repositories_id_fkey" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_author_user_id_user_id_fkey" FOREIGN KEY ("author_user_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "repository_profile_profile_links" ADD CONSTRAINT "repository_profile_profile_links_HkCIt3vMg6Ld_fkey" FOREIGN KEY ("repository_profile_revision_id") REFERENCES "repository_profile_revisions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "repository_profile_profile_links" ADD CONSTRAINT "repository_profile_profile_links_2IcWgHsDrtxj_fkey" FOREIGN KEY ("profile_revision_id") REFERENCES "profile_revisions"("id");--> statement-breakpoint
ALTER TABLE "repository_profile_revisions" ADD CONSTRAINT "repository_profile_revisions_GXtbJiENUwkc_fkey" FOREIGN KEY ("repository_profile_id") REFERENCES "repository_profiles"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "repository_profile_revisions" ADD CONSTRAINT "repository_profile_revisions_created_by_user_id_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "repository_profiles" ADD CONSTRAINT "repository_profiles_repository_id_repositories_id_fkey" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sandbox_attempt_snapshots" ADD CONSTRAINT "sandbox_attempt_snapshots_run_id_sandbox_attempts_id_fkey" FOREIGN KEY ("run_id") REFERENCES "sandbox_attempts"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sandbox_attempts" ADD CONSTRAINT "sandbox_attempts_owner_user_id_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sandbox_attempts" ADD CONSTRAINT "sandbox_attempts_repository_id_repositories_id_fkey" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "sandbox_attempts" ADD CONSTRAINT "sandbox_attempts_vSM9mCbOUfBx_fkey" FOREIGN KEY ("repository_profile_revision_id") REFERENCES "repository_profile_revisions"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "sandbox_attempts" ADD CONSTRAINT "sandbox_attempts_profile_revision_id_profile_revisions_id_fkey" FOREIGN KEY ("profile_revision_id") REFERENCES "profile_revisions"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "sandbox_attempts" ADD CONSTRAINT "sandbox_attempts_issue_id_issues_id_fkey" FOREIGN KEY ("issue_id") REFERENCES "issues"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "sandbox_attempts" ADD CONSTRAINT "sandbox_attempts_requested_by_user_id_user_id_fkey" FOREIGN KEY ("requested_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "sandbox_run_links" ADD CONSTRAINT "sandbox_run_links_sandbox_id_sandboxes_id_fkey" FOREIGN KEY ("sandbox_id") REFERENCES "sandboxes"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sandbox_run_links" ADD CONSTRAINT "sandbox_run_links_run_id_sandbox_attempts_id_fkey" FOREIGN KEY ("run_id") REFERENCES "sandbox_attempts"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sandboxes" ADD CONSTRAINT "sandboxes_owner_user_id_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sandboxes" ADD CONSTRAINT "sandboxes_repository_id_repositories_id_fkey" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "sandboxes" ADD CONSTRAINT "sandboxes_u64S3twqB0DQ_fkey" FOREIGN KEY ("repository_profile_revision_id") REFERENCES "repository_profile_revisions"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "sandboxes" ADD CONSTRAINT "sandboxes_profile_revision_id_profile_revisions_id_fkey" FOREIGN KEY ("profile_revision_id") REFERENCES "profile_revisions"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "sandboxes" ADD CONSTRAINT "sandboxes_requested_by_user_id_user_id_fkey" FOREIGN KEY ("requested_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "sandboxes" ADD CONSTRAINT "sandboxes_latest_run_id_sandbox_attempts_id_fkey" FOREIGN KEY ("latest_run_id") REFERENCES "sandbox_attempts"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "secret_versions" ADD CONSTRAINT "secret_versions_secret_id_secrets_id_fkey" FOREIGN KEY ("secret_id") REFERENCES "secrets"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "secret_versions" ADD CONSTRAINT "secret_versions_created_by_user_id_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "secrets" ADD CONSTRAINT "secrets_owner_user_id_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ssh_keys" ADD CONSTRAINT "ssh_keys_owner_user_id_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ssh_keys" ADD CONSTRAINT "ssh_keys_private_key_secret_id_secrets_id_fkey" FOREIGN KEY ("private_key_secret_id") REFERENCES "secrets"("id");--> statement-breakpoint
ALTER TABLE "ssh_keys" ADD CONSTRAINT "ssh_keys_passphrase_secret_id_secrets_id_fkey" FOREIGN KEY ("passphrase_secret_id") REFERENCES "secrets"("id");--> statement-breakpoint
ALTER TABLE "oci_image_build_jobs" ADD CONSTRAINT "oci_image_build_jobs_run_id_sandbox_attempts_id_fkey" FOREIGN KEY ("run_id") REFERENCES "sandbox_attempts"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "sandbox_runtime_instances" ADD CONSTRAINT "sandbox_runtime_instances_run_id_sandbox_attempts_id_fkey" FOREIGN KEY ("run_id") REFERENCES "sandbox_attempts"("id") ON DELETE CASCADE;