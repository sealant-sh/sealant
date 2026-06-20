import type {
  IssueWorkflowBoardMovement,
  IssueWorkflowBoardOrder,
  IssueWorkflowRecord,
  IssueWorkflowStage,
} from "./types.js";

export function createIssueWorkflowBoardOrder(
  issues: readonly IssueWorkflowRecord[],
): IssueWorkflowBoardOrder {
  const triage: string[] = [];
  const ready: string[] = [];
  const active: string[] = [];
  const review: string[] = [];
  const done: string[] = [];

  for (const issue of issues) {
    switch (issue.stage) {
      case "triage":
        triage.push(issue.id);
        break;
      case "ready":
        ready.push(issue.id);
        break;
      case "active":
        active.push(issue.id);
        break;
      case "review":
        review.push(issue.id);
        break;
      case "done":
        done.push(issue.id);
        break;
    }
  }

  return { triage, ready, active, review, done };
}

export function moveIssueWorkflowBoardItem(
  order: IssueWorkflowBoardOrder,
  movement: IssueWorkflowBoardMovement,
): IssueWorkflowBoardOrder {
  const sourceItems = [...getStageItems(order, movement.sourceStage)];
  const sourceIndex = resolveSourceIndex(sourceItems, movement.issueId, movement.sourceIndex);

  if (sourceIndex === null) {
    return order;
  }

  const removed = sourceItems.splice(sourceIndex, 1)[0];

  if (removed === undefined) {
    return order;
  }

  if (movement.sourceStage === movement.targetStage) {
    const targetIndex = clampIndex(movement.targetIndex, sourceItems.length);
    sourceItems.splice(targetIndex, 0, removed);

    return withStageItems(order, movement.sourceStage, sourceItems);
  }

  const targetItems = [...getStageItems(order, movement.targetStage)];
  const targetIndex = clampIndex(movement.targetIndex, targetItems.length);
  targetItems.splice(targetIndex, 0, removed);

  return withStageItems(
    withStageItems(order, movement.sourceStage, sourceItems),
    movement.targetStage,
    targetItems,
  );
}

function getStageItems(
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
}

function withStageItems(
  order: IssueWorkflowBoardOrder,
  stage: IssueWorkflowStage,
  items: readonly string[],
): IssueWorkflowBoardOrder {
  switch (stage) {
    case "triage":
      return { ...order, triage: items };
    case "ready":
      return { ...order, ready: items };
    case "active":
      return { ...order, active: items };
    case "review":
      return { ...order, review: items };
    case "done":
      return { ...order, done: items };
  }
}

function resolveSourceIndex(
  items: readonly string[],
  issueId: string,
  preferredIndex: number,
): number | null {
  if (items[preferredIndex] === issueId) {
    return preferredIndex;
  }

  const foundIndex = items.indexOf(issueId);

  return foundIndex === -1 ? null : foundIndex;
}

function clampIndex(index: number, maxLength: number): number {
  if (index < 0) {
    return 0;
  }

  if (index > maxLength) {
    return maxLength;
  }

  return index;
}
