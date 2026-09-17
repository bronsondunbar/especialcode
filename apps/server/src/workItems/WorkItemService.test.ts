import { it, assert } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WorkItemId,
  type WorkItemMutation,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Fiber from "effect/Fiber";
import * as Deferred from "effect/Deferred";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { WorkItemService, make } from "./WorkItemService.ts";

const layer = WorkItemService.layer.pipe(Layer.provideMerge(SqlitePersistenceMemory));
const create = (
  id: string,
  fields: Extract<WorkItemMutation, { kind: "create" }>["fields"] = {},
): WorkItemMutation => ({
  kind: "create",
  commandId: `create-${id}`,
  id: WorkItemId.make(id),
  source: "manual",
  title: id,
  fields,
});

it.effect("persists CRUD, literal search, filters, pagination, archive, restore and reopen", () =>
  Effect.gen(function* () {
    const service = yield* WorkItemService;
    const first = yield* service.mutate(
      create("alpha", { title: "Fix 100% matching", priority: "urgent" }),
    );
    yield* service.mutate(create("beta", { body: "searchable body" }));
    assert.strictEqual((yield* service.list({ query: "%" })).total, 1);
    assert.strictEqual((yield* service.list({ query: "SEARCHABLE" })).total, 1);
    assert.strictEqual(
      (yield* service.list({ priority: "urgent", source: "manual" })).items[0]?.id,
      first.id,
    );
    assert.strictEqual((yield* service.list({ limit: 1, offset: 1 })).items.length, 1);
    assert.strictEqual((yield* service.list({ statuses: [] })).total, 0);
    const done = yield* service.mutate({
      kind: "status",
      commandId: "done",
      id: first.id,
      expectedRevision: 1,
      status: "done",
    });
    assert.isNotNull(done.completedAt);
    const reopened = yield* service.mutate({
      kind: "status",
      commandId: "reopen",
      id: first.id,
      expectedRevision: 2,
      status: "backlog",
    });
    assert.isNull(reopened.completedAt);
    yield* service.mutate({
      kind: "archive",
      commandId: "archive",
      id: first.id,
      expectedRevision: 3,
      archived: true,
    });
    assert.strictEqual((yield* service.list({})).total, 1);
    assert.strictEqual((yield* service.list({ archived: true })).total, 1);
    const archivedEdit = yield* service
      .mutate({
        kind: "update",
        commandId: "bad-edit",
        id: first.id,
        expectedRevision: 4,
        patch: { title: "no" },
      })
      .pipe(Effect.flip);
    assert.strictEqual(archivedEdit.code, "invalid");
    yield* service.mutate({
      kind: "archive",
      commandId: "restore",
      id: first.id,
      expectedRevision: 4,
      archived: false,
    });
    assert.strictEqual((yield* service.list({})).total, 2);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "deduplicates concurrent retries, rejects changed commands and stale revisions, records facts once",
  () =>
    Effect.gen(function* () {
      const service = yield* WorkItemService;
      const sql = yield* SqlClient.SqlClient;
      const command = create("same");
      const results = yield* Effect.all([service.mutate(command), service.mutate(command)], {
        concurrency: 2,
      });
      assert.deepEqual(results[0], results[1]);
      assert.strictEqual(
        (yield* sql<{ n: number }>`SELECT count(*) AS n FROM work_item_events`)[0]?.n,
        1,
      );
      assert.strictEqual(
        (yield* service
          .mutate({ ...create("different"), commandId: command.commandId })
          .pipe(Effect.flip)).code,
        "conflict",
      );
      yield* service.mutate({
        kind: "update",
        commandId: "edit",
        id: command.id,
        expectedRevision: 1,
        patch: { title: "New" },
      });
      assert.strictEqual((yield* service.mutate(command)).revision, 1);
      assert.strictEqual((yield* service.get(command.id)).title, "New");
      const stale = yield* service
        .mutate({
          kind: "update",
          commandId: "stale",
          id: command.id,
          expectedRevision: 1,
          patch: { title: "Lost" },
        })
        .pipe(Effect.flip);
      assert.strictEqual(stale.code, "conflict");
      assert.strictEqual(
        (yield* sql<{ n: number }>`SELECT count(*) AS n FROM work_item_events`)[0]?.n,
        2,
      );
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "enforces source identity across items atomically, and supports detaching and reattaching",
  () =>
    Effect.gen(function* () {
      const service = yield* WorkItemService;
      const resource = {
        source: "github_issue" as const,
        namespace: "github.com/acme/repo",
        externalId: "42",
        url: "https://github.com/acme/repo/issues/42",
      };
      const item = yield* service.mutate({
        ...create("issue"),
        kind: "create",
        title: "Issue",
        fields: {},
        source: "github_issue",
        resource,
      });
      yield* service.mutate(create("other"));
      const duplicate = yield* service
        .mutate({
          kind: "attachResource",
          commandId: "duplicate",
          id: WorkItemId.make("other"),
          expectedRevision: 1,
          resource,
        })
        .pipe(Effect.flip);
      assert.strictEqual(duplicate.code, "conflict");
      assert.strictEqual((yield* service.get("other")).revision, 1);
      yield* service.mutate({
        kind: "detachResource",
        commandId: "detach",
        id: item.id,
        expectedRevision: 1,
        resource,
      });
      const attached = yield* service.mutate({
        kind: "attachResource",
        commandId: "attach",
        id: WorkItemId.make("other"),
        expectedRevision: 1,
        resource,
      });
      assert.strictEqual(attached.externalId, "42");
      assert.strictEqual(attached.status, "inbox");
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "rejects execution states, missing blocked reasons and malformed input without writes",
  () =>
    Effect.gen(function* () {
      const service = yield* WorkItemService;
      const item = yield* service.mutate(create("states"));
      for (const status of ["planning", "awaiting_approval", "running", "blocked"] as const) {
        const error = yield* service
          .mutate({ kind: "status", commandId: status, id: item.id, expectedRevision: 1, status })
          .pipe(Effect.flip);
        assert.strictEqual(error.code, "invalid");
      }
      assert.strictEqual(
        (yield* service.mutate(create("blank", { title: "   " })).pipe(Effect.flip)).code,
        "invalid",
      );
      assert.strictEqual((yield* service.list({ limit: 101 }).pipe(Effect.flip)).code, "invalid");
      const blocked = yield* service.mutate({
        kind: "status",
        commandId: "blocked-reason",
        id: item.id,
        expectedRevision: 1,
        status: "blocked",
        reason: "Needs a decision",
      });
      assert.strictEqual(blocked.failureReason, "Needs a decision");
      assert.strictEqual((yield* service.get(item.id)).revision, 2);
    }).pipe(Effect.provide(layer)),
);

it.effect("enforces project ownership, missing threads, parent cycles and child reassignment", () =>
  Effect.gen(function* () {
    const service = yield* WorkItemService;
    const sql = yield* SqlClient.SqlClient;
    for (const id of ["p1", "p2"]) {
      yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at)
      VALUES (${id},${id},${`/tmp/${id}`},'[]','2026-01-01','2026-01-01')`;
    }
    const parent = yield* service.mutate(create("parent", { projectId: ProjectId.make("p1") }));
    yield* service.mutate(
      create("child", { projectId: ProjectId.make("p1"), parentWorkItemId: parent.id }),
    );
    const cycle = yield* service
      .mutate({
        kind: "update",
        commandId: "cycle",
        id: parent.id,
        expectedRevision: 1,
        patch: { parentWorkItemId: WorkItemId.make("child") },
      })
      .pipe(Effect.flip);
    assert.strictEqual(cycle.code, "invalid");
    assert.strictEqual(
      (yield* service
        .mutate(create("cross", { projectId: ProjectId.make("p2"), parentWorkItemId: parent.id }))
        .pipe(Effect.flip)).code,
      "invalid",
    );
    assert.strictEqual(
      (yield* service
        .mutate(create("missing", { projectId: ProjectId.make("missing") }))
        .pipe(Effect.flip)).code,
      "invalid",
    );
    assert.strictEqual(
      (yield* service
        .mutate(
          create("thread", {
            projectId: ProjectId.make("p1"),
            agentThreadId: ThreadId.make("missing"),
          }),
        )
        .pipe(Effect.flip)).code,
      "invalid",
    );
    const reassign = yield* service
      .mutate({
        kind: "update",
        commandId: "reassign",
        id: parent.id,
        expectedRevision: 1,
        patch: { projectId: ProjectId.make("p2") },
      })
      .pipe(Effect.flip);
    assert.strictEqual(reassign.code, "invalid");
    assert.strictEqual((yield* service.list({ projectId: ProjectId.make("p1") })).total, 2);
  }).pipe(Effect.provide(layer)),
);

it.effect("streams an initial snapshot and committed changes to another subscriber", () =>
  Effect.gen(function* () {
    const service = yield* WorkItemService;
    const ready = yield* Deferred.make<void>();
    const fiber = yield* service.subscribe({}).pipe(
      Stream.tap(() => Deferred.succeed(ready, undefined)),
      Stream.take(2),
      Stream.runCollect,
      Effect.forkChild,
    );
    yield* Deferred.await(ready);
    yield* service.mutate(create("live"));
    const snapshots = yield* Fiber.join(fiber);
    assert.strictEqual(snapshots[0]?.total, 0);
    assert.strictEqual(snapshots[1]?.items[0]?.title, "live");
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("rolls back rows, resource claims and receipts when recording activity fails", () =>
  Effect.gen(function* () {
    const service = yield* WorkItemService;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TRIGGER reject_event BEFORE INSERT ON work_item_events BEGIN SELECT RAISE(ABORT, 'test failure'); END`;
    assert.strictEqual(
      (yield* service.mutate(create("rollback")).pipe(Effect.flip)).code,
      "storage",
    );
    assert.strictEqual((yield* service.list({})).total, 0);
    assert.strictEqual(
      (yield* sql<{ n: number }>`SELECT count(*) AS n FROM work_item_commands`)[0]?.n,
      0,
    );
    yield* sql`DROP TRIGGER reject_event`;
    yield* service.mutate(create("rollback"));
    assert.strictEqual((yield* service.list({})).total, 1);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "retains full details and retry receipts after service recreation while bounding list previews",
  () =>
    Effect.gen(function* () {
      const first = yield* WorkItemService;
      const command = create("durable", { body: "x".repeat(100_000) });
      const item = yield* first.mutate(command);
      const second = yield* make;
      assert.strictEqual((yield* second.get(item.id)).body.length, 100_000);
      assert.strictEqual((yield* second.list({})).items[0]?.bodyPreview.length, 1000);
      assert.deepEqual(yield* second.mutate(command), item);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "assigns and detaches agent threads, and retains tasks after an upstream project disappears",
  () =>
    Effect.gen(function* () {
      const service = yield* WorkItemService;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at)
    VALUES ('owned','Owned','/tmp/owned','[]','2026-01-01','2026-01-01')`;
      yield* sql`INSERT INTO projection_threads(thread_id,project_id,title,model_selection_json,created_at,updated_at)
    VALUES ('thread','owned','Thread','{"instanceId":"codex","model":"gpt-5.4"}','2026-01-01','2026-01-01')`;
      const item = yield* service.mutate(
        create("assigned", { projectId: ProjectId.make("owned") }),
      );
      const assigned = yield* service.mutate({
        kind: "update",
        id: item.id,
        commandId: "assign",
        expectedRevision: 1,
        patch: {
          agentThreadId: ThreadId.make("thread"),
          assignedAgent: ProviderInstanceId.make("codex"),
        },
      });
      assert.equal(assigned.agentThreadId, "thread");
      assert.equal(assigned.status, "running");
      yield* sql`INSERT INTO work_item_executions(id,work_item_id,thread_id,status,record_json)
        VALUES ('active-run',${item.id},'thread','running','{}')`;
      const activeEdit = yield* service
        .mutate({
          kind: "update",
          id: item.id,
          commandId: "detach-active-thread",
          expectedRevision: 2,
          patch: { agentThreadId: null },
        })
        .pipe(Effect.flip);
      assert.equal(activeEdit.code, "invalid");
      yield* sql`UPDATE work_item_executions SET status='succeeded' WHERE id='active-run'`;
      assert.equal((yield* service.list({ agentThreadId: ThreadId.make("thread") })).total, 1);
      assert.equal((yield* service.list({ agentThreadId: ThreadId.make("other") })).total, 0);
      assert.equal(
        (yield* service.list({ assignedAgent: ProviderInstanceId.make("codex") })).total,
        1,
      );
      yield* service.mutate({
        kind: "update",
        id: item.id,
        commandId: "detach-thread",
        expectedRevision: 2,
        patch: { agentThreadId: null, assignedAgent: null },
      });
      assert.equal((yield* service.get(item.id)).agentThreadId, null);
      assert.equal((yield* service.get(item.id)).status, "ready");
      assert.equal((yield* service.list({ agentThreadId: ThreadId.make("thread") })).total, 0);
      yield* sql`UPDATE projection_projects SET deleted_at='2026-02-01' WHERE project_id='owned'`;
      const changed = yield* service.mutate({
        kind: "update",
        id: item.id,
        commandId: "rename-orphan",
        expectedRevision: 3,
        patch: { title: "Retained task" },
      });
      assert.equal(changed.title, "Retained task");
      yield* service.mutate({
        kind: "archive",
        id: item.id,
        commandId: "archive-orphan",
        expectedRevision: 4,
        archived: true,
      });
      assert.equal((yield* service.list({ archived: true })).total, 1);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "permanently deletes archived task records and history, detaches children and keeps source tombstones",
  () =>
    Effect.gen(function* () {
      const service = yield* WorkItemService;
      const sql = yield* SqlClient.SqlClient;
      const resource = {
        source: "github_issue" as const,
        namespace: "github.com/org/repo",
        externalId: "9",
        url: "https://github.com/org/repo/issues/9",
      };
      const parent = yield* service.mutate({
        ...create("deleted-parent"),
        kind: "create",
        source: "github_issue",
        resource,
        title: "Delete me",
        fields: {},
      });
      const child = yield* service.mutate(
        create("surviving-child", { parentWorkItemId: parent.id }),
      );
      const archived = yield* service.mutate({
        kind: "archive",
        id: parent.id,
        commandId: "archive-parent",
        expectedRevision: parent.revision,
        archived: true,
      });
      for (const table of ["work_item_plans", "work_item_pull_requests"])
        yield* sql`INSERT INTO ${sql(table)}(work_item_id,record_json) VALUES (${parent.id},'{}')`;
      yield* sql`INSERT INTO work_item_plan_history(work_item_id,revision,record_json) VALUES (${parent.id},1,'{}')`;
      yield* sql`INSERT INTO work_item_reviews(work_item_id,snapshot_json,sync_error) VALUES (${parent.id},'{}',NULL)`;
      yield* sql`INSERT INTO work_item_executions(id,work_item_id,thread_id,status,record_json) VALUES ('run',${parent.id},'kept-thread','succeeded','{}')`;
      yield* sql`INSERT INTO work_item_activity(id,work_item_id,occurred_at,record_json) VALUES ('activity',${parent.id},'now','{}')`;
      const command = {
        id: parent.id,
        expectedRevision: archived.revision,
        commandId: "delete-parent",
      };
      yield* service.deleteArchived(command);
      yield* service.deleteArchived(command);
      assert.strictEqual((yield* service.get(parent.id).pipe(Effect.flip)).code, "not_found");
      assert.strictEqual((yield* service.list({ archived: true })).total, 0);
      const surviving = yield* service.get(child.id);
      assert.isNull(surviving.parentWorkItemId);
      assert.strictEqual(surviving.revision, child.revision + 1);
      for (const table of [
        "work_item_plans",
        "work_item_plan_history",
        "work_item_pull_requests",
        "work_item_reviews",
        "work_item_executions",
        "work_item_activity",
        "work_item_events",
        "work_item_commands",
        "work_item_resources",
      ])
        assert.lengthOf(yield* sql`SELECT * FROM ${sql(table)} WHERE work_item_id=${parent.id}`, 0);
      assert.isTrue(yield* service.isResourceDeleted(resource));
      assert.strictEqual(
        (yield* service.mutate(create("deleted-parent")).pipe(Effect.flip)).code,
        "invalid",
      );
      assert.strictEqual(
        (yield* service.deleteArchived({ ...command, expectedRevision: 1 }).pipe(Effect.flip)).code,
        "conflict",
      );
    }).pipe(Effect.provide(layer)),
);

it.effect("rejects deletion of unarchived, restored or changed tasks", () =>
  Effect.gen(function* () {
    const service = yield* WorkItemService;
    const item = yield* service.mutate(create("keep"));
    assert.strictEqual(
      (yield* service
        .deleteArchived({
          id: item.id,
          commandId: "delete-active",
          expectedRevision: item.revision,
        })
        .pipe(Effect.flip)).code,
      "invalid",
    );
    const archived = yield* service.mutate({
      kind: "archive",
      id: item.id,
      commandId: "archive-keep",
      expectedRevision: item.revision,
      archived: true,
    });
    assert.strictEqual(
      (yield* service
        .deleteArchived({ id: item.id, commandId: "delete-stale", expectedRevision: item.revision })
        .pipe(Effect.flip)).code,
      "conflict",
    );
    yield* service.mutate({
      kind: "archive",
      id: item.id,
      commandId: "restore-keep",
      expectedRevision: archived.revision,
      archived: false,
    });
    assert.strictEqual(
      (yield* service
        .deleteArchived({
          id: item.id,
          commandId: "delete-restored",
          expectedRevision: archived.revision,
        })
        .pipe(Effect.flip)).code,
      "conflict",
    );
    assert.strictEqual((yield* service.list({})).total, 1);
  }).pipe(Effect.provide(layer)),
);
