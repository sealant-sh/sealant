import { eq } from "drizzle-orm";

import type { DatabaseClient } from "../client.js";
import {
  packageResolutionCacheEntries,
  type NewPackageResolutionCacheEntry,
  type PackageResolutionCacheEntry,
} from "../schema.js";

export interface UpsertPackageResolutionCacheEntryInput {
  readonly query: string;
  readonly resolutionPayload: Record<string, unknown>;
  readonly expiresAt: Date;
}

export const createPackageResolutionCacheRepository = (client: DatabaseClient) => {
  const { db } = client;

  const getByQuery = async (query: string): Promise<PackageResolutionCacheEntry | null> => {
    const [entry] = await db
      .select()
      .from(packageResolutionCacheEntries)
      .where(eq(packageResolutionCacheEntries.query, query))
      .limit(1);

    if (entry === undefined) {
      return null;
    }

    const [updated] = await db
      .update(packageResolutionCacheEntries)
      .set({
        lastUsedAt: new Date(),
        hitCount: entry.hitCount + 1,
      })
      .where(eq(packageResolutionCacheEntries.query, query))
      .returning();

    return updated ?? entry;
  };

  const upsertByQuery = async (
    input: UpsertPackageResolutionCacheEntryInput,
  ): Promise<PackageResolutionCacheEntry> => {
    const now = new Date();

    const [entry] = await db
      .insert(packageResolutionCacheEntries)
      .values({
        query: input.query,
        resolutionPayload: input.resolutionPayload,
        fetchedAt: now,
        expiresAt: input.expiresAt,
        lastUsedAt: now,
        hitCount: 0,
      } satisfies NewPackageResolutionCacheEntry)
      .onConflictDoUpdate({
        target: packageResolutionCacheEntries.query,
        set: {
          resolutionPayload: input.resolutionPayload,
          fetchedAt: now,
          expiresAt: input.expiresAt,
          lastUsedAt: now,
        },
      })
      .returning();

    if (entry === undefined) {
      throw new Error("Failed to upsert package resolution cache entry.");
    }

    return entry;
  };

  return {
    getByQuery,
    upsertByQuery,
  };
};

export type PackageResolutionCacheRepository = ReturnType<
  typeof createPackageResolutionCacheRepository
>;
