import { z } from "zod";

import type { BoatSecret } from "../runtime/boat/config.js";
import { BoatProofError, type BoatProofInventory } from "./boat-live-check.js";

/** Read-only account census and negative authentication controls. No response body is logged. */
export class BoatProofProvider {
  constructor(
    private readonly credential: BoatSecret,
    private readonly base = "https://boat.dev/api/v1",
  ) {}
  private async read(path: string, auth: "account" | "none" | "wrong") {
    return fetch(`${this.base}${path}`, {
      headers:
        auth === "none"
          ? {}
          : {
              authorization: `Bearer ${auth === "account" ? this.credential.reveal() : "invalid-boat-proof-key"}`,
            },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  }
  async inventory(): Promise<BoatProofInventory> {
    const sandboxes: string[] = [];
    const cursors = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query = new URLSearchParams({ limit: "200", ...(cursor === null ? {} : { cursor }) });
      const response = await this.read(`/sandboxes?${query}`, "account");
      if (!response.ok) {
        await response.body?.cancel();
        throw new BoatProofError("inventory-unavailable");
      }
      const page = z
        .object({
          ok: z.literal(true),
          sandboxes: z.array(z.object({ id: z.string() })),
          pageInfo: z.object({
            nextCursor: z.string().nullable(),
            hasMore: z.boolean(),
            limit: z.number().int(),
          }),
        })
        .parse(await response.json());
      sandboxes.push(...page.sandboxes.map((s) => s.id));
      cursor = page.pageInfo.nextCursor;
      if (
        page.pageInfo.hasMore !== (cursor !== null) ||
        pages++ >= 100 ||
        (cursor !== null && cursors.has(cursor))
      )
        throw new BoatProofError("inventory-pagination");
      if (cursor !== null) cursors.add(cursor);
    } while (cursor !== null);
    const response = await this.read("/saved-snapshots?org=personal", "account");
    if (!response.ok) {
      await response.body?.cancel();
      throw new BoatProofError("snapshot-inventory-unavailable");
    }
    const saved = z
      .object({
        ok: z.literal(true),
        snapshots: z.array(z.object({ name: z.string() })).max(10000),
      })
      .parse(await response.json());
    return {
      sandboxes: [...new Set(sandboxes)],
      snapshots: saved.snapshots.map((s) => s.name),
      pages,
    };
  }
  async privacy(name: string) {
    const observations = [];
    for (const path of [
      "/saved-snapshots?org=personal",
      `/saved-snapshots/${encodeURIComponent(name)}`,
    ]) {
      for (const auth of ["none", "wrong"] as const) {
        const response = await this.read(path, auth);
        await response.body?.cancel();
        observations.push({
          endpoint: path.includes("?") ? "list" : "snapshot",
          auth,
          status: response.status,
          result:
            response.status === 401 || response.status === 403
              ? "refused"
              : response.ok
                ? "accessible"
                : "unknown",
        });
      }
    }
    const response = await this.read(`/saved-snapshots/${encodeURIComponent(name)}`, "account");
    if (!response.ok) {
      await response.body?.cancel();
      throw new BoatProofError("privacy-snapshot-unavailable");
    }
    const snapshot = z
      .object({
        snapshot: z.object({
          visibility: z.string().optional(),
          isPublic: z.boolean().optional(),
          public: z.boolean().optional(),
        }),
      })
      .parse(await response.json()).snapshot;
    return {
      observations,
      apiVisibility: snapshot,
      conclusion: observations.every((o) => o.result === "refused")
        ? "negative-auth-refused; cross-account privacy unknown"
        : "unknown-or-accessible",
    };
  }
}
