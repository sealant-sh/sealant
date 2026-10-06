-- A process's arguments are never stored. sealantd publishes each process's argv in
-- `processStarted`, unredacted, and arguments can carry secrets: Mend has written secret files
-- (base64) and session tokens through exec argv. Ingest now drops them (`withholdProcessArgs` in
-- @sealant/telemetry); this migration makes the database refuse them too and rewrites what is
-- already stored.
--
-- The rule, the same in TypeScript and here: a `processStarted` payload keeps its executable, cwd
-- and pid; `args` becomes `[]`, and `argCount` and `argLengths` (each argument's length in UTF-8
-- bytes) are added. The timeline summary becomes `exec <executable> (<n> arguments not recorded)`.
-- A payload with no arguments, or one already withheld, is left as it is: the whole file can run
-- again and changes nothing the second time.
--
-- It rewrites stored rows, including the append-only log, once. It needs the owner's approval
-- before it runs against a database that holds real records.

CREATE OR REPLACE FUNCTION "sealant_withhold_process_args"("payload" jsonb) RETURNS jsonb
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN jsonb_typeof("payload" -> 'args') = 'array' AND jsonb_array_length("payload" -> 'args') > 0
    THEN ("payload" - 'args') || jsonb_build_object(
      'args', '[]'::jsonb,
      'argCount', jsonb_array_length("payload" -> 'args'),
      'argLengths', (
        SELECT jsonb_agg(octet_length("arg"."value") ORDER BY "arg"."position")
        FROM jsonb_array_elements_text("payload" -> 'args') WITH ORDINALITY AS "arg"("value", "position")
      )
    )
    ELSE "payload"
  END
$$;--> statement-breakpoint

-- The timeline's one-line summary of a withheld `processStarted` payload (`summarize` in
-- @sealant/telemetry): never the arguments, only how many there were.
CREATE OR REPLACE FUNCTION "sealant_process_started_summary"("payload" jsonb) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT 'exec ' || coalesce("payload" ->> 'executable', '?') || CASE
    WHEN coalesce(("payload" ->> 'argCount')::bigint, 0) = 0 THEN ''
    WHEN ("payload" ->> 'argCount')::bigint = 1 THEN ' (1 argument not recorded)'
    ELSE ' (' || ("payload" ->> 'argCount') || ' arguments not recorded)'
  END
$$;--> statement-breakpoint

-- A writer that still sends arguments (an older worker during a rolling deploy) has them withheld
-- on the way in. Only `processStarted` rows reach the function.
CREATE OR REPLACE FUNCTION "telemetry_events_withhold_process_args"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  NEW."payload" := "sealant_withhold_process_args"(NEW."payload");
  RETURN NEW;
END
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "telemetry_events_withhold_process_args" ON "telemetry_events";--> statement-breakpoint
CREATE TRIGGER "telemetry_events_withhold_process_args"
  BEFORE INSERT OR UPDATE OF "payload" ON "telemetry_events"
  FOR EACH ROW WHEN (NEW."payload_case" = 'processStarted')
  EXECUTE FUNCTION "telemetry_events_withhold_process_args"();--> statement-breakpoint

CREATE OR REPLACE FUNCTION "telemetry_timeline_withhold_process_args"() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  "withheld" jsonb := "sealant_withhold_process_args"(NEW."ref_json");
BEGIN
  IF "withheld" IS DISTINCT FROM NEW."ref_json" THEN
    NEW."ref_json" := "withheld";
    NEW."summary" := "sealant_process_started_summary"("withheld");
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "telemetry_timeline_withhold_process_args" ON "telemetry_timeline";--> statement-breakpoint
CREATE TRIGGER "telemetry_timeline_withhold_process_args"
  BEFORE INSERT OR UPDATE OF "ref_json", "summary" ON "telemetry_timeline"
  FOR EACH ROW WHEN (NEW."kind" = 'processStarted')
  EXECUTE FUNCTION "telemetry_timeline_withhold_process_args"();--> statement-breakpoint

-- The purge of what is already stored.
UPDATE "telemetry_events"
SET "payload" = "sealant_withhold_process_args"("payload")
WHERE "payload_case" = 'processStarted'
  AND jsonb_typeof("payload" -> 'args') = 'array'
  AND jsonb_array_length("payload" -> 'args') > 0;--> statement-breakpoint

UPDATE "telemetry_timeline"
SET "ref_json" = "sealant_withhold_process_args"("ref_json"),
  "summary" = "sealant_process_started_summary"("sealant_withhold_process_args"("ref_json"))
WHERE "kind" = 'processStarted'
  AND jsonb_typeof("ref_json" -> 'args') = 'array'
  AND jsonb_array_length("ref_json" -> 'args') > 0;--> statement-breakpoint

-- The run-exec queue's finished jobs held the same commands: an hour after completion, a week in
-- the dead-letter queue. The worker now deletes each job when it takes it; these are the copies
-- left from before. Jobs not yet taken stay, and go when a worker takes them. pg-boss creates its
-- schema at runtime, so a database it never ran against has nothing here.
DO $$
BEGIN
  IF to_regclass('pgboss.job') IS NOT NULL THEN
    DELETE FROM "pgboss"."job"
    WHERE ("name" = 'workspace-run-exec' AND "state" IN ('completed', 'failed', 'cancelled'))
      OR "name" = 'workspace-run-exec.dlq';
  END IF;
END
$$;
