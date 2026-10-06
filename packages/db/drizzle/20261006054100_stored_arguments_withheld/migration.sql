ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "record_deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspace_sessions" ADD COLUMN IF NOT EXISTS "arg_count" integer;--> statement-breakpoint
ALTER TABLE "workspace_sessions" ADD COLUMN IF NOT EXISTS "arg_lengths" jsonb;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "runs_record_retention_idx" ON "runs" ("finished_at") WHERE "finished_at" is not null and "record_deleted_at" is null;--> statement-breakpoint
-- Sealant never stores the arguments a process or session was started with. They can carry
-- secrets: Mend has written secret files (base64) and session tokens through exec arguments, and
-- terminal follow-up prompts and `mend run -- env KEY=value` through session arguments. sealantd
-- publishes every process's arguments in `processStarted`, unredacted.
--
-- The rule, the same in TypeScript (`describeArguments` in @sealant/db, `withholdProcessArgs` in
-- @sealant/telemetry) and here: keep the executable, the argument count and each argument's length
-- in UTF-8 bytes, never the arguments.
--   - telemetry_events.payload and telemetry_timeline.ref_json (`processStarted`): `args` becomes
--     `[]`, `argCount` and `argLengths` are added, and the timeline summary becomes
--     `exec <executable> (<n> arguments not recorded)`.
--   - runs.command: the same, inside the jsonb.
--   - workspace_sessions.argv: only `argv[0]` stays; `arg_count` and `arg_lengths` describe the rest.
--
-- Triggers apply the rule to every writer, including an older worker during a rolling deploy.
-- `sealant_purge_stored_arguments()` applies it to rows already stored, and deletes the run-exec
-- jobs pg-boss kept; this migration calls it once. Run it again after restoring a dump taken
-- before this migration (`SELECT * FROM sealant_purge_stored_arguments();`), then VACUUM. Rows
-- already withheld are skipped, so this whole file can run again and changes nothing.
--
-- The purge leaves the old row versions in the table files until VACUUM marks their space free
-- (it does not zero it; only VACUUM FULL rewrites the files), and in the WAL until the next
-- checkpoint. `runMigrations` (@sealant/db/migrate) runs the VACUUMs after this migration commits. It rewrites stored rows, the
-- append-only log included, once: it needs the owner's approval before it runs against a database
-- that holds real records.

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

CREATE OR REPLACE FUNCTION "runs_withhold_command_args"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  NEW."command" := "sealant_withhold_process_args"(NEW."command");
  RETURN NEW;
END
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "runs_withhold_command_args" ON "runs";--> statement-breakpoint
CREATE TRIGGER "runs_withhold_command_args"
  BEFORE INSERT OR UPDATE OF "command" ON "runs"
  FOR EACH ROW WHEN (NEW."command" IS NOT NULL)
  EXECUTE FUNCTION "runs_withhold_command_args"();--> statement-breakpoint

CREATE OR REPLACE FUNCTION "workspace_sessions_withhold_args"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF jsonb_typeof(NEW."argv") = 'array' AND jsonb_array_length(NEW."argv") > 1 THEN
    NEW."arg_count" := jsonb_array_length(NEW."argv") - 1;
    NEW."arg_lengths" :=
      "sealant_withhold_process_args"(jsonb_build_object('args', NEW."argv" - 0)) -> 'argLengths';
    NEW."argv" := jsonb_build_array(NEW."argv" -> 0);
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "workspace_sessions_withhold_args" ON "workspace_sessions";--> statement-breakpoint
CREATE TRIGGER "workspace_sessions_withhold_args"
  BEFORE INSERT OR UPDATE OF "argv" ON "workspace_sessions"
  FOR EACH ROW EXECUTE FUNCTION "workspace_sessions_withhold_args"();--> statement-breakpoint

-- The purge of what is already stored. Each statement touches only rows still holding arguments.
CREATE OR REPLACE FUNCTION "sealant_purge_stored_arguments"()
  RETURNS TABLE ("target" text, "rows" bigint)
  LANGUAGE plpgsql AS $$
DECLARE
  "affected" bigint;
BEGIN
  UPDATE "telemetry_events"
  SET "payload" = "sealant_withhold_process_args"("payload")
  WHERE "payload_case" = 'processStarted'
    AND jsonb_typeof("payload" -> 'args') = 'array'
    AND jsonb_array_length("payload" -> 'args') > 0;
  GET DIAGNOSTICS "affected" = ROW_COUNT;
  "target" := 'telemetry_events'; "rows" := "affected"; RETURN NEXT;

  UPDATE "telemetry_timeline"
  SET "ref_json" = "sealant_withhold_process_args"("ref_json"),
    "summary" = "sealant_process_started_summary"("sealant_withhold_process_args"("ref_json"))
  WHERE "kind" = 'processStarted'
    AND jsonb_typeof("ref_json" -> 'args') = 'array'
    AND jsonb_array_length("ref_json" -> 'args') > 0;
  GET DIAGNOSTICS "affected" = ROW_COUNT;
  "target" := 'telemetry_timeline'; "rows" := "affected"; RETURN NEXT;

  UPDATE "runs"
  SET "command" = "sealant_withhold_process_args"("command")
  WHERE jsonb_typeof("command" -> 'args') = 'array'
    AND jsonb_array_length("command" -> 'args') > 0;
  GET DIAGNOSTICS "affected" = ROW_COUNT;
  "target" := 'runs'; "rows" := "affected"; RETURN NEXT;

  UPDATE "workspace_sessions"
  SET "arg_count" = jsonb_array_length("argv") - 1,
    "arg_lengths" =
      "sealant_withhold_process_args"(jsonb_build_object('args', "argv" - 0)) -> 'argLengths',
    "argv" = jsonb_build_array("argv" -> 0)
  WHERE jsonb_typeof("argv") = 'array' AND jsonb_array_length("argv") > 1;
  GET DIAGNOSTICS "affected" = ROW_COUNT;
  "target" := 'workspace_sessions'; "rows" := "affected"; RETURN NEXT;

  -- The run-exec queue's jobs held the same commands. The worker now deletes each job when it
  -- takes it, so a finished or dead-lettered copy, or one an older worker held when it was
  -- stopped (`active` for over ten minutes), is a leftover. Jobs not yet taken stay: they are
  -- deleted when a worker takes them. pg-boss creates its schema at runtime, so a database it
  -- never ran against has nothing here.
  "affected" := 0;
  IF to_regclass('pgboss.job') IS NOT NULL THEN
    EXECUTE $sql$
      DELETE FROM "pgboss"."job"
      WHERE "name" = 'workspace-run-exec.dlq'
        OR ("name" = 'workspace-run-exec' AND (
          "state" IN ('completed', 'failed', 'cancelled')
          OR ("state" = 'active' AND "started_on" < now() - interval '10 minutes')))
    $sql$;
    GET DIAGNOSTICS "affected" = ROW_COUNT;
  END IF;
  "target" := 'pgboss.job'; "rows" := "affected"; RETURN NEXT;
END
$$;--> statement-breakpoint

SELECT * FROM "sealant_purge_stored_arguments"();
