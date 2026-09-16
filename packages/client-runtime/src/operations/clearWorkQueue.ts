import { WS_METHODS, type WorkItemId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { request } from "../rpc/client.ts";

export interface WorkQueueClearPreview {
  readonly tasks: ReadonlyArray<{ readonly id: WorkItemId; readonly revision: number }>;
  readonly active: number;
}

/** Read every page before changing tasks so shrinking results cannot skip a page. */
export const previewClearWorkQueue = Effect.fn("WorkQueue.previewClear")(function* (
  input: { archived?: boolean } = {},
) {
  const tasks = new Map<WorkItemId, { id: WorkItemId; revision: number }>();
  const active = new Set<WorkItemId>();
  const parents = new Map<WorkItemId, WorkItemId | null>();
  let total = Infinity;
  for (let offset = 0; offset < total; offset += 100) {
    const page = yield* request(WS_METHODS.workItemsList, {
      archived: input.archived ?? false,
      offset,
      limit: 100,
    });
    total = Math.min(total, page.total);
    if (!page.items.length) break;
    for (const task of page.items) {
      if (!!task.archivedAt !== !!input.archived) continue;
      parents.set(task.id, task.parentWorkItemId);
      if (["planning", "awaiting_approval", "running"].includes(task.status)) {
        active.add(task.id);
        tasks.delete(task.id);
      } else if (!active.has(task.id)) {
        tasks.set(task.id, { id: task.id, revision: task.revision });
      }
    }
  }
  // Delete archived children first so removing their parent cannot invalidate confirmed revisions.
  const ordered: WorkQueueClearPreview["tasks"][number][] = [];
  const visited = new Set<WorkItemId>();
  const visit = (id: WorkItemId) => {
    if (visited.has(id)) return;
    visited.add(id);
    const parent = parents.get(id);
    if (parent && tasks.has(parent)) visit(parent);
    ordered.push(tasks.get(id)!);
  };
  for (const id of tasks.keys()) visit(id);
  return {
    // eslint-disable-next-line unicorn/no-array-reverse -- Hermes does not support toReversed.
    tasks: input.archived ? [...ordered].reverse() : [...tasks.values()],
    active: active.size,
  } satisfies WorkQueueClearPreview;
});

/** Only clear confirmed revisions; stop and report any partial result. */
export const clearWorkQueue = Effect.fn("WorkQueue.clear")(function* (input: {
  readonly preview: WorkQueueClearPreview;
  readonly commandId: string;
  readonly archived?: boolean;
}) {
  let cleared = 0;
  for (const [index, task] of input.preview.tasks.entries()) {
    const command = {
      id: task.id,
      expectedRevision: task.revision,
      commandId: `${input.commandId}:${index}`,
    };
    const result = yield* (
      input.archived
        ? request(WS_METHODS.workItemsDelete, command)
        : request(WS_METHODS.workItemsMutate, { ...command, kind: "archive", archived: true })
    ).pipe(Effect.result);
    if (result._tag === "Failure") {
      const error = result.failure;
      return {
        cleared,
        error: error instanceof Error ? error.message : "Could not finish clearing the queue.",
      };
    }
    cleared++;
  }
  return { cleared, error: null };
});

export function clearWorkQueueDescription(
  preview: WorkQueueClearPreview,
  archived = false,
): string {
  if (archived)
    return `Permanently delete ${preview.tasks.length} archived tasks and their Work history across this environment? Filters do not limit this action. This cannot be undone. Linked threads, files, GitHub issues and Slack messages are kept. These sources will not be imported again automatically.`;
  return `Archive ${preview.tasks.length} tasks across all projects and queue views in this environment? Filters do not limit this action. ${preview.active} tasks planning, running, or awaiting approval will remain. You can restore tasks from Archived. Linked threads are kept.`;
}
