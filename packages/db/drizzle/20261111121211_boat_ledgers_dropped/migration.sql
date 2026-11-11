-- The three per-run Boat ledgers are gone. `boat_runs` has held every Boat run since
-- 20261110223249_boat_runs, which carried their rows over and froze them; nothing has read or
-- written them since. Dropping a table drops its freeze trigger with it; the function the three
-- triggers shared goes last.
DROP TABLE "boat_observations";
--> statement-breakpoint
DROP TABLE "boat_executions";
--> statement-breakpoint
DROP TABLE "boat_allocations";
--> statement-breakpoint
DROP FUNCTION boat_ledger_frozen();
