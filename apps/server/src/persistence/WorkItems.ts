import {
  WorkItem,
  type WorkItemListInput,
  type WorkItemExternalResource,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const encodeItem = Schema.encodeSync(Schema.fromJsonString(WorkItem));
const decodeItem = Schema.decodeUnknownEffect(Schema.fromJsonString(WorkItem));

/** Uses the environment's existing SQLite transaction, including receipts and activity. */
export const makeWorkItemRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const get = Effect.fn("WorkItemRepository.get")(function* (id: string) {
    const rows = yield* sql<{
      record_json: string;
    }>`SELECT record_json FROM work_items WHERE id = ${id}`;
    return rows[0] ? yield* decodeItem(rows[0].record_json) : null;
  });
  const list = Effect.fn("WorkItemRepository.list")(function* (input: WorkItemListInput) {
    const conditions = [input.archived ? sql`archived_at IS NOT NULL` : sql`archived_at IS NULL`];
    if (input.agentThreadId !== undefined)
      conditions.push(sql`json_extract(record_json, '$.agentThreadId') = ${input.agentThreadId}`);
    if (input.projectId !== undefined) conditions.push(sql`project_id IS ${input.projectId}`);
    if (input.parentWorkItemId !== undefined)
      conditions.push(sql`parent_id IS ${input.parentWorkItemId}`);
    if (input.assignedAgent !== undefined)
      conditions.push(sql`assigned_agent IS ${input.assignedAgent}`);
    if (input.source !== undefined) conditions.push(sql`source = ${input.source}`);
    if (input.priority !== undefined) conditions.push(sql`priority = ${input.priority}`);
    if (input.statuses !== undefined)
      conditions.push(
        input.statuses.length ? sql`${sql.in("status", input.statuses)}` : sql`0 = 1`,
      );
    if (input.query?.trim()) {
      const query = input.query.trim().toLowerCase();
      conditions.push(sql`(instr(lower(title), ${query}) > 0 OR instr(lower(body), ${query}) > 0)`);
    }
    const where = sql.and(conditions);
    const rows = yield* sql<{
      record_json: string;
    }>`SELECT record_json FROM work_items WHERE ${where}
      ORDER BY updated_at DESC, id ASC LIMIT ${input.limit ?? 50} OFFSET ${input.offset ?? 0}`;
    const counts = yield* sql<{
      total: number;
    }>`SELECT count(*) AS total FROM work_items WHERE ${where}`;
    const items = yield* Effect.forEach(rows, (row) => decodeItem(row.record_json));
    return {
      items: items.map((item) => ({
        ...Struct.omit(item, ["body"]),
        bodyPreview: item.body.slice(0, 1000),
      })),
      total: counts[0]?.total ?? 0,
    };
  }, sql.withTransaction);
  const save = Effect.fn("WorkItemRepository.save")(function* (item: WorkItem) {
    yield* sql`INSERT INTO work_items ${sql.insert({
      id: item.id,
      project_id: item.projectId,
      parent_id: item.parentWorkItemId,
      assigned_agent: item.assignedAgent,
      source: item.source,
      status: item.status,
      priority: item.priority,
      title: item.title,
      body: item.body,
      archived_at: item.archivedAt,
      updated_at: item.updatedAt,
      revision: item.revision,
      record_json: encodeItem(item),
    })}
      ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id, parent_id=excluded.parent_id,
      assigned_agent=excluded.assigned_agent, status=excluded.status, priority=excluded.priority,
      title=excluded.title, body=excluded.body, archived_at=excluded.archived_at,
      updated_at=excluded.updated_at, revision=excluded.revision, record_json=excluded.record_json`;
    yield* sql`DELETE FROM work_item_resources WHERE work_item_id = ${item.id}`;
    for (const resource of item.resources) {
      yield* sql`INSERT INTO work_item_resources(source, namespace, external_id, work_item_id)
        VALUES (${resource.source}, ${resource.namespace}, ${resource.externalId}, ${item.id})`;
    }
  });
  const resourceOwner = Effect.fn("WorkItemRepository.resourceOwner")(function* (
    resource: WorkItemExternalResource,
  ) {
    const rows = yield* sql<{ work_item_id: string }>`SELECT work_item_id FROM work_item_resources
      WHERE source=${resource.source} AND namespace=${resource.namespace} AND external_id=${resource.externalId}`;
    return rows[0]?.work_item_id ?? null;
  });
  const referenceExists = Effect.fn("WorkItemRepository.referenceExists")(function* (
    projectId: string,
    threadId: string | null,
  ) {
    const projects =
      yield* sql`SELECT project_id FROM projection_projects WHERE project_id=${projectId} AND deleted_at IS NULL`;
    if (!projects.length) return false;
    if (threadId === null) return true;
    const threads = yield* sql`SELECT thread_id FROM projection_threads
      WHERE thread_id=${threadId} AND project_id=${projectId} AND deleted_at IS NULL`;
    return threads.length > 0;
  });
  const receipt = Effect.fn("WorkItemRepository.receipt")(function* (commandId: string) {
    const rows = yield* sql<{
      request_json: string;
      result_json: string;
    }>`SELECT request_json, result_json
      FROM work_item_commands WHERE command_id=${commandId}`;
    return rows[0]
      ? { request: rows[0].request_json, item: yield* decodeItem(rows[0].result_json) }
      : null;
  });
  const record = Effect.fn("WorkItemRepository.record")(function* (
    commandId: string,
    request: string,
    kind: string,
    item: WorkItem,
    metadata: string,
  ) {
    yield* sql`INSERT INTO work_item_commands(command_id, request_json, result_json, work_item_id, created_at)
      VALUES (${commandId}, ${request}, ${encodeItem(item)}, ${item.id}, ${item.updatedAt})`;
    yield* sql`INSERT INTO work_item_events(work_item_id, command_id, kind, revision, occurred_at, metadata_json)
      VALUES (${item.id}, ${commandId}, ${kind}, ${item.revision}, ${item.updatedAt}, ${metadata})`;
  });
  const children = Effect.fn("WorkItemRepository.children")(function* (id: string) {
    return yield* sql<{
      project_id: string | null;
    }>`SELECT project_id FROM work_items WHERE parent_id=${id}`;
  });
  const deletedReceipt = Effect.fn("WorkItemRepository.deletedReceipt")(function* (
    id: string,
    commandId: string,
  ) {
    return yield* sql<{
      id: string;
      revision: number;
      command_id: string;
    }>`SELECT * FROM deleted_work_items WHERE id=${id} OR command_id=${commandId}`;
  });
  const isDeleted = Effect.fn("WorkItemRepository.isDeleted")(function* (id: string) {
    return (yield* sql`SELECT id FROM deleted_work_items WHERE id=${id}`).length > 0;
  });
  const isResourceDeleted = Effect.fn("WorkItemRepository.isResourceDeleted")(function* (
    resource: WorkItemExternalResource,
  ) {
    return (
      (yield* sql`SELECT source FROM deleted_work_item_resources WHERE source=${resource.source} AND namespace=${resource.namespace} AND external_id=${resource.externalId}`)
        .length > 0
    );
  });
  const remove = Effect.fn("WorkItemRepository.remove")(function* (
    item: WorkItem,
    commandId: string,
  ) {
    yield* sql`INSERT INTO deleted_work_items(id,revision,command_id) VALUES (${item.id},${item.revision},${commandId})`;
    for (const resource of item.resources) {
      yield* sql`INSERT OR IGNORE INTO deleted_work_item_resources(source,namespace,external_id) VALUES (${resource.source},${resource.namespace},${resource.externalId})`;
    }
    // These records belong to Work. Agent threads, worktrees and external issues remain intact.
    for (const table of [
      "work_item_resources",
      "work_item_commands",
      "work_item_events",
      "work_item_activity",
      "work_item_plans",
      "work_item_plan_history",
      "work_item_reviews",
      "work_item_pull_requests",
      "work_item_executions",
    ]) {
      yield* sql`DELETE FROM ${sql(table)} WHERE work_item_id=${item.id}`;
    }
    yield* sql`DELETE FROM work_items WHERE id=${item.id}`;
  });
  const childItems = Effect.fn("WorkItemRepository.childItems")(function* (id: string) {
    const rows = yield* sql<{
      record_json: string;
    }>`SELECT record_json FROM work_items WHERE parent_id=${id}`;
    return yield* Effect.forEach(rows, (row) => decodeItem(row.record_json));
  });
  return {
    get,
    withUnavailableThread: Effect.fn("WorkItemRepository.withUnavailableThread")(function* (
      threadId?: string,
    ) {
      const rows = yield* sql<{ record_json: string }>`SELECT w.record_json FROM work_items w
        LEFT JOIN projection_threads t ON t.thread_id=json_extract(w.record_json,'$.agentThreadId')
        WHERE json_extract(w.record_json,'$.agentThreadId') IS NOT NULL
          AND (t.thread_id IS NULL OR t.deleted_at IS NOT NULL)
          AND ${threadId === undefined ? sql`1=1` : sql`json_extract(w.record_json,'$.agentThreadId')=${threadId}`}`;
      return yield* Effect.forEach(rows, (row) => decodeItem(row.record_json));
    }),
    hasActiveExecution: Effect.fn("WorkItemRepository.hasActiveExecution")(function* (id: string) {
      const rows = yield* sql`SELECT 1 FROM work_item_executions WHERE work_item_id=${id}
        AND status IN ('preparing','running','stopping','validating','publishing') LIMIT 1`;
      return rows.length > 0;
    }),
    deletedReceipt,
    isDeleted,
    isResourceDeleted,
    childItems,
    remove,
    list,
    save,
    receipt,
    record,
    resourceOwner,
    referenceExists,
    children,
    transaction: sql.withTransaction,
  };
});
