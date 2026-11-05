import { eq, sql } from "drizzle-orm";

import type { DB } from "../client.js";
import { nativePublications, nativePublicationConsumers } from "../schema/native-publications.js";

/** Force claim takeover without relying on wall-clock sleeps in database race tests. */
export const expireNativeClaim = (db: DB, id: string) =>
  db
    .update(nativePublications)
    .set({ claimUntil: sql`now() - interval '1 second'` })
    .where(eq(nativePublications.id, id));

/** Retention tests age only their own records in a disposable database. */
export const ageNativePublication = (db: DB, id: string) =>
  db
    .update(nativePublications)
    .set({ createdAt: sql`now() - interval '9 days'`, readyAt: sql`now() - interval '8 days'` })
    .where(eq(nativePublications.id, id));

/** Inject malformed serialized storage to exercise the production read boundary. */
export const corruptNativePublication = (db: DB, id: string, value: unknown) =>
  db.update(nativePublications).set({ publication: value }).where(eq(nativePublications.id, id));

/** Inject a malformed key without changing its digest, so accidental trust fails tests. */
export const corruptNativeKey = (db: DB, id: string) =>
  db
    .update(nativePublications)
    .set({ keyPayload: { nonsense: true } })
    .where(eq(nativePublications.id, id));

/** Inspect persisted pin outcomes without exporting editable native rows to application code. */
export const nativeConsumerRows = (db: DB, runId: string) =>
  db
    .select({
      state: nativePublicationConsumers.state,
      publicationId: nativePublicationConsumers.publicationId,
    })
    .from(nativePublicationConsumers)
    .where(eq(nativePublicationConsumers.runId, runId));
