import { eq, sql } from "drizzle-orm";
import { Effect } from "effect";

import type { DB } from "../client.js";
import { workspaceBuildJobs } from "../schema.js";
import { resourceDomains, resourceDomainMembers } from "../schema/resource-domains.js";

/** Seed fake authorization facts only in a disposable test database. */
export const seedImageScope = (db: DB, domainId: string, owner: string) =>
  db.transaction(() =>
    Effect.gen(function* () {
      yield* db.insert(resourceDomains).values({ id: domainId, key: `stage2b:${domainId}` });
      yield* db
        .insert(resourceDomainMembers)
        .values({ resourceDomainId: domainId, userId: owner, state: "member", version: 1 });
    }),
  );

/** A newer application decision revokes image reuse without changing existing pins. */
export const revokeImageScope = (db: DB, domainId: string) =>
  db
    .update(resourceDomainMembers)
    .set({ state: "revoked", version: 2 })
    .where(eq(resourceDomainMembers.resourceDomainId, domainId));

/** Take the job claim at a deterministic build boundary. */
export const takeWorkspaceJobClaim = (db: DB, id: string) =>
  db
    .update(workspaceBuildJobs)
    .set({ workerId: "successor", attemptCount: 2 })
    .where(eq(workspaceBuildJobs.id, id));

/** Inject serialized rows to exercise the real repository parser. */
export const corruptWorkspacePublication = (
  db: DB,
  table: "job" | "runtime",
  id: string,
  value: unknown,
) =>
  table === "job"
    ? db.execute(
        sql`update oci_image_build_jobs set publication = ${JSON.stringify(value)}::jsonb where id = ${id}`,
      )
    : db.execute(
        sql`update workspace_runtime_instances set publication = ${JSON.stringify(value)}::jsonb where run_id = ${id}`,
      );

/** Exercise each refusal using the persisted authorization state. */
export const setImageScopeState = (
  db: DB,
  domainId: string,
  state: "active" | "fenced" | "archived",
) => db.update(resourceDomains).set({ state }).where(eq(resourceDomains.id, domainId));
