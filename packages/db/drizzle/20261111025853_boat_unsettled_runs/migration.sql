CREATE INDEX "native_publication_consumers_held" ON "native_publication_consumers" ("run_id") WHERE "state" <> 'released';--> statement-breakpoint
CREATE INDEX "boat_runs_present" ON "boat_runs" ("deployment_id","run_id") WHERE "absent_at" is null;--> statement-breakpoint
CREATE INDEX "boat_runs_no_vm" ON "boat_runs" ("deployment_id","run_id") WHERE "sandbox_id" is null;