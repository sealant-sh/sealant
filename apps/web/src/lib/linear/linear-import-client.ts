import { z } from "zod";

const issueWorkflowProviderSchema = z.enum(["github", "linear"]);
const issueWorkflowStageSchema = z.enum(["triage", "ready", "active", "review", "done"]);
const issueWorkflowPrioritySchema = z.enum(["none", "low", "medium", "high", "urgent"]);
const issueWorkflowStateSchema = z.enum(["open", "closed"]);

const nullableStringSchema = z.string().nullable();

const issueWorkflowRecordSchema = z.object({
  id: z.string(),
  provider: issueWorkflowProviderSchema,
  externalId: z.string(),
  key: z.string(),
  number: z.number().nullable(),
  title: z.string(),
  description: nullableStringSchema,
  state: issueWorkflowStateSchema,
  stage: issueWorkflowStageSchema,
  priority: issueWorkflowPrioritySchema,
  labels: z.array(z.string()),
  repository: z.object({
    id: nullableStringSchema,
    name: z.string(),
    owner: nullableStringSchema,
    url: nullableStringSchema,
  }),
  teamName: nullableStringSchema,
  assigneeName: nullableStringSchema,
  authorName: nullableStringSchema,
  commentCount: z.number(),
  createdAt: nullableStringSchema,
  updatedAt: nullableStringSchema,
  closedAt: nullableStringSchema,
  url: nullableStringSchema,
  source: z.object({
    provider: issueWorkflowProviderSchema,
    externalId: z.string(),
    key: z.string(),
    url: nullableStringSchema,
    importedAt: z.string(),
  }),
});

const linearImportStatusSchema = z.object({
  configured: z.boolean(),
  connected: z.boolean(),
  expiresAt: nullableStringSchema,
  reason: nullableStringSchema,
  scopes: z.array(z.string()),
});

const linearImportResponseSchema = z.object({
  provider: z.literal("linear"),
  importedAt: z.string(),
  issues: z.array(issueWorkflowRecordSchema),
  pageCount: z.number(),
  connected: z.literal(true),
});

const apiErrorSchema = z.object({
  error: z.string(),
});

export type LinearImportStatus = z.infer<typeof linearImportStatusSchema>;
export type LinearImportResponse = z.infer<typeof linearImportResponseSchema>;

export async function fetchLinearImportStatus(): Promise<LinearImportStatus> {
  const response = await fetch("/api/linear/status", {
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
    },
  });

  const payload: unknown = await response.json();

  if (!response.ok) {
    throw new Error(readApiError(payload) ?? "Unable to read Linear connection status.");
  }

  return linearImportStatusSchema.parse(payload);
}

export async function importLinearIssueWorkflows(): Promise<LinearImportResponse> {
  const response = await fetch("/api/linear/import", {
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
    },
    method: "POST",
  });

  const payload: unknown = await response.json();

  if (!response.ok) {
    throw new Error(readApiError(payload) ?? "Unable to import Linear issue workflows.");
  }

  return linearImportResponseSchema.parse(payload);
}

export async function disconnectLinearIssueImporter(): Promise<void> {
  const response = await fetch("/api/linear/disconnect", {
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
    },
    method: "POST",
  });

  if (!response.ok) {
    const payload: unknown = await response.json();
    throw new Error(readApiError(payload) ?? "Unable to disconnect Linear.");
  }
}

function readApiError(payload: unknown): string | null {
  const parsed = apiErrorSchema.safeParse(payload);

  return parsed.success ? parsed.data.error : null;
}
