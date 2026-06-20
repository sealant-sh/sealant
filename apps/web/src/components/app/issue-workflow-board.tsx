import { DragDropProvider, useDroppable, type DragEndEvent } from "@dnd-kit/react";
import { isSortable, useSortable } from "@dnd-kit/react/sortable";
import {
  createIssueWorkflowBoardOrder,
  createIssueWorkflowColumnDropId,
  DEFAULT_ISSUE_WORKFLOW_COLUMNS,
  getIssueWorkflowPriorityLabel,
  getIssueWorkflowStageLabel,
  moveIssueWorkflowBoardItem,
  parseIssueWorkflowColumnDropId,
  parseIssueWorkflowStage,
  type IssueWorkflowBoardColumn,
  type IssueWorkflowBoardOrder,
  type IssueWorkflowRecord,
  type IssueWorkflowStage,
} from "@sealant/issues";
import { cn } from "@sealant/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  ArrowUpRight,
  Cable,
  CircleDot,
  GitBranch,
  GripVertical,
  Loader2,
  RefreshCcw,
  Rows3,
  Workflow,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import {
  fetchLinearImportStatus,
  importLinearIssueWorkflows,
  type LinearImportResponse,
  type LinearImportStatus,
} from "@/lib/linear/linear-import-client";
import type { IssueWorkflowImportSummary } from "@/lib/navigation/issue-workflow-data";

interface IssueWorkflowBoardProps {
  readonly issues: readonly IssueWorkflowRecord[];
  readonly imports: readonly IssueWorkflowImportSummary[];
  readonly autoImportLinear?: boolean;
  readonly connectReturnTo?: string;
}

interface LinearImporterControlProps {
  readonly connectReturnTo: string;
  readonly errorMessage: string | null;
  readonly isImporting: boolean;
  readonly isStatusLoading: boolean;
  readonly latestImport: LinearImportResponse | null;
  readonly onImport: () => void;
  readonly status: LinearImportStatus | null;
}

export function IssueWorkflowBoard({
  autoImportLinear = false,
  connectReturnTo = "/issues",
  issues,
  imports,
}: IssueWorkflowBoardProps) {
  const canRunBrowserRequests = typeof window !== "undefined";
  const linearStatusQuery = useQuery({
    queryKey: ["issue-workflows", "linear", "status"],
    queryFn: fetchLinearImportStatus,
    enabled: canRunBrowserRequests,
    retry: false,
  });
  const linearAutoImportQuery = useQuery({
    queryKey: ["issue-workflows", "linear", "auto-import", connectReturnTo],
    queryFn: importLinearIssueWorkflows,
    enabled:
      canRunBrowserRequests && autoImportLinear && linearStatusQuery.data?.connected === true,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const linearImportMutation = useMutation({
    mutationFn: importLinearIssueWorkflows,
  });
  const latestLinearImport = linearImportMutation.data ?? linearAutoImportQuery.data ?? null;
  const displayedIssues = useMemo(
    () => mergeIssueRecords(issues, latestLinearImport?.issues ?? []),
    [issues, latestLinearImport],
  );
  const displayedImports = useMemo(
    () => createDisplayImportSummaries(imports, displayedIssues, latestLinearImport),
    [displayedIssues, imports, latestLinearImport],
  );
  const boardKey = useMemo(() => createBoardKey(displayedIssues), [displayedIssues]);
  const errorMessage =
    readErrorMessage(linearImportMutation.error) ??
    readErrorMessage(linearAutoImportQuery.error) ??
    readErrorMessage(linearStatusQuery.error);

  return (
    <IssueWorkflowBoardSurface
      key={boardKey}
      connectReturnTo={connectReturnTo}
      imports={displayedImports}
      issues={displayedIssues}
      linearErrorMessage={errorMessage}
      linearImporting={linearImportMutation.isPending || linearAutoImportQuery.isFetching}
      linearLatestImport={latestLinearImport}
      linearStatus={linearStatusQuery.data ?? null}
      linearStatusLoading={linearStatusQuery.isFetching}
      onImportLinear={() => {
        linearImportMutation.mutate();
      }}
    />
  );
}

function IssueWorkflowBoardSurface({
  connectReturnTo,
  imports,
  issues,
  linearErrorMessage,
  linearImporting,
  linearLatestImport,
  linearStatus,
  linearStatusLoading,
  onImportLinear,
}: {
  readonly connectReturnTo: string;
  readonly imports: readonly IssueWorkflowImportSummary[];
  readonly issues: readonly IssueWorkflowRecord[];
  readonly linearErrorMessage: string | null;
  readonly linearImporting: boolean;
  readonly linearLatestImport: LinearImportResponse | null;
  readonly linearStatus: LinearImportStatus | null;
  readonly linearStatusLoading: boolean;
  readonly onImportLinear: () => void;
}) {
  const [boardOrder, setBoardOrder] = useState(() => createIssueWorkflowBoardOrder(issues));
  const issueLookup = useMemo(() => createIssueLookup(issues), [issues]);
  const activeCount = countBoardItems(boardOrder, "active");
  const reviewCount = countBoardItems(boardOrder, "review");

  const handleDragEnd = (event: DragEndEvent) => {
    if (event.canceled) {
      return;
    }

    const { source, target } = event.operation;

    if (!isSortable(source)) {
      return;
    }

    const sourceStage = parseIssueWorkflowStage(source.initialGroup);
    const targetColumnStage = parseIssueWorkflowColumnDropId(target?.id);
    const targetStage = targetColumnStage ?? parseIssueWorkflowStage(source.group);

    if (sourceStage === null || targetStage === null) {
      return;
    }

    const issueId = String(source.id);

    setBoardOrder((currentOrder) => {
      const targetIndex =
        targetColumnStage === null ? source.index : countBoardItems(currentOrder, targetStage);

      return moveIssueWorkflowBoardItem(currentOrder, {
        issueId,
        sourceStage,
        targetStage,
        sourceIndex: source.initialIndex,
        targetIndex,
      });
    });
  };

  const resetBoard = () => {
    setBoardOrder(createIssueWorkflowBoardOrder(issues));
  };

  return (
    <div className="space-y-4">
      <div className="grid border border-border bg-border md:grid-cols-[1fr_minmax(18rem,24rem)]">
        <div className="bg-card p-4 sm:p-5">
          <p className="font-mono text-[0.68rem] tracking-[0.13em] text-muted-foreground uppercase">
            Imported issue workflows
          </p>
          <div className="mt-4 grid gap-px border border-border bg-border sm:grid-cols-3">
            {imports.map((summary) => (
              <div key={summary.provider} className="bg-card px-4 py-3">
                <p className="font-mono text-[0.62rem] tracking-[0.13em] text-muted-foreground uppercase">
                  {summary.label}
                </p>
                <p className="mt-2 text-lg font-semibold text-foreground">{summary.count}</p>
                <p className="mt-1 truncate text-xs text-muted-foreground">{summary.source}</p>
              </div>
            ))}
            <div className="bg-card px-4 py-3">
              <p className="font-mono text-[0.62rem] tracking-[0.13em] text-muted-foreground uppercase">
                In motion
              </p>
              <p className="mt-2 text-lg font-semibold text-foreground">
                {activeCount + reviewCount}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">Active and review lanes</p>
            </div>
          </div>
        </div>

        <div className="grid gap-4 border-t border-border bg-card p-4 md:border-t-0 md:border-l sm:p-5">
          <LinearImporterControl
            connectReturnTo={connectReturnTo}
            errorMessage={linearErrorMessage}
            isImporting={linearImporting}
            isStatusLoading={linearStatusLoading}
            latestImport={linearLatestImport}
            onImport={onImportLinear}
            status={linearStatus}
          />

          <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
            <div>
              <p className="font-mono text-[0.62rem] tracking-[0.13em] text-muted-foreground uppercase">
                Board state
              </p>
              <p className="mt-2 text-sm text-foreground">{activeCount + reviewCount} in motion</p>
            </div>
            <button
              type="button"
              onClick={resetBoard}
              className="inline-flex size-10 items-center justify-center border border-border text-muted-foreground transition-colors hover:border-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              aria-label="Reset issue workflow board"
              title="Reset issue workflow board"
            >
              <RefreshCcw className="size-4" aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>

      <DragDropProvider onDragEnd={handleDragEnd}>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
          {DEFAULT_ISSUE_WORKFLOW_COLUMNS.map((column) => (
            <IssueWorkflowColumn
              key={column.id}
              column={column}
              issues={getColumnIssues(boardOrder, column.id, issueLookup)}
            />
          ))}
        </div>
      </DragDropProvider>
    </div>
  );
}

function LinearImporterControl({
  connectReturnTo,
  errorMessage,
  isImporting,
  isStatusLoading,
  latestImport,
  onImport,
  status,
}: LinearImporterControlProps) {
  const configured = status?.configured ?? false;
  const connected = status?.connected ?? false;
  const statusLabel = getLinearImporterStatusLabel({
    configured,
    connected,
    isImporting,
    isStatusLoading,
    latestImport,
  });
  const connectHref = `/api/linear/connect?returnTo=${encodeURIComponent(connectReturnTo)}`;

  return (
    <div className="space-y-3">
      <div>
        <p className="font-mono text-[0.62rem] tracking-[0.13em] text-muted-foreground uppercase">
          Linear importer
        </p>
        <p className="mt-2 text-sm text-foreground">{statusLabel}</p>
      </div>

      <div className="grid gap-2">
        {isStatusLoading ? (
          <button
            type="button"
            disabled
            className="inline-flex h-10 items-center justify-center gap-2 border border-border px-3 font-mono text-[0.68rem] tracking-[0.12em] text-muted-foreground uppercase"
          >
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            Checking
          </button>
        ) : connected ? (
          <button
            type="button"
            onClick={onImport}
            disabled={isImporting}
            className="inline-flex h-10 items-center justify-center gap-2 border border-foreground bg-foreground px-3 font-mono text-[0.68rem] tracking-[0.12em] text-background uppercase transition-colors hover:bg-primary hover:text-primary-foreground disabled:cursor-not-allowed disabled:opacity-60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            {isImporting ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <Cable className="size-4" aria-hidden="true" />
            )}
            Import Linear
          </button>
        ) : configured ? (
          <a
            href={connectHref}
            className="inline-flex h-10 items-center justify-center gap-2 border border-foreground px-3 font-mono text-[0.68rem] tracking-[0.12em] text-foreground uppercase transition-colors hover:bg-foreground hover:text-background focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <Cable className="size-4" aria-hidden="true" />
            Connect Linear
          </a>
        ) : (
          <button
            type="button"
            disabled
            className="inline-flex h-10 items-center justify-center gap-2 border border-border px-3 font-mono text-[0.68rem] tracking-[0.12em] text-muted-foreground uppercase"
            title={status?.reason ?? "Linear OAuth is not configured."}
          >
            <Cable className="size-4" aria-hidden="true" />
            Configure Linear
          </button>
        )}
      </div>

      {errorMessage !== null ? (
        <p className="border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs leading-5 text-destructive">
          {errorMessage}
        </p>
      ) : null}
    </div>
  );
}

function IssueWorkflowColumn({
  column,
  issues,
}: {
  readonly column: IssueWorkflowBoardColumn;
  readonly issues: readonly IssueWorkflowRecord[];
}) {
  const { isDropTarget, ref } = useDroppable({
    id: createIssueWorkflowColumnDropId(column.id),
    type: "issue-column",
    accept: "issue",
  });

  return (
    <section
      ref={ref}
      className={cn(
        "min-h-[28rem] border border-border bg-card transition-colors",
        isDropTarget && "border-foreground bg-accent",
      )}
      aria-label={`${column.title} issue workflows`}
    >
      <div className="border-b border-border p-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="font-mono text-[0.72rem] tracking-[0.13em] text-foreground uppercase">
              {column.title}
            </h2>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">{column.description}</p>
          </div>
          <span className="inline-flex min-w-8 items-center justify-center border border-border px-2 py-1 font-mono text-[0.68rem] text-muted-foreground">
            {issues.length}
          </span>
        </div>
      </div>

      <div className="space-y-2 p-2">
        {issues.length === 0 ? (
          <div className="flex min-h-32 items-center justify-center border border-dashed border-border px-3 text-center text-xs leading-5 text-muted-foreground">
            Drop an issue workflow here.
          </div>
        ) : (
          issues.map((issue, index) => (
            <IssueWorkflowCard key={issue.id} issue={issue} index={index} stage={column.id} />
          ))
        )}
      </div>
    </section>
  );
}

function IssueWorkflowCard({
  issue,
  index,
  stage,
}: {
  readonly issue: IssueWorkflowRecord;
  readonly index: number;
  readonly stage: IssueWorkflowStage;
}) {
  const { handleRef, isDragSource, isDragging, isDropTarget, ref } = useSortable({
    id: issue.id,
    index,
    group: stage,
    type: "issue",
    accept: "issue",
  });

  const labels = issue.labels.slice(0, 3);
  const hiddenLabelCount = Math.max(0, issue.labels.length - labels.length);

  return (
    <article
      ref={ref}
      className={cn(
        "border border-border bg-background transition-[border-color,opacity,transform]",
        isDropTarget && "border-foreground",
        isDragSource && "border-foreground",
        isDragging && "opacity-70",
      )}
    >
      <div className="flex items-start gap-2 border-b border-border p-3">
        <button
          ref={handleRef}
          type="button"
          className="mt-0.5 inline-flex size-7 shrink-0 items-center justify-center border border-border text-muted-foreground transition-colors hover:border-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          aria-label={`Move ${issue.key}`}
          title="Move issue workflow"
        >
          <GripVertical className="size-4" aria-hidden="true" />
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[0.62rem] tracking-[0.12em] text-muted-foreground uppercase">
              {issue.key}
            </span>
            <ProviderBadge provider={issue.provider} />
            <span className="border border-border px-2 py-0.5 font-mono text-[0.58rem] tracking-[0.1em] text-muted-foreground uppercase">
              {getIssueWorkflowPriorityLabel(issue.priority)}
            </span>
          </div>
          <h3 className="mt-3 text-sm leading-5 font-semibold text-foreground">{issue.title}</h3>
        </div>

        {issue.url !== null ? (
          <a
            href={issue.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex size-7 shrink-0 items-center justify-center border border-border text-muted-foreground transition-colors hover:border-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            aria-label={`Open ${issue.key}`}
            title={`Open ${issue.key}`}
          >
            <ArrowUpRight className="size-4" aria-hidden="true" />
          </a>
        ) : null}
      </div>

      <div className="space-y-3 p-3">
        <div className="grid gap-2 text-xs text-muted-foreground">
          <MetaLine icon={<GitBranch className="size-3.5" aria-hidden="true" />}>
            {issue.repository.name}
          </MetaLine>
          <MetaLine icon={<CircleDot className="size-3.5" aria-hidden="true" />}>
            {getIssueWorkflowStageLabel(stage)} · {issue.assigneeName ?? "Unassigned"}
          </MetaLine>
          <MetaLine icon={<Rows3 className="size-3.5" aria-hidden="true" />}>
            Updated {formatIssueTimestamp(issue.updatedAt)}
          </MetaLine>
        </div>

        {labels.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {labels.map((label) => (
              <span
                key={label}
                className="border border-border px-2 py-1 font-mono text-[0.58rem] tracking-[0.1em] text-muted-foreground uppercase"
              >
                {label}
              </span>
            ))}
            {hiddenLabelCount > 0 ? (
              <span className="border border-border px-2 py-1 font-mono text-[0.58rem] tracking-[0.1em] text-muted-foreground uppercase">
                +{hiddenLabelCount}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    </article>
  );
}

function ProviderBadge({ provider }: { readonly provider: IssueWorkflowRecord["provider"] }) {
  return (
    <span className="inline-flex items-center gap-1 border border-border px-2 py-0.5 font-mono text-[0.58rem] tracking-[0.1em] text-muted-foreground uppercase">
      <Workflow className="size-3" aria-hidden="true" />
      {provider}
    </span>
  );
}

function MetaLine({ children, icon }: { readonly children: ReactNode; readonly icon: ReactNode }) {
  return (
    <p className="flex min-w-0 items-center gap-2">
      <span className="shrink-0 text-muted-foreground">{icon}</span>
      <span className="truncate">{children}</span>
    </p>
  );
}

function createIssueLookup(
  issues: readonly IssueWorkflowRecord[],
): ReadonlyMap<string, IssueWorkflowRecord> {
  return new Map(issues.map((issue) => [issue.id, issue]));
}

function getColumnIssues(
  order: IssueWorkflowBoardOrder,
  stage: IssueWorkflowStage,
  lookup: ReadonlyMap<string, IssueWorkflowRecord>,
): readonly IssueWorkflowRecord[] {
  const issues: IssueWorkflowRecord[] = [];

  for (const issueId of getBoardStageItems(order, stage)) {
    const issue = lookup.get(issueId);

    if (issue !== undefined) {
      issues.push(issue.stage === stage ? issue : { ...issue, stage });
    }
  }

  return issues;
}

function getBoardStageItems(
  order: IssueWorkflowBoardOrder,
  stage: IssueWorkflowStage,
): readonly string[] {
  switch (stage) {
    case "triage":
      return order.triage;
    case "ready":
      return order.ready;
    case "active":
      return order.active;
    case "review":
      return order.review;
    case "done":
      return order.done;
  }

  return order.done;
}

function countBoardItems(order: IssueWorkflowBoardOrder, stage: IssueWorkflowStage): number {
  return getBoardStageItems(order, stage).length;
}

function formatIssueTimestamp(value: string | null): string {
  if (value === null) {
    return "never";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "never";
  }

  return new Intl.DateTimeFormat("en", {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
  }).format(date);
}

function mergeIssueRecords(
  baseIssues: readonly IssueWorkflowRecord[],
  importedIssues: readonly IssueWorkflowRecord[],
): readonly IssueWorkflowRecord[] {
  if (importedIssues.length === 0) {
    return baseIssues;
  }

  const importedById = new Map(importedIssues.map((issue) => [issue.id, issue]));
  const seenIds = new Set<string>();
  const merged: IssueWorkflowRecord[] = [];

  for (const issue of baseIssues) {
    const importedIssue = importedById.get(issue.id);
    const nextIssue = importedIssue ?? issue;
    seenIds.add(nextIssue.id);
    merged.push(nextIssue);
  }

  for (const issue of importedIssues) {
    if (!seenIds.has(issue.id)) {
      merged.push(issue);
    }
  }

  return merged;
}

function createDisplayImportSummaries(
  imports: readonly IssueWorkflowImportSummary[],
  issues: readonly IssueWorkflowRecord[],
  latestLinearImport: LinearImportResponse | null,
): readonly IssueWorkflowImportSummary[] {
  return imports.map((summary) => ({
    ...summary,
    count: countProviderIssues(issues, summary.provider),
    source:
      summary.provider === "linear" && latestLinearImport !== null
        ? `OAuth import · ${latestLinearImport.pageCount} ${latestLinearImport.pageCount === 1 ? "page" : "pages"}`
        : summary.source,
  }));
}

function countProviderIssues(
  issues: readonly IssueWorkflowRecord[],
  provider: IssueWorkflowRecord["provider"],
): number {
  return issues.filter((issue) => issue.provider === provider).length;
}

function createBoardKey(issues: readonly IssueWorkflowRecord[]): string {
  return issues.map((issue) => `${issue.id}:${issue.source.importedAt}`).join("|");
}

function readErrorMessage(error: unknown): string | null {
  return error instanceof Error ? error.message : null;
}

function getLinearImporterStatusLabel({
  configured,
  connected,
  isImporting,
  isStatusLoading,
  latestImport,
}: {
  readonly configured: boolean;
  readonly connected: boolean;
  readonly isImporting: boolean;
  readonly isStatusLoading: boolean;
  readonly latestImport: LinearImportResponse | null;
}): string {
  if (isImporting) {
    return "Importing issues";
  }

  if (latestImport !== null) {
    return `${latestImport.issues.length} imported`;
  }

  if (isStatusLoading) {
    return "Checking OAuth";
  }

  if (!configured) {
    return "OAuth not configured";
  }

  return connected ? "OAuth connected" : "Not connected";
}
