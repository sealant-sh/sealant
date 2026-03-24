import { desc, eq } from "drizzle-orm";

import type { DatabaseClient } from "../client.js";
import {
  githubWebhookDeliveries,
  type GitHubWebhookDelivery,
  type GitHubWebhookDeliveryStatus,
  type NewGitHubWebhookDelivery,
} from "../schema.js";

export interface CreateGitHubWebhookDeliveryInput {
  readonly id: string;
  readonly deliveryId: string;
  readonly eventType: string;
  readonly action?: string;
  readonly installationExternalId?: string;
  readonly payload?: Record<string, unknown>;
  readonly receivedAt?: Date;
  readonly status?: GitHubWebhookDeliveryStatus;
  readonly processedAt?: Date;
  readonly errorMessage?: string;
}

const assertInserted = <T>(row: T | undefined, message: string): T => {
  if (row === undefined) {
    throw new Error(message);
  }

  return row;
};

export const createGitHubWebhookDeliveryRepository = (client: DatabaseClient) => {
  const { db } = client;

  const createWebhookDelivery = async (
    input: CreateGitHubWebhookDeliveryInput,
  ): Promise<GitHubWebhookDelivery> => {
    const [delivery] = await db
      .insert(githubWebhookDeliveries)
      .values({
        id: input.id,
        deliveryId: input.deliveryId,
        eventType: input.eventType,
        ...(input.action === undefined ? {} : { action: input.action }),
        ...(input.installationExternalId === undefined
          ? {}
          : { installationExternalId: input.installationExternalId }),
        ...(input.payload === undefined ? {} : { payload: input.payload }),
        ...(input.receivedAt === undefined ? {} : { receivedAt: input.receivedAt }),
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.processedAt === undefined ? {} : { processedAt: input.processedAt }),
        ...(input.errorMessage === undefined ? {} : { errorMessage: input.errorMessage }),
      } satisfies NewGitHubWebhookDelivery)
      .onConflictDoNothing({ target: githubWebhookDeliveries.deliveryId })
      .returning();

    if (delivery !== undefined) {
      return delivery;
    }

    const existing = await getWebhookDeliveryByDeliveryId(input.deliveryId);
    return assertInserted(existing, "Failed to create or retrieve GitHub webhook delivery.");
  };

  const getWebhookDeliveryByDeliveryId = async (
    deliveryId: string,
  ): Promise<GitHubWebhookDelivery | undefined> => {
    const [delivery] = await db
      .select()
      .from(githubWebhookDeliveries)
      .where(eq(githubWebhookDeliveries.deliveryId, deliveryId))
      .limit(1);

    return delivery;
  };

  const markWebhookDeliveryProcessed = async (input: {
    readonly deliveryId: string;
    readonly processedAt?: Date;
    readonly status?: Extract<GitHubWebhookDeliveryStatus, "processed" | "ignored">;
  }): Promise<GitHubWebhookDelivery | null> => {
    const [delivery] = await db
      .update(githubWebhookDeliveries)
      .set({
        status: input.status ?? "processed",
        processedAt: input.processedAt ?? new Date(),
        errorMessage: null,
      })
      .where(eq(githubWebhookDeliveries.deliveryId, input.deliveryId))
      .returning();

    return delivery ?? null;
  };

  const markWebhookDeliveryFailed = async (input: {
    readonly deliveryId: string;
    readonly errorMessage: string;
    readonly processedAt?: Date;
  }): Promise<GitHubWebhookDelivery | null> => {
    const [delivery] = await db
      .update(githubWebhookDeliveries)
      .set({
        status: "failed",
        errorMessage: input.errorMessage,
        processedAt: input.processedAt ?? new Date(),
      })
      .where(eq(githubWebhookDeliveries.deliveryId, input.deliveryId))
      .returning();

    return delivery ?? null;
  };

  const listWebhookDeliveries = async (limit = 100): Promise<readonly GitHubWebhookDelivery[]> => {
    return db
      .select()
      .from(githubWebhookDeliveries)
      .orderBy(desc(githubWebhookDeliveries.receivedAt))
      .limit(limit);
  };

  return {
    createWebhookDelivery,
    getWebhookDeliveryByDeliveryId,
    listWebhookDeliveries,
    markWebhookDeliveryFailed,
    markWebhookDeliveryProcessed,
  };
};

export type GitHubWebhookDeliveryRepository = ReturnType<
  typeof createGitHubWebhookDeliveryRepository
>;
