import { assert, it } from "@effect/vitest";
import { WorkItemId, ProjectId, ThreadId, type ApplicationEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { makeWorkItemRepository } from "../persistence/WorkItems.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import * as WorkItems from "../workItems/WorkItemService.ts";
import * as Events from "./ApplicationEventService.ts";
import * as Notifications from "./NotificationService.ts";
const at = "2026-09-14T10:00:00.000Z";
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const event = (
  id: string,
  type: string,
  source: ApplicationEvent["source"] = "agents",
): ApplicationEvent => ({
  id,
  type,
  source,
  userId: null,
  projectId: ProjectId.make("project"),
  workItemId: null,
  title: "Attention",
  message: "Review this",
  action: { kind: "agent", threadId: ThreadId.make("thread") },
  createdAt: at,
});
const setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES ('project','Project','/repo','[]',${at},${at})`;
  yield* sql`INSERT INTO projection_threads(thread_id,project_id,title,model_selection_json,created_at,updated_at) VALUES ('thread','project','Invoices','{}',${at},${at})`;
  const work = yield* WorkItems.make;
  const events = yield* Events.make;
  const make = Notifications.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(WorkItems.WorkItemService, work),
        Layer.succeed(Events.ApplicationEventService, events),
        Layer.mock(OrchestrationEngineService)({
          subscribeDomainEvents: Effect.succeed(Stream.never),
        }),
      ),
    ),
  );
  const notifications = yield* make;
  const record = Effect.fn(function* (
    id: string,
    type: string,
    payload: unknown,
    imported = false,
  ) {
    const rows = yield* sql<{
      n: number;
    }>`SELECT coalesce(max(sequence),0)+1 AS n FROM orchestration_events`;
    yield* sql`INSERT INTO orchestration_events(event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,actor_kind,payload_json,metadata_json) VALUES (${id},'thread','thread',${rows[0]!.n},${type},${at},'system',${json(payload)},${json({ historyImport: imported })})`;
  });
  const session = (
    id: string,
    status: "running" | "ready" | "error" | "interrupted",
    imported = false,
  ) =>
    record(
      id,
      "thread.session-set",
      {
        threadId: "thread",
        session: {
          threadId: "thread",
          status,
          activeTurnId: status === "running" ? id : null,
          providerName: "codex",
          lastError: status === "error" ? "Provider failed" : null,
          updatedAt: at,
        },
      },
      imported,
    );
  const input = (id: string, kind = "user-input.requested", imported = false) =>
    record(
      id,
      "thread.activity-appended",
      {
        threadId: "thread",
        activity: {
          id,
          kind,
          createdAt: at,
          tone: "info",
          summary: "Choose a design",
          payload: {},
          turnId: null,
        },
      },
      imported,
    );
  return { sql, work, events, notifications, make, session, input, record };
});
const testLayer = SqlitePersistenceMemory;

it.effect(
  "keeps quiet events, applies default priorities and filters, and deduplicates replay",
  () =>
    Effect.gen(function* () {
      const { sql, events, notifications } = yield* setup;
      for (const e of [
        event("start", "agent_execution_started"),
        event("input", "agent_input_required"),
        event("failed", "pr_check_failed", "ci"),
        event("merged", "pr_merged", "github"),
        event("auto", "automation_failed", "automation"),
        event("slack", "slack_mention_received", "slack"),
      ])
        yield* events.append(e);
      yield* notifications.sync();
      const all = yield* notifications.list({});
      assert.equal(all.total, 5);
      assert.equal(all.unreadCount, 5);
      assert.equal((yield* notifications.list({ filter: "attention" })).total, 4);
      assert.equal((yield* notifications.list({ filter: "github" })).total, 2);
      assert.equal((yield* notifications.list({ filter: "system" })).total, 1);
      assert.equal((yield* notifications.list({ filter: "slack" })).total, 1);
      assert.equal(
        (yield* notifications.list({ filter: "agents" })).items[0]?.priority,
        "attention",
      );
      yield* events.append(event("input", "agent_input_required"));
      yield* sql`UPDATE application_event_cursors SET sequence=0 WHERE source='notifications'`;
      yield* notifications.sync();
      assert.equal((yield* notifications.list({})).total, 5);
      assert.equal(
        (yield* sql<{ n: number }>`SELECT count(*) AS n FROM application_events`)[0]?.n,
        6,
      );
    }).pipe(Effect.provide(testLayer), Effect.scoped),
);

it.effect(
  "persists read/unread state through restart and protects later arrivals from mark-all",
  () =>
    Effect.gen(function* () {
      const { events, notifications, make } = yield* setup;
      yield* events.append(event("one", "agent_input_required"));
      yield* notifications.sync();
      const first = yield* notifications.list({});
      yield* events.append(event("two", "agent_execution_failed"));
      yield* notifications.sync();
      yield* notifications.mutate({ kind: "read_all", throughSequence: first.latestSequence });
      assert.equal((yield* notifications.list({})).unreadCount, 1);
      yield* notifications.mutate({ kind: "read", id: "two", read: true });
      yield* notifications.mutate({ kind: "read", id: "two", read: true });
      assert.equal((yield* notifications.list({})).unreadCount, 0);
      const restarted = yield* make;
      assert.equal((yield* restarted.list({})).unreadCount, 0);
      yield* restarted.mutate({ kind: "read", id: "one", read: false });
      assert.equal((yield* notifications.list({})).unreadCount, 1);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
);

it.effect("uses event-time WorkItem snapshots and replays changes missed while offline", () =>
  Effect.gen(function* () {
    const { work, notifications, make } = yield* setup;
    const repo = yield* makeWorkItemRepository;
    const item = yield* work.mutate({
      kind: "create",
      id: WorkItemId.make("task"),
      commandId: "create",
      title: "Original title",
      source: "manual",
      fields: {},
    });
    yield* repo.transaction(
      repo.record("finished", "{}", "work_item.plan_generated", item, json({})),
    );
    yield* work.mutate({
      kind: "update",
      id: item.id,
      commandId: "rename",
      expectedRevision: 1,
      patch: { title: "New title" },
    });
    const restarted = yield* make;
    const page = yield* restarted.list({});
    assert.equal(page.total, 1);
    assert.equal(page.items[0]?.title, "Plan ready for approval");
    assert.equal(page.items[0]?.message, "Original title");
    assert.deepEqual(page.items[0]?.action, {
      kind: "work_item",
      workItemId: WorkItemId.make("task"),
    });
    yield* notifications.sync();
    assert.equal((yield* notifications.list({})).total, 1);
  }).pipe(Effect.provide(testLayer), Effect.scoped),
);

it.effect(
  "creates input notifications for agents, ignores imported history and ordinary progress",
  () =>
    Effect.gen(function* () {
      const { input, notifications } = yield* setup;
      yield* input("old", "user-input.requested", true);
      yield* input("progress", "task.progress");
      yield* input("input");
      yield* input("approval", "approval.requested");
      yield* notifications.sync();
      const page = yield* notifications.list({});
      assert.equal(page.total, 2);
      assert.deepEqual(page.items[0]?.action, { kind: "agent", threadId: ThreadId.make("thread") });
      assert.equal(page.items[0]?.projectId, "project");
      assert.equal(page.items[0]?.priority, "attention");
    }).pipe(Effect.provide(testLayer), Effect.scoped),
);

it.effect(
  "notifies on terminal session transitions, never mid-turn diffs, initial readiness, or repeated errors",
  () =>
    Effect.gen(function* () {
      const { session, record, notifications } = yield* setup;
      yield* session("initial", "ready");
      yield* session("start", "running");
      yield* record("diff", "thread.turn-diff-completed", {});
      yield* notifications.sync();
      assert.equal((yield* notifications.list({})).total, 0);
      yield* session("end", "ready");
      yield* session("ready-again", "ready");
      yield* session("fail-start", "running");
      yield* session("failed", "error");
      yield* session("still-failed", "error");
      yield* notifications.sync();
      const page = yield* notifications.list({});
      assert.equal(page.total, 2);
      assert.equal(page.items[0]?.type, "agent_execution_failed");
      assert.equal(page.items[1]?.type, "agent_execution_completed");
      yield* session("interrupted-start", "running");
      yield* session("interrupted", "interrupted");
      yield* notifications.sync();
      assert.equal((yield* notifications.list({})).total, 2);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
);

it.effect("waits for managed validation and publishing while preserving agent input actions", () =>
  Effect.gen(function* () {
    const { sql, work, session, input, notifications } = yield* setup;
    const repo = yield* makeWorkItemRepository;
    const item = yield* work.mutate({
      kind: "create",
      id: WorkItemId.make("task"),
      commandId: "create",
      title: "Invoices",
      source: "manual",
      fields: { projectId: ProjectId.make("project"), agentThreadId: ThreadId.make("thread") },
    });
    yield* sql`INSERT INTO work_item_executions(id,work_item_id,thread_id,status,record_json) VALUES ('run',${item.id},'thread','running',${json({ startedAt: at, completedAt: null })})`;
    yield* session("start", "running");
    yield* session("end", "ready");
    yield* input("input");
    yield* notifications.sync();
    const page = yield* notifications.list({});
    assert.equal(page.total, 1);
    assert.equal(page.items[0]?.workItemId, item.id);
    assert.equal(page.items[0]?.type, "agent_input_required");
    yield* repo.transaction(
      repo.record("validated", "{}", "work_item.execution_succeeded", item, json({})),
    );
    yield* notifications.sync();
    assert.equal((yield* notifications.list({})).total, 2);
    assert.deepEqual((yield* notifications.list({})).items[0]?.action, {
      kind: "changes",
      threadId: ThreadId.make("thread"),
    });
  }).pipe(Effect.provide(testLayer), Effect.scoped),
);

it.effect(
  "paginates durable events and returns an environment-wide unread count for filtered pages",
  () =>
    Effect.gen(function* () {
      const { sql, events, notifications } = yield* setup;
      yield* sql.withTransaction(
        Effect.forEach(
          Array.from({ length: 205 }, (_, i) => i),
          (i) =>
            events.append(
              event(
                String(i),
                i % 2 ? "agent_input_required" : "pr_approved",
                i % 2 ? "agents" : "github",
              ),
            ),
        ),
      );
      yield* notifications.sync();
      const page = yield* notifications.list({ filter: "github", limit: 10, offset: 100 });
      assert.equal(page.items.length, 3);
      assert.equal(page.total, 103);
      assert.equal(page.unreadCount, 205);
      assert.ok(page.items[0]!.sequence > page.items[1]!.sequence);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
);

it.effect(
  "rolls back the projection and cursor on corrupt input instead of dropping an event",
  () =>
    Effect.gen(function* () {
      const { sql, events, notifications } = yield* setup;
      yield* sql`INSERT INTO application_events(id,record_json) VALUES ('bad','{}')`;
      yield* events.append(event("good", "agent_input_required"));
      yield* notifications.sync().pipe(Effect.flip);
      assert.equal((yield* notifications.list({})).total, 0);
      yield* sql`UPDATE application_events SET record_json=${json(event("bad", "agent_input_required"))} WHERE id='bad'`;
      yield* notifications.sync();
      assert.equal((yield* notifications.list({})).total, 2);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
);

it.effect("delivers committed events and read-state changes through live subscriptions", () =>
  Effect.gen(function* () {
    const { events, notifications } = yield* setup;
    const ready = yield* Deferred.make<void>();
    const received = yield* notifications.subscribe({}).pipe(
      Stream.tap(() => Deferred.succeed(ready, undefined)),
      Stream.filter((page) => page.unreadCount === 1),
      Stream.runHead,
      Effect.forkScoped,
    );
    yield* Deferred.await(ready);
    yield* events.append(event("live", "agent_input_required"));
    yield* events.notifyChange;
    assert.equal(Option.getOrThrow(yield* Fiber.join(received)).items[0]?.id, "live");
    const readReady = yield* Deferred.make<void>();
    const read = yield* notifications.subscribe({}).pipe(
      Stream.tap(() => Deferred.succeed(readReady, undefined)),
      Stream.filter((page) => page.total === 1 && page.unreadCount === 0),
      Stream.runHead,
      Effect.forkScoped,
    );
    yield* Deferred.await(readReady);
    yield* notifications.mutate({ kind: "read", id: "live", read: true });
    assert.equal(Option.getOrThrow(yield* Fiber.join(read)).unreadCount, 0);
  }).pipe(Effect.provide(testLayer), Effect.scoped),
);

it.effect("still notifies for manually attached threads outside managed execution", () =>
  Effect.gen(function* () {
    const { work, session, notifications } = yield* setup;
    yield* work.mutate({
      kind: "create",
      id: WorkItemId.make("task"),
      commandId: "create",
      title: "Manual context",
      source: "manual",
      fields: { projectId: ProjectId.make("project"), agentThreadId: ThreadId.make("thread") },
    });
    yield* session("start", "running");
    yield* session("end", "ready");
    yield* notifications.sync();
    const page = yield* notifications.list({});
    assert.equal(page.total, 1);
    assert.equal(page.items[0]?.type, "agent_execution_completed");
    assert.equal(page.items[0]?.workItemId, "task");
  }).pipe(Effect.provide(testLayer), Effect.scoped),
);

it.effect(
  "persists preferences, rejects stale edits, and restores defaults without replaying muted history",
  () =>
    Effect.gen(function* () {
      const { events, notifications, make } = yield* setup;
      const policy = (yield* notifications.list({})).preferences!;
      yield* events.append(event("quiet", "agent_execution_started"));
      yield* notifications.sync();
      yield* notifications.mutate({
        kind: "preferences",
        expectedRevision: policy.revision,
        value: {
          ...policy.value,
          events: { ...policy.value.events, agentStatus: true, agentFailed: false },
        },
      });
      const stale = yield* notifications
        .mutate({ kind: "preferences", expectedRevision: policy.revision, value: policy.value })
        .pipe(Effect.flip);
      assert.ok(stale.message.includes("another client"));
      yield* events.append(event("status", "agent_execution_started"));
      yield* events.append(event("failure", "agent_execution_failed"));
      yield* notifications.sync();
      assert.deepEqual(
        (yield* notifications.list({})).items.map((item) => item.id),
        ["status"],
      );
      assert.equal((yield* notifications.list({ channel: "desktop" })).total, 0);
      const restarted = yield* make;
      const saved = (yield* restarted.list({})).preferences!;
      assert.equal(saved.value.events.agentStatus, true);
      yield* restarted.mutate({
        kind: "preferences",
        expectedRevision: saved.revision,
        value: policy.value,
      });
      assert.equal((yield* restarted.list({})).total, 1);
      yield* events.append(event("new-failure", "agent_execution_failed"));
      yield* restarted.sync();
      assert.equal((yield* restarted.list({})).total, 2);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
);

it.effect("keeps desktop delivery independent from the inbox and paginates a native cursor", () =>
  Effect.gen(function* () {
    const { events, notifications } = yield* setup;
    const policy = (yield* notifications.list({})).preferences!;
    yield* notifications.mutate({
      kind: "preferences",
      expectedRevision: policy.revision,
      value: { ...policy.value, delivery: { inApp: false, desktop: true } },
    });
    yield* events.append(event("native", "agent_input_required"));
    yield* notifications.sync();
    const inbox = yield* notifications.list({});
    assert.equal(inbox.total, 0);
    assert.equal(inbox.unreadCount, 0);
    const desktop = yield* notifications.list({ channel: "desktop", afterSequence: 0 });
    assert.equal(desktop.items[0]?.id, "native");
    assert.equal(
      (yield* notifications.list({ channel: "desktop", afterSequence: desktop.latestSequence }))
        .total,
      0,
    );
    const current = inbox.preferences!;
    yield* notifications.mutate({
      kind: "preferences",
      expectedRevision: current.revision,
      value: { ...current.value, delivery: { inApp: true, desktop: false } },
    });
    yield* events.append(event("inbox", "agent_execution_failed"));
    yield* notifications.sync();
    assert.equal((yield* notifications.list({})).total, 1);
    assert.equal((yield* notifications.list({ channel: "desktop" })).total, 1);
  }).pipe(Effect.provide(testLayer), Effect.scoped),
);

it.effect("delivers automation notifications and respects disabled delivery channels", () =>
  Effect.gen(function* () {
    const { events, notifications } = yield* setup;
    yield* events.append(event("automation-notice", "automation_notification", "automation"));
    yield* notifications.sync();
    assert.strictEqual((yield* notifications.list({})).items[0]?.source, "automation");
    assert.strictEqual((yield* notifications.list({})).items[0]?.priority, "info");
    assert.strictEqual(
      (yield* notifications.list({ channel: "desktop" })).items[0]?.id,
      "automation-notice",
    );
    const policy = (yield* notifications.list({})).preferences!;
    yield* notifications.mutate({
      kind: "preferences",
      expectedRevision: policy.revision,
      value: { ...policy.value, delivery: { inApp: false, desktop: false } },
    });
    yield* events.append(event("muted-automation", "automation_notification", "automation"));
    yield* notifications.sync();
    assert.strictEqual(
      (yield* notifications.list({})).items.some((item) => item.id === "muted-automation"),
      false,
    );
  }).pipe(Effect.provide(testLayer)),
);
