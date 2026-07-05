ALTER TABLE "issue_pull_request_links" DROP CONSTRAINT "issue_pull_request_links_issue_id_issues_id_fkey";--> statement-breakpoint
ALTER TABLE "issue_pull_request_links" DROP CONSTRAINT "issue_pull_request_links_pull_request_id_pull_requests_id_fkey";--> statement-breakpoint
ALTER TABLE "issue_workflow_execution_artifacts" DROP CONSTRAINT "issue_workflow_execution_artifacts_OdGAsUrt386T_fkey";--> statement-breakpoint
ALTER TABLE "issue_workflow_execution_diff_files" DROP CONSTRAINT "issue_workflow_execution_diff_files_PzU4XOEQ7QxX_fkey";--> statement-breakpoint
ALTER TABLE "issue_workflow_execution_diff_files" DROP CONSTRAINT "issue_workflow_execution_diff_files_FA6U7Ig7C1I3_fkey";--> statement-breakpoint
ALTER TABLE "issue_workflow_execution_events" DROP CONSTRAINT "issue_workflow_execution_events_mlq9ZWGhmBK7_fkey";--> statement-breakpoint
ALTER TABLE "issue_workflow_execution_pull_request_links" DROP CONSTRAINT "issue_workflow_execution_pull_request_links_PoNs2I1qO9XB_fkey";--> statement-breakpoint
ALTER TABLE "issue_workflow_execution_pull_request_links" DROP CONSTRAINT "issue_workflow_execution_pull_request_links_wS7DhgGITOBB_fkey";--> statement-breakpoint
ALTER TABLE "issue_workflow_execution_summaries" DROP CONSTRAINT "issue_workflow_execution_summaries_Ti8d5GTYEnNS_fkey";--> statement-breakpoint
ALTER TABLE "issue_workflow_execution_validation_results" DROP CONSTRAINT "issue_workflow_execution_validation_results_mK2N9rPghzKK_fkey";--> statement-breakpoint
ALTER TABLE "issue_workflow_executions" DROP CONSTRAINT "issue_workflow_executions_ucqHCWr1cwUG_fkey";--> statement-breakpoint
ALTER TABLE "issue_workflows" DROP CONSTRAINT "issue_workflows_issue_id_issues_id_fkey";--> statement-breakpoint
ALTER TABLE "sandbox_attempts" DROP CONSTRAINT "sandbox_attempts_issue_id_issues_id_fkey";--> statement-breakpoint
DROP TABLE "issue_pull_request_links";--> statement-breakpoint
DROP TABLE "issue_workflow_execution_artifacts";--> statement-breakpoint
DROP TABLE "issue_workflow_execution_diff_files";--> statement-breakpoint
DROP TABLE "issue_workflow_execution_events";--> statement-breakpoint
DROP TABLE "issue_workflow_execution_pull_request_links";--> statement-breakpoint
DROP TABLE "issue_workflow_execution_summaries";--> statement-breakpoint
DROP TABLE "issue_workflow_execution_validation_results";--> statement-breakpoint
DROP TABLE "issue_workflow_executions";--> statement-breakpoint
DROP TABLE "issue_workflows";--> statement-breakpoint
DROP TABLE "issues";--> statement-breakpoint
DROP TABLE "pull_requests";--> statement-breakpoint
DROP INDEX "sandbox_attempts_issue_id_created_at_idx";--> statement-breakpoint
ALTER TABLE "sandbox_attempts" DROP COLUMN "issue_id";