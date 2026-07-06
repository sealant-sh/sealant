ALTER TABLE "sandboxes" RENAME TO "workspaces";--> statement-breakpoint
ALTER TABLE "sandbox_attempts" RENAME TO "workspace_attempts";--> statement-breakpoint
ALTER TABLE "sandbox_run_links" RENAME TO "workspace_run_links";--> statement-breakpoint
ALTER TABLE "sandbox_attempt_snapshots" RENAME TO "workspace_attempt_snapshots";--> statement-breakpoint
ALTER TABLE "sandbox_runtime_instances" RENAME TO "workspace_runtime_instances";--> statement-breakpoint
ALTER TABLE "runs" RENAME COLUMN "sandbox_id" TO "workspace_id";--> statement-breakpoint
ALTER TABLE "workspace_run_links" RENAME COLUMN "sandbox_id" TO "workspace_id";--> statement-breakpoint
ALTER INDEX "runs_sandbox_id_created_at_idx" RENAME TO "runs_workspace_id_created_at_idx";--> statement-breakpoint
ALTER INDEX "sandbox_attempts_owner_user_id_status_created_at_idx" RENAME TO "workspace_attempts_owner_user_id_status_created_at_idx";--> statement-breakpoint
ALTER INDEX "sandbox_attempts_repository_id_created_at_idx" RENAME TO "workspace_attempts_repository_id_created_at_idx";--> statement-breakpoint
ALTER INDEX "sandbox_attempts_profile_revision_id_created_at_idx" RENAME TO "workspace_attempts_profile_revision_id_created_at_idx";--> statement-breakpoint
ALTER INDEX "sandbox_attempts_repository_profile_revision_id_created_at_idx" RENAME TO "workspace_attempts_repository_profile_revision_id_created_at_idx";--> statement-breakpoint
ALTER INDEX "sandbox_attempts_status_started_at_idx" RENAME TO "workspace_attempts_status_started_at_idx";--> statement-breakpoint
ALTER INDEX "sandbox_run_links_run_id_idx" RENAME TO "workspace_run_links_run_id_idx";--> statement-breakpoint
ALTER INDEX "sandbox_run_links_sandbox_id_linked_at_idx" RENAME TO "workspace_run_links_workspace_id_linked_at_idx";--> statement-breakpoint
ALTER INDEX "sandboxes_owner_user_id_status_created_at_idx" RENAME TO "workspaces_owner_user_id_status_created_at_idx";--> statement-breakpoint
ALTER INDEX "sandboxes_repository_id_created_at_idx" RENAME TO "workspaces_repository_id_created_at_idx";--> statement-breakpoint
ALTER INDEX "sandboxes_latest_run_id_idx" RENAME TO "workspaces_latest_run_id_idx";--> statement-breakpoint
ALTER INDEX "sandbox_runtime_instances_status_updated_at_idx" RENAME TO "workspace_runtime_instances_status_updated_at_idx";--> statement-breakpoint
ALTER INDEX "sandbox_runtime_instances_adapter_status_idx" RENAME TO "workspace_runtime_instances_adapter_status_idx";--> statement-breakpoint
ALTER TABLE "runs" RENAME CONSTRAINT "runs_sandbox_id_sandboxes_id_fkey" TO "runs_workspace_id_workspaces_id_fkey";--> statement-breakpoint
ALTER TABLE "runs" RENAME CONSTRAINT "runs_attempt_id_sandbox_attempts_id_fkey" TO "runs_attempt_id_workspace_attempts_id_fkey";--> statement-breakpoint
ALTER TABLE "workspace_attempt_snapshots" RENAME CONSTRAINT "sandbox_attempt_snapshots_pkey" TO "workspace_attempt_snapshots_pkey";--> statement-breakpoint
ALTER TABLE "workspace_attempt_snapshots" RENAME CONSTRAINT "sandbox_attempt_snapshots_run_id_sandbox_attempts_id_fkey" TO "workspace_attempt_snapshots_run_id_workspace_attempts_id_fkey";--> statement-breakpoint
ALTER TABLE "workspace_attempts" RENAME CONSTRAINT "sandbox_attempts_pkey" TO "workspace_attempts_pkey";--> statement-breakpoint
ALTER TABLE "workspace_attempts" RENAME CONSTRAINT "sandbox_attempts_owner_user_id_user_id_fkey" TO "workspace_attempts_owner_user_id_user_id_fkey";--> statement-breakpoint
ALTER TABLE "workspace_attempts" RENAME CONSTRAINT "sandbox_attempts_repository_id_repositories_id_fkey" TO "workspace_attempts_repository_id_repositories_id_fkey";--> statement-breakpoint
ALTER TABLE "workspace_attempts" RENAME CONSTRAINT "sandbox_attempts_vSM9mCbOUfBx_fkey" TO "workspace_attempts_vSM9mCbOUfBx_fkey";--> statement-breakpoint
ALTER TABLE "workspace_attempts" RENAME CONSTRAINT "sandbox_attempts_profile_revision_id_profile_revisions_id_fkey" TO "workspace_attempts_profile_revision_id_profile_revisions_id_fkey";--> statement-breakpoint
ALTER TABLE "workspace_attempts" RENAME CONSTRAINT "sandbox_attempts_requested_by_user_id_user_id_fkey" TO "workspace_attempts_requested_by_user_id_user_id_fkey";--> statement-breakpoint
ALTER TABLE "workspace_run_links" RENAME CONSTRAINT "sandbox_run_links_pkey" TO "workspace_run_links_pkey";--> statement-breakpoint
ALTER TABLE "workspace_run_links" RENAME CONSTRAINT "sandbox_run_links_sandbox_id_sandboxes_id_fkey" TO "workspace_run_links_workspace_id_workspaces_id_fkey";--> statement-breakpoint
ALTER TABLE "workspace_run_links" RENAME CONSTRAINT "sandbox_run_links_run_id_sandbox_attempts_id_fkey" TO "workspace_run_links_run_id_workspace_attempts_id_fkey";--> statement-breakpoint
ALTER TABLE "workspaces" RENAME CONSTRAINT "sandboxes_pkey" TO "workspaces_pkey";--> statement-breakpoint
ALTER TABLE "workspaces" RENAME CONSTRAINT "sandboxes_owner_user_id_user_id_fkey" TO "workspaces_owner_user_id_user_id_fkey";--> statement-breakpoint
ALTER TABLE "workspaces" RENAME CONSTRAINT "sandboxes_repository_id_repositories_id_fkey" TO "workspaces_repository_id_repositories_id_fkey";--> statement-breakpoint
ALTER TABLE "workspaces" RENAME CONSTRAINT "sandboxes_u64S3twqB0DQ_fkey" TO "workspaces_u64S3twqB0DQ_fkey";--> statement-breakpoint
ALTER TABLE "workspaces" RENAME CONSTRAINT "sandboxes_profile_revision_id_profile_revisions_id_fkey" TO "workspaces_profile_revision_id_profile_revisions_id_fkey";--> statement-breakpoint
ALTER TABLE "workspaces" RENAME CONSTRAINT "sandboxes_requested_by_user_id_user_id_fkey" TO "workspaces_requested_by_user_id_user_id_fkey";--> statement-breakpoint
ALTER TABLE "workspaces" RENAME CONSTRAINT "sandboxes_latest_run_id_sandbox_attempts_id_fkey" TO "workspaces_latest_run_id_workspace_attempts_id_fkey";--> statement-breakpoint
ALTER TABLE "oci_image_build_jobs" RENAME CONSTRAINT "oci_image_build_jobs_run_id_sandbox_attempts_id_fkey" TO "oci_image_build_jobs_run_id_workspace_attempts_id_fkey";--> statement-breakpoint
ALTER TABLE "workspace_runtime_instances" RENAME CONSTRAINT "sandbox_runtime_instances_pkey" TO "workspace_runtime_instances_pkey";--> statement-breakpoint
ALTER TABLE "workspace_runtime_instances" RENAME CONSTRAINT "sandbox_runtime_instances_run_id_sandbox_attempts_id_fkey" TO "workspace_runtime_instances_run_id_workspace_attempts_id_fkey";
