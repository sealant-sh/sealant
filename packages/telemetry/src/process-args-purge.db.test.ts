/**
 * The purge migration `processstarted_args_withheld` against a real, migrated Postgres. Gated on
 * SEALANT_TEST_DATABASE_URL (a disposable database; it writes rows under fresh ids and removes
 * them).
 *
 * It puts the database back to how it was before the migration (the triggers dropped), stores
 * rows the way an older control plane did, with a secret in a process's arguments, then runs the
 * migration file as shipped and checks that:
 *   - the secret is in no row of any table;
 *   - each rewritten row says what TypeScript would have stored (ingest == purge);
 *   - running the file again changes nothing;
 *   - a writer that still sends arguments has them withheld by the database.
 *
 *   SEALANT_TEST_DATABASE_URL=postgresql://… pnpm exec vitest run src/process-args-purge.db.test.ts
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import {
  makeSealantDBLayer,
  runs,
  SealantDB,
  telemetryEvents,
  telemetryTimeline,
  user,
  workspaces,
  type NewTelemetryEvent,
} from "@sealant/db";
import { eq, sql } from "drizzle-orm";
import { Effect } from "effect";
import { afterAll, describe, expect, it } from "vitest";

import { deriveTimelineRow, eventRowToNormalized, withholdProcessArgs } from "./normalize.js";

const DATABASE_URL = process.env.SEALANT_TEST_DATABASE_URL;

// @sealant/db resolves to its src/index.ts; the migrations sit beside src/.
const MIGRATION = new URL(
  "../drizzle/20261006015440_processstarted_args_withheld/migration.sql",
  pathToFileURL(createRequire(import.meta.url).resolve("@sealant/db")),
);

/** A secret file's bytes, base64, the way Mend's delivery wrote them through `sh -c`. */
const SECRET = `aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/${randomUUID()}`;
const SECRET_B64 = Buffer.from(SECRET).toString("base64");
const SCRIPT = `printf '%s' '${SECRET_B64}' | base64 -d > ~/.aws/credentials.mend-secret-part-0`;

const runMigration = (statements: readonly string[]) =>
  Effect.gen(function* () {
    const handle = yield* SealantDB;
    for (const statement of statements) {
      yield* handle.execute(sql.raw(statement));
    }
  });

/** Every table, in every schema, that has a row whose text holds `needle`. */
const tablesHolding = (needle: string) =>
  Effect.gen(function* () {
    const handle = yield* SealantDB;
    const tables = yield* handle.execute<{ schema: string; name: string }>(sql`
      SELECT table_schema AS schema, table_name AS name FROM information_schema.tables
      WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog', 'information_schema')`);
    const holding: string[] = [];
    for (const table of tables) {
      const found = yield* handle.execute<{ hit: boolean }>(
        sql`SELECT EXISTS (SELECT 1 FROM ${sql.identifier(table.schema)}.${sql.identifier(table.name)} AS t WHERE t::text LIKE ${`%${needle}%`}) AS hit`,
      );
      if (found[0]?.hit === true) holding.push(`${table.schema}.${table.name}`);
    }
    return holding;
  });

describe.skipIf(DATABASE_URL === undefined)("the process-arguments purge (Postgres)", () => {
  const db = makeSealantDBLayer(DATABASE_URL!);
  const suffix = randomUUID();
  const userId = `user_purge_${suffix}`;
  const workspaceId = `ws_purge_${suffix}`;
  const runId = `run_purge_${suffix}`;
  const runtimeId = `rt_purge_${suffix}`;
  const run = <A, E>(effect: Effect.Effect<A, E, SealantDB>) =>
    Effect.runPromise(effect.pipe(Effect.provide(db)));

  const migrationStatements = async (): Promise<readonly string[]> =>
    (await readFile(MIGRATION, "utf8"))
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0);

  const event = (sequence: bigint, payloadCase: string, payload: Record<string, unknown>) =>
    ({
      eventId: `evt_purge_${suffix}_${sequence.toString()}`,
      runId,
      runtimeId,
      schemaVersion: 1,
      sequence,
      observedAt: sequence,
      monotonicTimestamp: sequence,
      captureMethod: 1,
      confidence: 1,
      payloadCase,
      payload,
    }) satisfies NewTelemetryEvent;

  /** Stores an event and its timeline row exactly as an older control plane did: args and all. */
  const storeLegacy = (
    sequence: bigint,
    payloadCase: string,
    payload: Record<string, unknown>,
    summary: string,
  ) =>
    Effect.gen(function* () {
      const handle = yield* SealantDB;
      yield* handle.insert(telemetryEvents).values(event(sequence, payloadCase, payload));
      yield* handle.insert(telemetryTimeline).values({
        eventId: `evt_purge_${suffix}_${sequence.toString()}`,
        runId,
        sequence,
        kind: payloadCase,
        occurredAt: sequence,
        summary,
        refJson: payload,
      });
    });

  const readRun = Effect.gen(function* () {
    const handle = yield* SealantDB;
    const events = yield* handle
      .select()
      .from(telemetryEvents)
      .where(eq(telemetryEvents.runId, runId))
      .orderBy(telemetryEvents.sequence);
    const timeline = yield* handle
      .select()
      .from(telemetryTimeline)
      .where(eq(telemetryTimeline.runId, runId))
      .orderBy(telemetryTimeline.sequence);
    return { events, timeline };
  });

  afterAll(async () => {
    // Whatever happened above, the database leaves with the migration applied.
    await run(runMigration(await migrationStatements()));
    await run(
      Effect.gen(function* () {
        const handle = yield* SealantDB;
        yield* handle.delete(workspaces).where(eq(workspaces.id, workspaceId)); // cascades runs -> telemetry_*
        yield* handle.delete(user).where(eq(user.id, userId));
      }),
    );
  });

  it("withholds the arguments already stored, the same way ingest does, and only once", async () => {
    const statements = await migrationStatements();
    const legacyStarted = {
      $typeName: "sealant.v1.ProcessStarted",
      pid: 7,
      pgid: 7,
      pidfd: true,
      executable: "sh",
      args: ["-c", SCRIPT, "ünï"],
      cwd: "/home/alice",
      startedAt: "1751846400000000",
    };
    const legacySummary = `exec sh -c ${SCRIPT} ünï`;

    await run(
      Effect.gen(function* () {
        const handle = yield* SealantDB;
        const now = new Date();
        yield* handle.insert(user).values({
          id: userId,
          name: "purge-it",
          email: `${userId}@example.test`,
          createdAt: now,
          updatedAt: now,
        });
        yield* handle
          .insert(workspaces)
          .values({ id: workspaceId, ownerUserId: userId, createdAt: now, updatedAt: now });
        yield* handle.insert(runs).values({
          id: runId,
          workspaceId,
          ownerUserId: userId,
          harnessId: "exec",
          createdAt: now,
          updatedAt: now,
        });

        // The database as it was before the migration: no triggers.
        yield* handle.execute(
          sql.raw(`DROP TRIGGER IF EXISTS "telemetry_events_withhold_process_args" ON "telemetry_events";
            DROP TRIGGER IF EXISTS "telemetry_timeline_withhold_process_args" ON "telemetry_timeline"`),
        );
        yield* storeLegacy(1n, "processStarted", legacyStarted, legacySummary);
        yield* storeLegacy(
          2n,
          "processStarted",
          { executable: "bash", args: [], cwd: "/" },
          "exec bash",
        );
        yield* storeLegacy(
          3n,
          "processStarted",
          { executable: "true", args: ["x"], cwd: "/" },
          "exec true x",
        );
        yield* storeLegacy(4n, "processExited", { exitCode: 0, reason: 1 }, "exit code=0 reason=1");
      }),
    );
    expect(await run(tablesHolding(SECRET_B64))).toEqual([
      "public.telemetry_events",
      "public.telemetry_timeline",
    ]);

    await run(runMigration(statements));
    const purged = await run(readRun);

    // No trace of the secret anywhere in the database.
    expect(await run(tablesHolding(SECRET_B64))).toEqual([]);
    expect(await run(tablesHolding("mend-secret-part-"))).toEqual([]);

    // Each rewritten row is what ingest stores today: the purge and TypeScript agree.
    const [started, bare, single, exited] = purged.events;
    expect(started?.payload).toEqual(withholdProcessArgs(legacyStarted));
    expect(started?.payload).toMatchObject({
      args: [],
      argCount: 3,
      argLengths: [2, Buffer.byteLength(SCRIPT), Buffer.byteLength("ünï")],
      executable: "sh",
      cwd: "/home/alice",
      pid: 7,
    });
    expect(bare?.payload).toEqual({ executable: "bash", args: [], cwd: "/" });
    expect(single?.payload).toMatchObject({ args: [], argCount: 1, argLengths: [1] });
    expect(exited?.payload).toEqual({ exitCode: 0, reason: 1 });
    expect(purged.timeline.map((row) => row.summary)).toEqual([
      "exec sh (3 arguments not recorded)",
      "exec bash",
      "exec true (1 argument not recorded)",
      "exit code=0 reason=1",
    ]);
    for (const [index, row] of purged.events.entries()) {
      const rebuilt = deriveTimelineRow(eventRowToNormalized(row), runId);
      expect(purged.timeline[index]?.summary).toBe(rebuilt.summary);
      expect(purged.timeline[index]?.refJson).toEqual(rebuilt.refJson);
    }

    // Idempotent: the file runs again and changes nothing.
    await run(runMigration(statements));
    expect(await run(readRun)).toEqual(purged);
  });

  it("withholds the arguments a writer still sends, on the way in", async () => {
    await run(
      Effect.gen(function* () {
        yield* storeLegacy(
          10n,
          "processStarted",
          { executable: "sh", args: ["-c", SCRIPT], cwd: "/" },
          `exec sh -c ${SCRIPT}`,
        );
      }),
    );
    const { events, timeline } = await run(readRun);
    const stored = events.find((row) => row.sequence === 10n);
    const entry = timeline.find((row) => row.sequence === 10n);

    expect(stored?.payload).toEqual({
      executable: "sh",
      args: [],
      argCount: 2,
      argLengths: [2, Buffer.byteLength(SCRIPT)],
      cwd: "/",
    });
    expect(entry?.refJson).toEqual(stored?.payload);
    expect(entry?.summary).toBe("exec sh (2 arguments not recorded)");
    expect(await run(tablesHolding(SECRET_B64))).toEqual([]);
  });
});
