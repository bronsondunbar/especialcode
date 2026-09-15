import {
  WorkActivityEvent,
  WorkActivityInput,
  WorkActivityError,
  WorkItemId,
  ThreadId,
  type WorkItemSource,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { makeWorkActivityRepository, activityId } from "../persistence/WorkActivity.ts";
import { WorkItemService } from "./WorkItemService.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
const decodeInput = Schema.decodeUnknownEffect(WorkActivityInput);
const decodeEvent = Schema.decodeUnknownEffect(Schema.fromJsonString(WorkActivityEvent));
const decodeMetadata = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      message: Schema.optionalKey(Schema.NullOr(Schema.String)),
      previousStatus: Schema.optionalKey(Schema.NullOr(Schema.String)),
      fields: Schema.optionalKey(Schema.Array(Schema.String)),
      planRevision: Schema.optionalKey(Schema.Number),
      branch: Schema.optionalKey(Schema.String),
    }),
  ),
);
const titles: Record<string, string> = {
  "work_item.update": "Task updated",
  "work_item.status": "Status changed",
  "work_item.external_refreshed": "Source updated",
  "work_item.plan_start": "Planning started",
  "work_item.plan_generated": "Plan generated",
  "work_item.plan_failed": "Planning failed",
  "work_item.plan_approve": "Plan approved",
  "work_item.plan_reject": "Plan rejected",
  "work_item.plan_edit": "Plan updated",
  "work_item.plan_cancel": "Planning cancelled",
  "work_item.execution_started": "Execution requested",
  "work_item.execution_worktree_created": "Worktree created",
  "work_item.execution_succeeded": "Validation passed; ready for review",
  "work_item.execution_failed": "Execution failed",
  "work_item.execution_stopped": "Agent stopped",
  "work_item.review_started": "Review execution requested",
  "work_item.review_succeeded": "Review fixes published",
  "work_item.review_failed": "Review cycle failed",
  "work_item.review_stopped": "Agent stopped",
  pr_created: "Pull request created",
  pr_merged: "Pull request merged; task completed",
  pr_approved: "Pull request approved",
  pr_changes_requested: "Changes requested",
  pr_review_requested: "Review requested",
  pr_comment: "GitHub comment added",
  pr_review_comment: "Review comment added",
  pr_check_failed: "Check failed",
  pr_checks_passed: "Checks passed",
};
const sourceName = (source: WorkItemSource | string) =>
  source.startsWith("github")
    ? "GitHub"
    : source === "slack"
      ? "Slack"
      : source === "automation"
        ? "Automation"
        : "External";
const storageError = () =>
  new WorkActivityError({ message: "Could not load activity. Refresh and retry." });
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const work = yield* WorkItemService;
  const engine = yield* OrchestrationEngineService;
  const repo = yield* makeWorkActivityRepository;
  const changes = yield* SubscriptionRef.make(0);
  const lock = yield* Semaphore.make(1);
  let publishedHead = 0;
  const cursor = Effect.fn("WorkActivityService.cursor")(function* (source: string) {
    const rows = yield* sql<{
      sequence: number;
    }>`SELECT sequence FROM work_activity_cursors WHERE source=${source}`;
    return rows[0]?.sequence ?? 0;
  });
  const advance = (source: string, sequence: number) =>
    sql`UPDATE work_activity_cursors SET sequence=${sequence} WHERE source=${source}`;
  const workBatch = Effect.fn("WorkActivityService.workBatch")(function* () {
    const after = yield* cursor("work");
    const rows = yield* sql<{
      sequence: number;
      work_item_id: string;
      kind: string;
      occurred_at: string;
      metadata_json: string;
      source: WorkItemSource;
      status: string;
      thread_id: string | null;
      external_url: string | null;
      resource_source: string | null;
      resource_url: string | null;
      archived: string | null;
    }>`
     SELECT e.sequence,e.work_item_id,e.kind,e.occurred_at,e.metadata_json,
       json_extract(c.result_json,'$.source') AS source,json_extract(c.result_json,'$.status') AS status,
       json_extract(c.result_json,'$.agentThreadId') AS thread_id,CASE WHEN e.kind LIKE 'pr_%' THEN (SELECT json_extract(value,'$.url') FROM json_each(c.result_json,'$.resources') WHERE json_extract(value,'$.source')='github_pr' LIMIT 1) ELSE json_extract(c.result_json,'$.externalUrl') END AS external_url,
       json_extract(c.request_json,'$.resource.source') AS resource_source,json_extract(c.request_json,'$.resource.url') AS resource_url,
       json_extract(c.result_json,'$.archivedAt') AS archived
     FROM work_item_events e JOIN work_item_commands c ON c.command_id=e.command_id WHERE e.sequence>${after} ORDER BY e.sequence LIMIT 200`;
    for (const row of rows) {
      const metadata = yield* decodeMetadata(row.metadata_json);
      let title = titles[row.kind] ?? row.kind.replace(/^work_item\./, "").replaceAll("_", " ");
      let source: WorkActivityEvent["source"] = row.kind.startsWith("pr_check")
        ? "ci"
        : row.kind.startsWith("pr_")
          ? "github"
          : /\.(plan|execution|review)_/.test(row.kind)
            ? "agents"
            : "work";
      if (row.kind === "work_item.create") {
        title =
          row.source === "manual" ? "Task created" : `Imported from ${sourceName(row.source)}`;
        source =
          row.source === "slack" ? "slack" : row.source.startsWith("github") ? "github" : "work";
      }
      if (row.kind === "work_item.status" && row.status === "done") title = "Task completed";
      if (row.kind === "work_item.archive")
        title = row.archived ? "Task archived" : "Task restored";
      if (row.kind === "work_item.attachResource" || row.kind === "work_item.detachResource") {
        title = `${sourceName(row.resource_source ?? "")} ${row.resource_source === "slack" ? "message" : "resource"} ${row.kind.endsWith("attachResource") ? "attached" : "detached"}`;
        source =
          row.resource_source === "slack"
            ? "slack"
            : row.resource_source?.startsWith("github")
              ? "github"
              : "work";
      }
      const details: Array<{ label: string; value: string }> = [];
      if (metadata.previousStatus && metadata.previousStatus !== row.status)
        details.push({ label: "Status", value: `${metadata.previousStatus} → ${row.status}` });
      if (metadata.fields?.length)
        details.push({ label: "Updated", value: metadata.fields.join(", ").slice(0, 500) });
      if (metadata.planRevision)
        details.push({ label: "Plan revision", value: String(metadata.planRevision) });
      if (metadata.branch) details.push({ label: "Branch", value: metadata.branch.slice(0, 500) });
      yield* repo.append({
        id: activityId(`work:${row.sequence}`),
        workItemId: WorkItemId.make(row.work_item_id),
        kind: row.kind,
        source,
        occurredAt: row.occurred_at,
        title: title.slice(0, 500),
        summary: metadata.message?.slice(0, 1000) ?? "",
        threadId: row.thread_id ? ThreadId.make(row.thread_id) : null,
        url: row.resource_url ?? row.external_url,
        details,
      });
    }
    if (rows.length) yield* advance("work", rows.at(-1)!.sequence);
    return rows.length === 200;
  });
  const agentBatch = Effect.fn("WorkActivityService.agentBatch")(function* () {
    const after = yield* cursor("orchestration");
    const head = (yield* sql<{
      n: number;
    }>`SELECT coalesce(max(sequence),0) AS n FROM orchestration_events`)[0]!.n;
    const rows = yield* sql<{
      sequence: number;
      event_id: string;
      event_type: string;
      occurred_at: string;
      thread_id: string;
      summary: string | null;
      count: number | null;
    }>`
     SELECT sequence,event_id,event_type,occurred_at,json_extract(payload_json,'$.threadId') AS thread_id,
       substr(json_extract(payload_json,'$.activity.summary'),1,1000) AS summary,json_array_length(payload_json,'$.files') AS count
     FROM orchestration_events WHERE sequence>${after} AND sequence<=${head}
       AND coalesce(json_extract(metadata_json,'$.historyImport'),0)=0
       AND ((event_type='thread.activity-appended' AND json_extract(payload_json,'$.activity.kind') IN ('approval.requested','user-input.requested')) OR (event_type='thread.turn-diff-completed' AND json_extract(payload_json,'$.status')='ready'))
     ORDER BY sequence LIMIT 200`;
    for (const row of rows) {
      // The receipt at the time of the event owns the association, even after a task is rebound to another thread.
      const owners = yield* sql<{
        work_item_id: string;
      }>`SELECT c.work_item_id FROM work_item_commands c JOIN work_item_events e ON e.command_id=c.command_id
       WHERE json_extract(c.result_json,'$.agentThreadId')=${row.thread_id} AND e.occurred_at<=${row.occurred_at}
       AND e.sequence=(SELECT last.sequence FROM work_item_events last WHERE last.work_item_id=c.work_item_id AND last.occurred_at<=${row.occurred_at} ORDER BY last.occurred_at DESC,last.sequence DESC LIMIT 1)`;
      const diff = row.event_type === "thread.turn-diff-completed";
      if (diff && !row.count) continue;
      for (const owner of owners)
        yield* repo.append({
          id: activityId(`agent:${row.event_id}:${owner.work_item_id}`),
          workItemId: WorkItemId.make(owner.work_item_id),
          kind: diff ? "files_changed" : "agent_input_required",
          source: "agents",
          occurredAt: row.occurred_at,
          title: diff ? "Files changed" : "Agent requested input",
          summary: diff ? `${row.count} files in the change snapshot` : (row.summary ?? ""),
          threadId: ThreadId.make(row.thread_id),
          url: null,
          details: [],
        });
    }
    yield* advance("orchestration", rows.length === 200 ? rows.at(-1)!.sequence : head);
    return rows.length === 200;
  });
  const seedSnapshots = Effect.fn("WorkActivityService.seedSnapshots")(function* () {
    if (yield* cursor("snapshots")) return;
    let offset = 0;
    while (true) {
      const rows = yield* sql<{
        run_id: string;
        work_item_id: string;
        thread_id: string;
        entry: number;
        completed_at: string;
        command: string;
        exit_code: number | null;
        timed_out: number;
      }>`
        SELECT e.id AS run_id,e.work_item_id,e.thread_id,v.key AS entry,json_extract(v.value,'$.completedAt') AS completed_at,
        substr(json_extract(v.value,'$.command'),1,1000) AS command,json_extract(v.value,'$.exitCode') AS exit_code,json_extract(v.value,'$.timedOut') AS timed_out
        FROM work_item_executions e,json_each(e.record_json,'$.validationResults') v ORDER BY e.id,v.key LIMIT 200 OFFSET ${offset}`;
      yield* sql.withTransaction(
        Effect.forEach(
          rows,
          (row) =>
            repo.append({
              id: activityId(`validation:${row.run_id}:${row.entry}`),
              workItemId: WorkItemId.make(row.work_item_id),
              kind: "validation_completed",
              source: "ci",
              occurredAt: row.completed_at,
              title: row.timed_out
                ? "Validation timed out"
                : row.exit_code === 0
                  ? "Validation passed"
                  : "Validation failed",
              summary: row.command,
              threadId: ThreadId.make(row.thread_id),
              url: null,
              details: [
                {
                  label: "Exit code",
                  value: row.exit_code === null ? "Unavailable" : String(row.exit_code),
                },
              ],
            }),
          { discard: true },
        ),
      );
      if (rows.length < 200) break;
      offset += rows.length;
    }
    offset = 0;
    while (true) {
      const rows = yield* sql<{
        namespace: string;
        work_item_id: string;
        id: string;
        created_at: string;
        body: string;
        author: string;
        url: string;
      }>`
        SELECT i.namespace,r.work_item_id,json_extract(c.value,'$.id') AS id,json_extract(c.value,'$.createdAt') AS created_at,
        substr(json_extract(c.value,'$.body'),1,1000) AS body,substr(json_extract(c.value,'$.author'),1,500) AS author,json_extract(c.value,'$.url') AS url
        FROM github_issues i JOIN work_item_resources r ON r.source='github_issue' AND r.namespace=i.namespace AND r.external_id=i.external_id,
        json_each(i.record_json,'$.comments') c ORDER BY i.namespace,i.external_id,c.key LIMIT 200 OFFSET ${offset}`;
      yield* sql.withTransaction(
        Effect.forEach(
          rows,
          (row) =>
            repo.append({
              id: activityId(`github-comment:${row.work_item_id}:${row.namespace}:${row.id}`),
              workItemId: WorkItemId.make(row.work_item_id),
              kind: "github_comment_added",
              source: "github",
              occurredAt: row.created_at,
              title: "GitHub comment added",
              summary: row.body,
              threadId: null,
              url: row.url,
              details: [{ label: "Author", value: row.author }],
            }),
          { discard: true },
        ),
      );
      if (rows.length < 200) break;
      offset += rows.length;
    }
    yield* advance("snapshots", 1);
  });
  const sync = Effect.fn("WorkActivityService.sync")(
    function* () {
      yield* seedSnapshots();
      while (yield* sql.withTransaction(workBatch())) {
        /* Commit bounded batches during replay. */
      }
      while (yield* sql.withTransaction(agentBatch())) {
        /* Only milestone events are read. */
      }
      const head = (yield* sql<{
        n: number;
      }>`SELECT coalesce(max(sequence),0) AS n FROM work_item_activity`)[0]!.n;
      if (head !== publishedHead) {
        publishedHead = head;
        yield* SubscriptionRef.update(changes, (n) => n + 1);
      }
    },
    lock.withPermits(1),
    Effect.mapError(storageError),
  );
  const list = Effect.fn("WorkActivityService.list")(
    function* (raw: WorkActivityInput) {
      const input = yield* decodeInput(raw);
      const beforeTime = input.before ? DateTime.make(input.before.occurredAt) : Option.none();
      if (input.before && Option.isNone(beforeTime))
        return yield* new WorkActivityError({ message: "Invalid activity cursor." });
      const beforeAt = Option.isSome(beforeTime) ? DateTime.formatIso(beforeTime.value) : "";
      yield* work.get(input.id);
      const head = (yield* sql<{
        n: number;
      }>`SELECT coalesce(max(sequence),0) AS n FROM work_item_activity WHERE work_item_id=${input.id}`)[0]!
        .n;
      const throughSequence = Math.min(head, input.throughSequence ?? head);
      const base = sql`work_item_id=${input.id} AND sequence<=${throughSequence}`;
      const before = input.before
        ? sql`(occurred_at<${beforeAt} OR (occurred_at=${beforeAt} AND sequence<${input.before.sequence}))`
        : sql`1=1`;
      const limit = input.limit ?? 25;
      const rows = yield* sql<{
        sequence: number;
        record_json: string;
      }>`SELECT sequence,record_json FROM work_item_activity WHERE ${base} AND ${before} ORDER BY occurred_at DESC,sequence DESC LIMIT ${limit + 1}`;
      const items = yield* Effect.forEach(rows.slice(0, limit), (row) =>
        decodeEvent(row.record_json).pipe(
          Effect.map((event) => ({ ...event, sequence: row.sequence })),
        ),
      );
      const total = (yield* sql<{
        n: number;
      }>`SELECT count(*) AS n FROM work_item_activity WHERE ${base}`)[0]!.n;
      const last = items.at(-1);
      return {
        items,
        throughSequence,
        total,
        nextCursor:
          rows.length > limit && last
            ? { occurredAt: last.occurredAt, sequence: last.sequence }
            : null,
      };
    },
    sql.withTransaction,
    Effect.mapError(storageError),
  );
  const worker = yield* makeDrainableWorker((_input: void) =>
    sync().pipe(Effect.ignoreCause({ log: true })),
  );
  const domain = yield* engine.subscribeDomainEvents;
  yield* domain.pipe(
    Stream.filter(
      (e) =>
        e.type === "thread.turn-diff-completed" ||
        (e.type === "thread.activity-appended" &&
          ["approval.requested", "user-input.requested"].includes(e.payload.activity.kind)),
    ),
    Stream.runForEach(() => worker.enqueue(undefined)),
    Effect.forkScoped,
  );
  yield* work.changes.pipe(
    Stream.runForEach(() => worker.enqueue(undefined)),
    Effect.forkScoped,
  );
  yield* sync();
  return {
    changes: SubscriptionRef.changes(changes),
    list,
    sync,
    drain: worker.drain,
    subscribe: (input: WorkActivityInput) =>
      SubscriptionRef.changes(changes).pipe(Stream.mapEffect(() => list(input))),
  };
});
export class WorkActivityService extends Context.Service<
  WorkActivityService,
  Effect.Success<typeof make>
>()("t3/workItems/WorkActivityService") {}
