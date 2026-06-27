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
    <div className="space-y-8">
      <div className="grid overflow-hidden rounded-2xl border border-border bg-card shadow-[var(--shadow-sm)] md:grid-cols-[1fr_minmax(18rem,24rem)]">
        <div className="p-6 sm:p-8">
          <p className="ev-eyebrow">Imported issue workflows</p>
          <dl className="mt-5 grid gap-x-8 gap-y-6 sm:grid-cols-3">
            {imports.map((summary) => (
              <div key={summary.provider}>
                <dt className="ev-eyebrow">{summary.label}</dt>
                <dd className="mt-2 font-mono text-2xl text-foreground">{summary.count}</dd>
                <p className="mt-1.5 truncate font-mono text-xs text-faint">{summary.source}</p>
              </div>
            ))}
            <div>
              <dt className="ev-eyebrow">In motion</dt>
              <dd className="mt-2 font-mono text-2xl text-foreground">
                {activeCount + reviewCount}
              </dd>
              <p className="mt-1.5 font-mono text-xs text-faint">Active and review lanes</p>
            </div>
          </dl>
        </div>

        <div className="grid gap-5 border-t border-rule-faint bg-background/40 p-6 sm:p-8 md:border-t-0 md:border-l">
          <LinearImporterControl
            connectReturnTo={connectReturnTo}
            errorMessage={linearErrorMessage}
            isImporting={linearImporting}
            isStatusLoading={linearStatusLoading}
            latestImport={linearLatestImport}
            onImport={onImportLinear}
            status={linearStatus}
          />

          <div className="flex items-center justify-between gap-3 border-t border-rule-faint pt-5">
            <div>
              <p className="ev-eyebrow">Board state</p>
              <p className="mt-2 text-sm text-foreground">{activeCount + reviewCount} in motion</p>
            </div>
            <button
              type="button"
              onClick={resetBoard}
              className="inline-flex size-10 items-center justify-center rounded-lg border border-border bg-card text-muted-foreground shadow-[var(--shadow-xs)] transition-[transform,box-shadow,border-color,color] duration-200 hover:-translate-y-0.5 hover:border-input hover:text-foreground hover:shadow-[var(--shadow-sm)] focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              aria-label="Reset issue workflow board"
              title="Reset issue workflow board"
            >
              <RefreshCcw className="size-4" aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>

      <DragDropProvider onDragEnd={handleDragEnd}>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
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
        <p className="ev-eyebrow">Linear importer</p>
        <p className="mt-2 text-sm text-foreground">{statusLabel}</p>
      </div>

      <div className="grid gap-2">
        {isStatusLoading ? (
          <button
            type="button"
            disabled
            className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-border px-3 text-sm text-muted-foreground"
          >
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            Checking
          </button>
        ) : connected ? (
          <button
            type="button"
            onClick={onImport}
            disabled={isImporting}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground shadow-[var(--shadow-cobalt)] transition-[transform,box-shadow,background-color] duration-200 hover:-translate-y-0.5 hover:bg-[var(--primary-hover)] disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-y-0 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
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
            className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-input bg-card px-3 text-sm text-foreground shadow-[var(--shadow-xs)] transition-[transform,box-shadow,border-color] duration-200 hover:-translate-y-0.5 hover:border-input hover:shadow-[var(--shadow-sm)] focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <Cable className="size-4" aria-hidden="true" />
            Connect Linear
          </a>
        ) : (
          <button
            type="button"
            disabled
            className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-border px-3 text-sm text-muted-foreground"
            title={status?.reason ?? "Linear OAuth is not configured."}
          >
            <Cable className="size-4" aria-hidden="true" />
            Configure Linear
          </button>
        )}
      </div>

      {errorMessage !== null ? (
        <p className="border-l-2 border-[var(--sw-red)] pl-3 text-xs leading-5 text-danger">
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
        "min-h-[28rem] rounded-2xl border border-border bg-card shadow-[var(--shadow-sm)] transition-[box-shadow,border-color,background-color] duration-200",
        isDropTarget && "border-primary bg-accent shadow-[var(--shadow-cobalt)]",
      )}
      aria-label={`${column.title} issue workflows`}
    >
      <div className="border-b border-rule-faint px-4 py-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-medium text-foreground">{column.title}</h2>
            <p className="mt-1.5 text-xs leading-5 text-muted-foreground">{column.description}</p>
          </div>
          <span className="font-mono text-xs text-faint">{issues.length}</span>
        </div>
      </div>

      <div className="space-y-3 p-3">
        {issues.length === 0 ? (
          <div className="flex min-h-32 items-center justify-center rounded-xl border border-dashed border-border px-3 text-center font-mono text-xs leading-5 text-faint">
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
        "rounded-xl border border-border bg-popover shadow-[var(--shadow-xs)] transition-[border-color,box-shadow,opacity,transform] duration-200 hover:-translate-y-0.5 hover:shadow-[var(--shadow-md)]",
        isDropTarget && "border-primary",
        isDragSource && "border-primary shadow-[var(--shadow-cobalt)]",
        isDragging && "opacity-70",
      )}
    >
      <div className="flex items-start gap-2 border-b border-rule-faint p-3.5">
        <button
          ref={handleRef}
          type="button"
          className="mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          aria-label={`Move ${issue.key}`}
          title="Move issue workflow"
        >
          <GripVertical className="size-4" aria-hidden="true" />
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-xs text-faint">
            <span className="text-ink-2">{issue.key}</span>
            <ProviderBadge provider={issue.provider} />
            <span>{getIssueWorkflowPriorityLabel(issue.priority)}</span>
          </div>
          <h3 className="mt-3 text-sm leading-5 font-medium text-foreground">{issue.title}</h3>
        </div>

        {issue.url !== null ? (
          <a
            href={issue.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            aria-label={`Open ${issue.key}`}
            title={`Open ${issue.key}`}
          >
            <ArrowUpRight className="size-4" aria-hidden="true" />
          </a>
        ) : null}
      </div>

      <div className="space-y-3 p-3.5">
        <div className="grid gap-2 font-mono text-xs text-muted-foreground">
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
          <div className="flex flex-wrap gap-x-2 gap-y-1 font-mono text-xs text-faint">
            {labels.map((label) => (
              <span key={label}>{label}</span>
            ))}
            {hiddenLabelCount > 0 ? <span>+{hiddenLabelCount}</span> : null}
          </div>
        ) : null}
      </div>
    </article>
  );
}

function ProviderBadge({ provider }: { readonly provider: IssueWorkflowRecord["provider"] }) {
  return (
    <span className="inline-flex items-center gap-1">
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
