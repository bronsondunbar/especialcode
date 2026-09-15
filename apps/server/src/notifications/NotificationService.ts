import {
  ApplicationEvent,
  AppNotification,
  NotificationError,
  NotificationPreferences,
  NotificationListInput,
  NotificationMutation,
  WorkItem,
  WorkItemId,
  ProjectId,
  ThreadActivityAppendedPayload,
  ThreadSessionSetPayload,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { WorkItemService } from "../workItems/WorkItemService.ts";
import { ApplicationEventService } from "./ApplicationEventService.ts";
import {
  notificationPriority,
  notificationDelivery,
  workApplicationEvent,
} from "./notificationRules.ts";
const decodeItem = Schema.decodeUnknownEffect(Schema.fromJsonString(WorkItem));
const decodeEvent = Schema.decodeUnknownEffect(Schema.fromJsonString(ApplicationEvent));
const decodeNotification = Schema.decodeUnknownEffect(Schema.fromJsonString(AppNotification));
const encodeNotification = Schema.encodeEffect(Schema.fromJsonString(AppNotification));
const decodeList = Schema.decodeUnknownEffect(NotificationListInput);
const decodeMutation = Schema.decodeUnknownEffect(NotificationMutation);
const decodeActivity = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ThreadActivityAppendedPayload),
);
const decodeSession = Schema.decodeUnknownEffect(Schema.fromJsonString(ThreadSessionSetPayload));
const decodeMetadata = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      message: Schema.optionalKey(Schema.String),
      fields: Schema.optionalKey(Schema.Array(Schema.String)),
    }),
  ),
);
const decodePreferences = Schema.decodeUnknownEffect(
  Schema.fromJsonString(NotificationPreferences),
);
const encodePreferences = Schema.encodeEffect(Schema.fromJsonString(NotificationPreferences));
const isNotificationError = Schema.is(NotificationError);
const storageError = (error: unknown) =>
  isNotificationError(error)
    ? error
    : new NotificationError({ message: "Could not update notifications. Reconnect or retry." });
const PAGE_SIZE = 200;

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const events = yield* ApplicationEventService;
  const work = yield* WorkItemService;
  const engine = yield* OrchestrationEngineService;
  const changes = yield* SubscriptionRef.make(0);
  const lock = yield* Semaphore.make(1);
  const preferences = Effect.fn("NotificationService.preferences")(function* () {
    const rows = yield* sql<{
      revision: number;
      record_json: string;
    }>`SELECT revision,record_json FROM notification_preferences WHERE id=1`;
    return { revision: rows[0]!.revision, value: yield* decodePreferences(rows[0]!.record_json) };
  });
  const cursor = Effect.fn("NotificationService.cursor")(function* (source: string) {
    const rows = yield* sql<{
      sequence: number;
    }>`SELECT sequence FROM application_event_cursors WHERE source=${source}`;
    return rows[0]?.sequence ?? 0;
  });
  const advance = (source: string, sequence: number) =>
    sql`UPDATE application_event_cursors SET sequence=${sequence} WHERE source=${source}`;
  const ingestWork = Effect.fn("NotificationService.ingestWork")(function* () {
    let full = true;
    while (full) {
      const after = yield* cursor("work");
      const rows = yield* sql<{
        sequence: number;
        command_id: string;
        kind: string;
        result_json: string;
        metadata_json: string;
      }>`
        SELECT e.sequence,e.command_id,e.kind,c.result_json,e.metadata_json FROM work_item_events e
        JOIN work_item_commands c ON c.command_id=e.command_id WHERE e.sequence>${after}
        ORDER BY e.sequence LIMIT ${PAGE_SIZE}`;
      for (const row of rows) {
        const item = yield* decodeItem(row.result_json);
        const metadata = yield* decodeMetadata(row.metadata_json);
        yield* events.append(
          workApplicationEvent({
            commandId: row.command_id,
            kind: row.kind,
            item,
            message: metadata.message,
            assigned: row.kind === "work_item.update" && metadata.fields?.includes("assignedAgent"),
          }),
        );
        yield* advance("work", row.sequence);
      }
      full = rows.length === PAGE_SIZE;
    }
  });
  const ingestAgents = Effect.fn("NotificationService.ingestAgents")(function* () {
    const heads = yield* sql<{
      sequence: number;
    }>`SELECT coalesce(max(sequence),0) AS sequence FROM orchestration_events`;
    const head = heads[0]?.sequence ?? 0;
    let full = true;
    while (full) {
      const after = yield* cursor("orchestration");
      const rows = yield* sql<{
        sequence: number;
        event_id: string;
        event_type: string;
        payload_json: string;
        occurred_at: string;
      }>`
        SELECT sequence,event_id,event_type,payload_json,occurred_at FROM orchestration_events
        WHERE sequence>${after} AND sequence<=${head}
        AND (event_type='thread.session-set' OR (event_type='thread.activity-appended' AND json_extract(payload_json,'$.activity.kind') IN ('approval.requested','user-input.requested')))
        AND coalesce(json_extract(metadata_json,'$.historyImport'),0)=0
        ORDER BY sequence LIMIT ${PAGE_SIZE}`;
      for (const row of rows) {
        yield* advance("orchestration", row.sequence);
        const activity =
          row.event_type === "thread.activity-appended"
            ? yield* decodeActivity(row.payload_json)
            : null;
        const session =
          row.event_type === "thread.session-set" ? yield* decodeSession(row.payload_json) : null;
        const needsInput =
          activity &&
          ["approval.requested", "user-input.requested"].includes(activity.activity.kind);
        let type: string | null = needsInput ? "agent_input_required" : null;
        const threadId = activity?.threadId ?? session!.threadId;
        if (session) {
          const previous = yield* sql<{
            status: string;
            active_turn_id: string | null;
          }>`SELECT status,active_turn_id FROM application_agent_sessions WHERE thread_id=${threadId}`;
          yield* sql`INSERT INTO application_agent_sessions(thread_id,status,active_turn_id) VALUES (${threadId},${session.session.status},${session.session.activeTurnId}) ON CONFLICT(thread_id) DO UPDATE SET status=excluded.status,active_turn_id=excluded.active_turn_id`;
          // Session transitions are authoritative; diff events can arrive in the middle of a turn.
          if (session.session.status === "error" && previous[0]?.status !== "error")
            type = "agent_execution_failed";
          else if (session.session.status === "ready" && previous[0]?.status === "running")
            type = "agent_execution_completed";
          else if (
            session.session.status === "running" &&
            (previous[0]?.status !== "running" ||
              previous[0]?.active_turn_id !== session.session.activeTurnId)
          )
            type = "agent_execution_started";
        }
        if (!type) continue;
        const threads = yield* sql<{
          project_id: string;
          title: string;
        }>`SELECT project_id,title FROM projection_threads WHERE thread_id=${threadId} AND deleted_at IS NULL`;
        if (!threads[0]) continue;
        const items = yield* sql<{
          id: string;
        }>`SELECT id FROM work_items WHERE json_extract(record_json,'$.agentThreadId')=${threadId} ORDER BY updated_at DESC LIMIT 1`;
        // Managed execution reports completion only after validation/publishing, not each provider turn.
        if (!needsInput) {
          const managed = yield* sql`SELECT id FROM work_item_executions WHERE thread_id=${threadId}
            AND json_extract(record_json,'$.startedAt')<=${row.occurred_at}
            AND (json_extract(record_json,'$.completedAt') IS NULL OR json_extract(record_json,'$.completedAt')>=${row.occurred_at}) LIMIT 1`;
          if (managed.length) continue;
        }
        yield* events.append({
          id: `agent:${row.event_id}`,
          source: "agents",
          type,
          userId: null,
          projectId: ProjectId.make(threads[0].project_id),
          workItemId: items[0] ? WorkItemId.make(items[0].id) : null,
          title: needsInput
            ? "Agent needs input"
            : type === "agent_execution_failed"
              ? "Agent needs attention"
              : type === "agent_execution_started"
                ? "Agent started"
                : "Changes ready for review",
          message:
            `${threads[0].title}${activity ? `: ${activity.activity.summary}` : session?.session.lastError ? `: ${session.session.lastError}` : ""}`.slice(
              0,
              5000,
            ),
          action: { kind: type === "agent_execution_completed" ? "changes" : "agent", threadId },
          createdAt: row.occurred_at,
        });
      }
      full = rows.length === PAGE_SIZE;
    }
    yield* advance("orchestration", head);
  });
  const project = Effect.fn("NotificationService.project")(function* () {
    const policy = yield* preferences();
    let changed = false;
    let full = true;
    while (full) {
      const after = yield* cursor("notifications");
      const rows = yield* sql<{
        sequence: number;
        record_json: string;
      }>`SELECT sequence,record_json FROM application_events WHERE sequence>${after} ORDER BY sequence LIMIT ${PAGE_SIZE}`;
      for (const row of rows) {
        const event = yield* decodeEvent(row.record_json);
        const delivery = notificationDelivery(event.type, policy.value);
        const priority = notificationPriority(event.type) ?? "info";
        if (delivery.inApp || delivery.desktop) {
          const record = yield* encodeNotification({
            ...event,
            priority,
            sequence: row.sequence,
            readAt: null,
          });
          yield* sql`INSERT INTO application_notifications(id,sequence,source,priority,record_json,in_app,desktop) VALUES (${event.id},${row.sequence},${event.source},${priority},${record},${delivery.inApp ? 1 : 0},${delivery.desktop ? 1 : 0}) ON CONFLICT(id) DO NOTHING`;
          changed = true;
        }
        yield* advance("notifications", row.sequence);
      }
      full = rows.length === PAGE_SIZE;
    }
    return changed;
  });
  const sync = Effect.fn("NotificationService.sync")(
    function* () {
      const changed = yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* ingestWork();
          yield* ingestAgents();
          return yield* project();
        }),
      );
      if (changed) yield* SubscriptionRef.update(changes, (n) => n + 1);
    },
    lock.withPermits(1),
    Effect.mapError(storageError),
  );
  const list = Effect.fn("NotificationService.list")(function* (raw: NotificationListInput) {
    const input = yield* decodeList(raw);
    const filter = input.filter ?? "all";
    const category =
      filter === "attention"
        ? sql`priority IN ('attention','urgent')`
        : filter === "github"
          ? sql`source IN ('github','ci')`
          : filter === "system"
            ? sql`source IN ('system','automation','work')`
            : filter === "all"
              ? sql`1=1`
              : sql`source=${filter}`;
    const channel = input.channel === "desktop" ? sql`desktop=1` : sql`in_app=1`;
    const where = sql.and([
      category,
      channel,
      ...(input.afterSequence === undefined ? [] : [sql`sequence>${input.afterSequence}`]),
    ]);
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const policy = yield* preferences();
        const rows = yield* sql<{
          record_json: string;
          read_at: string | null;
        }>`SELECT record_json,read_at FROM application_notifications WHERE ${where} ORDER BY ${input.afterSequence === undefined ? sql`sequence DESC` : sql`sequence ASC`} LIMIT ${input.limit ?? 50} OFFSET ${input.offset ?? 0}`;
        const totals = yield* sql<{
          total: number;
        }>`SELECT count(*) AS total FROM application_notifications WHERE ${where}`;
        const unread = yield* sql<{
          total: number;
        }>`SELECT count(*) AS total FROM application_notifications WHERE in_app=1 AND read_at IS NULL`;
        const head = yield* cursor("notifications");
        return {
          items: yield* Effect.forEach(
            rows,
            Effect.fn(function* (row) {
              return { ...(yield* decodeNotification(row.record_json)), readAt: row.read_at };
            }),
          ),
          total: totals[0]?.total ?? 0,
          unreadCount: unread[0]?.total ?? 0,
          latestSequence: head,
          preferences: policy,
        };
      }),
    );
  }, Effect.mapError(storageError));
  const mutate = Effect.fn("NotificationService.mutate")(
    function* (raw: NotificationMutation) {
      const input = yield* decodeMutation(raw);
      const now = DateTime.formatIso(yield* DateTime.now);
      if (input.kind === "preferences") {
        // Finish projecting committed events under the old policy before changing future delivery.
        yield* sync();
        yield* sql.withTransaction(
          Effect.gen(function* () {
            const current = yield* preferences();
            if (current.revision !== input.expectedRevision)
              return yield* new NotificationError({
                message: "Preferences changed on another client. Refresh before saving.",
              });
            yield* sql`UPDATE notification_preferences SET revision=revision+1,record_json=${yield* encodePreferences(input.value)} WHERE id=1`;
          }),
        );
      } else if (input.kind === "read_all") {
        yield* sql`UPDATE application_notifications SET read_at=${now} WHERE in_app=1 AND read_at IS NULL AND sequence<=${input.throughSequence}`;
      } else {
        yield* sql`UPDATE application_notifications SET read_at=${input.read ? now : null} WHERE id=${input.id}`;
      }
      yield* SubscriptionRef.update(changes, (n) => n + 1);
    },
    Effect.mapError(storageError),
    Effect.uninterruptible,
  );
  const worker = yield* makeDrainableWorker((_input: void) =>
    sync().pipe(Effect.ignoreCause({ log: true })),
  );
  const domain = yield* engine.subscribeDomainEvents;
  yield* domain.pipe(
    Stream.filter(
      (event) =>
        (event.type === "thread.activity-appended" &&
          ["approval.requested", "user-input.requested"].includes(event.payload.activity.kind)) ||
        event.type === "thread.session-set",
    ),
    Stream.runForEach(() => worker.enqueue(undefined)),
    Effect.forkScoped,
  );
  yield* Stream.merge(work.changes, events.changes).pipe(
    Stream.runForEach(() => worker.enqueue(undefined)),
    Effect.forkScoped,
  );
  yield* sync();
  return {
    list,
    mutate,
    sync,
    drain: worker.drain,
    subscribe: (input: NotificationListInput) =>
      SubscriptionRef.changes(changes).pipe(Stream.mapEffect(() => list(input))),
  };
});
export class NotificationService extends Context.Service<
  NotificationService,
  Effect.Success<typeof make>
>()("t3/notifications/NotificationService") {}
