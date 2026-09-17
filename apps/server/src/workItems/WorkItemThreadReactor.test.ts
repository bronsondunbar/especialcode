import { assert, it } from "@effect/vitest";
import {
  CommandId,
  CorrelationId,
  EventId,
  ProjectId,
  ThreadId,
  WorkItemId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { make, WorkItemService } from "./WorkItemService.ts";
import { start } from "./WorkItemThreadReactor.ts";

const at = "2026-09-17T10:00:00.000Z";
const setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const work = yield* make;
  yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at)
    VALUES ('project','Project','/repo','[]',${at},${at})`;
  for (const id of ["thread", "replacement"]) {
    yield* sql`INSERT INTO projection_threads(thread_id,project_id,title,model_selection_json,created_at,updated_at)
      VALUES (${id},'project','Thread','{"instanceId":"codex","model":"test"}',${at},${at})`;
  }
  const create = (id: string, threadId = "thread") =>
    work.mutate({
      kind: "create",
      id: WorkItemId.make(id),
      commandId: `create:${id}`,
      title: id,
      source: "github_issue",
      fields: { projectId: ProjectId.make("project"), agentThreadId: ThreadId.make(threadId) },
      resource: {
        source: "github_issue",
        namespace: "github.com/acme/app",
        externalId: id,
        url: `https://github.com/acme/app/issues/${id}`,
      },
    });
  const events = yield* Queue.unbounded<OrchestrationEvent>();
  const startReactor = start().pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(WorkItemService, work),
        Layer.mock(OrchestrationEngineService)({
          subscribeDomainEvents: Effect.succeed(Stream.fromQueue(events)),
        }),
      ),
    ),
  );
  return { sql, work, create, events, startReactor };
});

it.effect("deleting a thread removes the persisted issue link and updates subscribers", () =>
  Effect.gen(function* () {
    const ctx = yield* setup;
    const item = yield* ctx.create("1");
    yield* ctx.startReactor;
    yield* ctx.sql`UPDATE projection_threads SET deleted_at=${at} WHERE thread_id='thread'`;
    yield* Queue.offer(ctx.events, {
      type: "thread.deleted",
      sequence: 1,
      eventId: EventId.make("deleted"),
      aggregateKind: "thread",
      aggregateId: ThreadId.make("thread"),
      occurredAt: at,
      commandId: CommandId.make("delete"),
      correlationId: CorrelationId.make("delete"),
      causationEventId: null,
      metadata: {},
      payload: { threadId: ThreadId.make("thread"), deletedAt: at },
    });
    yield* ctx.work.subscribe({}).pipe(
      Stream.filter((result) =>
        result.items.some((task) => task.id === item.id && task.agentThreadId === null),
      ),
      Stream.runHead,
    );
    const updated = yield* ctx.work.get(item.id);
    assert.isNull(updated.agentThreadId);
    assert.equal(updated.status, "blocked");
    assert.include(updated.failureReason ?? "", "deleted");
    assert.deepEqual(updated.resources, item.resources);
    assert.equal((yield* ctx.work.list({ agentThreadId: ThreadId.make("thread") })).total, 0);
    yield* ctx.work.clearDeletedThreadLinks("thread");
    assert.deepEqual(yield* ctx.work.get(item.id), updated);
    const replacement = yield* ctx.work.mutate({
      kind: "update",
      id: item.id,
      commandId: "replace",
      expectedRevision: updated.revision,
      patch: { agentThreadId: ThreadId.make("replacement") },
    });
    yield* ctx.work.clearDeletedThreadLinks("thread");
    assert.deepEqual(yield* ctx.work.get(item.id), replacement);
  }).pipe(Effect.provide(SqlitePersistenceMemory), Effect.scoped),
);

it.effect(
  "startup repairs existing stale links while preserving completed, archived and live threads",
  () =>
    Effect.gen(function* () {
      const ctx = yield* setup;
      const review = yield* ctx.create("1");
      const done = yield* ctx.create("2");
      const archived = yield* ctx.create("3");
      const live = yield* ctx.create("4", "replacement");
      for (const [item, status] of [
        [review, "review"],
        [done, "done"],
        [archived, "done"],
      ] as const) {
        yield* ctx.work.mutate({
          kind: "status",
          id: item.id,
          commandId: `status:${item.id}`,
          expectedRevision: item.revision,
          status,
        });
      }
      const current = yield* ctx.work.get(archived.id);
      const beforeArchived = yield* ctx.work.mutate({
        kind: "archive",
        id: archived.id,
        commandId: "archive",
        expectedRevision: current.revision,
        archived: true,
      });
      yield* ctx.sql`DELETE FROM projection_threads WHERE thread_id='thread'`;
      yield* ctx.sql`UPDATE projection_threads SET archived_at=${at} WHERE thread_id='replacement'`;
      yield* ctx.startReactor;
      for (const [item, status] of [
        [review, "review"],
        [done, "done"],
        [archived, "done"],
      ] as const) {
        const updated = yield* ctx.work.get(item.id);
        assert.isNull(updated.agentThreadId);
        assert.equal(updated.status, status);
      }
      assert.equal((yield* ctx.work.get(archived.id)).archivedAt, beforeArchived.archivedAt);
      assert.deepEqual(yield* ctx.work.get(live.id), live);
    }).pipe(Effect.provide(SqlitePersistenceMemory), Effect.scoped),
);
