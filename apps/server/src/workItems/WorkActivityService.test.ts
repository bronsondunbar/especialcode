import { assert, it } from "@effect/vitest";
import { WorkItemId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { makeWorkActivityRepository } from "../persistence/WorkActivity.ts";
import { makeWorkItemRepository } from "../persistence/WorkItems.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import * as WorkItems from "./WorkItemService.ts";
import { make } from "./WorkActivityService.ts";
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const at = "2026-09-15T10:00:00.000Z";
const id = WorkItemId.make("task");
const setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES ('project','Project','/repo','[]',${at},${at})`;
  yield* sql`INSERT INTO projection_threads(thread_id,project_id,title,model_selection_json,created_at,updated_at) VALUES ('thread','project','Thread','{}',${at},${at})`;
  const work = yield* WorkItems.make;
  const activity = yield* makeWorkActivityRepository;
  const repository = yield* makeWorkItemRepository;
  const build = make.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(WorkItems.WorkItemService, work),
        Layer.mock(OrchestrationEngineService)({
          subscribeDomainEvents: Effect.succeed(Stream.never),
        }),
      ),
    ),
  );
  const item = yield* work.mutate({
    kind: "create",
    id,
    commandId: "create",
    title: "Task",
    source: "manual",
    fields: { projectId: ProjectId.make("project"), agentThreadId: ThreadId.make("thread") },
  });
  // Fixed timestamps make source ordering and historical thread ownership observable.
  yield* sql`UPDATE work_item_events SET occurred_at=${at}`;
  yield* sql`UPDATE work_item_commands SET created_at=${at}`;
  const service = yield* build;
  const record = Effect.fn(function* (
    eventId: string,
    type: string,
    payload: unknown,
    when = "2026-09-15T10:01:00.000Z",
    imported = false,
  ) {
    const n = (yield* sql<{
      n: number;
    }>`SELECT coalesce(max(sequence),0)+1 AS n FROM orchestration_events`)[0]!.n;
    yield* sql`INSERT INTO orchestration_events(event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,actor_kind,payload_json,metadata_json) VALUES (${eventId},'thread','thread',${n},${type},${when},'system',${json(payload)},${json({ historyImport: imported })})`;
  });
  return { sql, work, activity, repository, build, item, service, record };
});
it.effect("replays existing receipts once and combines sources in stable chronological pages", () =>
  Effect.gen(function* () {
    const { service, activity, build } = yield* setup;
    for (let n = 0; n < 5; n++)
      yield* activity.append({
        id: `source-${n}`,
        workItemId: id,
        kind: "github_comment_added",
        source: "github",
        occurredAt: at,
        title: `Comment ${n}`,
        summary: "Short preview",
        threadId: null,
        url: "https://github.com/org/repo/issues/1#issuecomment-1",
        details: [],
      });
    yield* service.sync();
    const first = yield* service.list({ id, limit: 2 });
    assert.strictEqual(first.total, 6);
    assert.strictEqual(first.items[0]?.title, "Comment 4");
    yield* activity.append({
      id: "late-arrival",
      workItemId: id,
      kind: "slack_attachment",
      source: "slack",
      occurredAt: at,
      title: "Late observation",
      summary: "",
      threadId: null,
      url: null,
      details: [],
    });
    const second = yield* service.list({
      id,
      limit: 2,
      before: first.nextCursor!,
      throughSequence: first.throughSequence,
    });
    assert.strictEqual(second.total, 6);
    assert.strictEqual(second.items[0]?.title, "Comment 2");
    const third = yield* service.list({
      id,
      limit: 2,
      before: second.nextCursor!,
      throughSequence: first.throughSequence,
    });
    assert.strictEqual(third.items.at(-1)?.title, "Task created");
    assert.isNull(third.nextCursor);
    const restarted = yield* build;
    assert.strictEqual((yield* restarted.list({ id })).total, 7);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
it.effect(
  "renders imports, attachments, status changes and archives without copying task bodies",
  () =>
    Effect.gen(function* () {
      const { service, work, item } = yield* setup;
      const resource = {
        source: "slack" as const,
        namespace: "T123/C123",
        externalId: "1760000000.000001",
        url: "https://example.slack.com/archives/C123/p1760000000000001",
      };
      const attached = yield* work.mutate({
        kind: "attachResource",
        id,
        commandId: "attach",
        expectedRevision: item.revision,
        resource,
      });
      const done = yield* work.mutate({
        kind: "status",
        id,
        commandId: "done",
        expectedRevision: attached.revision,
        status: "done",
      });
      yield* work.mutate({
        kind: "archive",
        id,
        commandId: "archive",
        expectedRevision: done.revision,
        archived: true,
      });
      yield* service.sync();
      const page = yield* service.list({ id });
      assert.isTrue(
        page.items.some((e) => e.title === "Slack message attached" && e.url === resource.url),
      );
      assert.isTrue(page.items.some((e) => e.title === "Task completed"));
      assert.isTrue(page.items.some((e) => e.title === "Task archived"));
      assert.isFalse(json(page).includes("result_json"));
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
it.effect("includes only milestone events and retains the thread association at event time", () =>
  Effect.gen(function* () {
    const { service, record, sql, work, item } = yield* setup;
    yield* record("input", "thread.activity-appended", {
      threadId: "thread",
      activity: { kind: "user-input.requested", summary: "Choose an option" },
    });
    yield* record("tokens", "thread.activity-appended", {
      threadId: "thread",
      activity: { kind: "message.delta", summary: "SECRET RAW TOKENS" },
    });
    yield* record("diff", "thread.turn-diff-completed", {
      threadId: "thread",
      status: "ready",
      files: [{ path: "a.ts", patch: "SECRET PATCH" }],
    });
    yield* record(
      "imported",
      "thread.activity-appended",
      { threadId: "thread", activity: { kind: "approval.requested", summary: "Imported history" } },
      "2026-09-15T10:01:00.000Z",
      true,
    );
    yield* work.mutate({
      kind: "update",
      id,
      commandId: "unlink",
      expectedRevision: item.revision,
      patch: { agentThreadId: null },
    });
    yield* sql`UPDATE work_item_events SET occurred_at='2026-09-15T10:02:00.000Z' WHERE command_id='unlink'`;
    yield* record(
      "after-unlink",
      "thread.activity-appended",
      { threadId: "thread", activity: { kind: "approval.requested", summary: "Another task" } },
      "2026-09-15T10:03:00.000Z",
    );
    yield* service.sync();
    const events = (yield* service.list({ id })).items;
    assert.strictEqual(events.filter((e) => e.kind === "agent_input_required").length, 1);
    assert.strictEqual(
      events.find((e) => e.kind === "files_changed")?.summary,
      "1 files in the change snapshot",
    );
    assert.isFalse(json(events).includes("SECRET"));
    assert.isFalse(json(events).includes("Another task"));
    yield* service.sync();
    assert.strictEqual((yield* service.list({ id })).items.length, events.length);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
it.effect("keeps snapshots compact, uses the PR link, and validates pagination inputs", () =>
  Effect.gen(function* () {
    const { service, repository, item } = yield* setup;
    yield* repository.transaction(
      repository.record(
        "pr",
        json({}),
        "pr_created",
        {
          ...item,
          resources: [
            {
              source: "github_pr",
              namespace: "github.com/org/repo",
              externalId: "4",
              url: "https://github.com/org/repo/pull/4",
            },
          ],
          externalUrl: "https://github.com/org/repo/issues/1",
          body: "RAW LOG".repeat(10000),
        },
        json({ message: "x".repeat(2000) }),
      ),
    );
    yield* service.sync();
    const entry = (yield* service.list({ id })).items.find((e) => e.kind === "pr_created")!;
    assert.strictEqual(entry.url, "https://github.com/org/repo/pull/4");
    assert.strictEqual(entry.summary.length, 1000);
    assert.isFalse(json(entry).includes("RAW LOG"));
    assert.strictEqual(
      (yield* service.list({ id, limit: 101 }).pipe(Effect.flip))._tag,
      "WorkActivityError",
    );
    assert.strictEqual(
      (yield* service.list({ id: WorkItemId.make("missing") }).pipe(Effect.flip))._tag,
      "WorkActivityError",
    );
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
it.effect(
  "backfills cached comments and validation summaries without retaining command output",
  () =>
    Effect.gen(function* () {
      const { sql, work, build, item } = yield* setup;
      yield* sql`UPDATE work_activity_cursors SET sequence=0 WHERE source='snapshots'`;
      yield* sql`INSERT INTO work_item_executions(id,work_item_id,thread_id,status,record_json) VALUES ('old-run',${id},'thread','succeeded',${json({ validationResults: [{ command: "vp test", exitCode: 0, timedOut: false, completedAt: at, output: "SECRET OLD OUTPUT" }] })})`;
      yield* work.mutate({
        kind: "attachResource",
        id,
        commandId: "github",
        expectedRevision: item.revision,
        resource: {
          source: "github_issue",
          namespace: "github.com/org/repo",
          externalId: "issue",
          url: "https://github.com/org/repo/issues/1",
        },
      });
      yield* sql`INSERT INTO github_tracked_repositories(namespace,record_json) VALUES ('github.com/org/repo','{}')`;
      yield* sql`INSERT INTO github_issues(namespace,external_id,number,state,updated_at,record_json) VALUES ('github.com/org/repo','issue',1,'open',${at},${json({ comments: [{ id: "c1", author: "alice", body: "Please fix", url: "https://github.com/org/repo/issues/1#issuecomment-1", createdAt: at }] })})`;
      const service = yield* build;
      const page = yield* service.list({ id });
      assert.isTrue(page.items.some((e) => e.kind === "validation_completed"));
      assert.isTrue(page.items.some((e) => e.summary === "Please fix"));
      assert.isFalse(json(page).includes("SECRET OLD OUTPUT"));
      const restarted = yield* build;
      assert.strictEqual((yield* restarted.list({ id })).total, page.total);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("delivers committed milestones to a live subscriber without replay duplicates", () =>
  Effect.gen(function* () {
    const { service, work, item } = yield* setup;
    const ready = yield* Deferred.make<void>();
    const received = yield* service.subscribe({ id }).pipe(
      Stream.tap(() => Deferred.succeed(ready, undefined)),
      Stream.filter((page) => page.items.some((event) => event.title === "Task completed")),
      Stream.runHead,
      Effect.forkScoped,
    );
    yield* Deferred.await(ready);
    yield* work.mutate({
      kind: "status",
      id,
      commandId: "complete-live",
      expectedRevision: item.revision,
      status: "done",
    });
    const page = Option.getOrThrow(yield* Fiber.join(received));
    assert.strictEqual(page.items.filter((event) => event.title === "Task completed").length, 1);
    yield* service.drain;
    assert.strictEqual((yield* service.list({ id })).total, 2);
  }).pipe(Effect.provide(SqlitePersistenceMemory), Effect.scoped),
);

it.effect("normalizes timezone offsets and fractional precision before sorting and paging", () =>
  Effect.gen(function* () {
    const { service, activity } = yield* setup;
    const dates = [
      "2026-09-15T10:00:00Z",
      "2026-09-15T10:00:00.100Z",
      "2026-09-15T11:00:00.050+01:00",
    ];
    for (const [index, occurredAt] of dates.entries())
      yield* activity.append({
        id: `precision-${index}`,
        workItemId: id,
        kind: "github_comment_added",
        source: "github",
        occurredAt,
        title: `Comment ${index}`,
        summary: "",
        threadId: null,
        url: null,
        details: [],
      });
    const first = yield* service.list({ id, limit: 1 });
    assert.strictEqual(first.items[0]?.title, "Comment 1");
    const second = yield* service.list({
      id,
      limit: 1,
      before: first.nextCursor!,
      throughSequence: first.throughSequence,
    });
    assert.strictEqual(second.items[0]?.title, "Comment 2");
    assert.strictEqual(second.items[0]?.occurredAt, "2026-09-15T10:00:00.050Z");
    assert.strictEqual(
      (yield* service
        .list({ id, before: { sequence: 1, occurredAt: "invalid" } })
        .pipe(Effect.flip))._tag,
      "WorkActivityError",
    );
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
