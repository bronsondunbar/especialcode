import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WorkItemId,
  type WorkItemSource,
  type WorkItemStatus,
  type WorkDashboardInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as Work from "./WorkItemService.ts";
import { WorkActivityService } from "./WorkActivityService.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { make } from "./WorkDashboardService.ts";
import { makeWorkActivityRepository } from "../persistence/WorkActivity.ts";
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const at = "2026-09-15T10:00:00.000Z";
const setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES ('project','Project','/repo','[]',${at},${at})`;
  yield* sql`INSERT INTO projection_threads(thread_id,project_id,title,model_selection_json,created_at,updated_at) VALUES ('thread','project','Thread','{}',${at},${at})`;
  const work = yield* Work.make;
  const activity = yield* makeWorkActivityRepository;
  const service = yield* make.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(Work.WorkItemService, work),
        Layer.mock(WorkActivityService)({ changes: Stream.empty }),
        Layer.mock(OrchestrationEngineService)({
          subscribeDomainEvents: Effect.succeed(Stream.never),
        }),
      ),
    ),
  );
  const create = Effect.fn(function* (
    name: string,
    status: WorkItemStatus = "inbox",
    source: WorkItemSource = "manual",
  ) {
    const item = yield* work.mutate({
      kind: "create",
      commandId: `create-${name}`,
      id: WorkItemId.make(name),
      title: name,
      source,
      ...(source === "manual"
        ? {}
        : {
            resource: {
              source,
              namespace: "test",
              externalId: name,
              url: `https://example.com/${name}`,
            },
          }),
      fields: {
        body: "Private long body",
        projectId: ProjectId.make("project"),
        repository: "example/repo",
        assignedAgent: ProviderInstanceId.make("codex"),
        agentThreadId: ThreadId.make("thread"),
        priority: "high",
      },
    });
    yield* sql`UPDATE work_items SET status=${status},record_json=json_set(record_json,'$.status',${status}) WHERE id=${item.id}`;
    return item;
  });
  const execution = Effect.fn(function* (id: string, status: string, runId = id) {
    yield* sql`INSERT INTO work_item_executions(id,work_item_id,thread_id,status,record_json) VALUES (${runId},${id},${`thread-${runId}`},${status},${json({ status, modelSelection: { instanceId: "codex" }, agentName: "Codex", activity: "Implementing the approved plan", validationResults: [{ output: "Private logs" }] })})`;
  });
  const plan = Effect.fn(function* (id: string, revision: number, status = "approved") {
    yield* sql`INSERT INTO work_item_plans(work_item_id,record_json) VALUES (${id},${json({ status, approvedWorkItemRevision: revision })}) ON CONFLICT(work_item_id) DO UPDATE SET record_json=excluded.record_json`;
  });
  const review = Effect.fn(function* (id: string, state = "open", failed = true) {
    yield* sql`INSERT INTO work_item_reviews(work_item_id,snapshot_json) VALUES (${id},${json({ state, reviewDecision: failed ? "changes-requested" : "approved", reviewers: failed ? ["reviewer"] : [], checks: [{ status: failed ? "failure" : "success" }] })}) ON CONFLICT(work_item_id) DO UPDATE SET snapshot_json=excluded.snapshot_json`;
  });
  return { sql, work, service, create, execution, plan, review, activity };
});
it.effect("classifies current work and clears resolved agent and PR attention", () =>
  Effect.gen(function* () {
    const c = yield* setup;
    yield* c.create("active", "running");
    yield* c.execution("active", "running");
    yield* c.create("failed", "blocked");
    yield* c.execution("failed", "failed");
    const approved = yield* c.create("approved", "ready");
    yield* c.plan("approved", approved.revision);
    yield* c.create("draft", "ready");
    yield* c.plan("draft", 1, "draft");
    yield* c.create("stale", "ready");
    yield* c.plan("stale", 9);
    yield* c.create("review", "review");
    yield* c.review("review");
    yield* c.create("inbox", "inbox", "slack");
    yield* c.create("done", "done");
    yield* c.execution("done", "failed");
    yield* c.sql`UPDATE projection_threads SET pending_user_input_count=1 WHERE thread_id='thread'`;
    let page = yield* c.service.list({});
    assert.deepEqual(
      page.sections.find((s) => s.id === "ready")?.items.map((i) => i.id),
      ["approved"],
    );
    assert.deepEqual(
      page.sections.find((s) => s.id === "running")?.items.map((i) => i.id),
      ["active"],
    );
    assert.strictEqual(page.sections.find((s) => s.id === "blocked")?.total, 1);
    assert.strictEqual(page.sections.find((s) => s.id === "inbox")?.items[0]?.source, "slack");
    assert.isTrue(
      page.sections
        .find((s) => s.id === "attention")!
        .items.find((i) => i.id === "active")!
        .reasons.includes("Agent needs input"),
    );
    assert.isFalse(json(page).includes("Private"));
    yield* c.sql`UPDATE projection_threads SET pending_user_input_count=0,pending_approval_count=0 WHERE thread_id='thread'`;
    yield* c.review("review", "open", false);
    page = yield* c.service.list({ section: "attention" });
    assert.deepEqual(
      page.sections[0]?.items.map((i) => i.id),
      ["failed"],
    );
    assert.strictEqual((yield* c.service.list({ section: "review" })).sections[0]?.total, 1);
    yield* c.sql`UPDATE work_items SET status='backlog',record_json=json_set(record_json,'$.status','backlog') WHERE id='review'`;
    yield* c.review("review", "merged", true);
    assert.strictEqual((yield* c.service.list({ section: "review" })).sections[0]?.total, 0);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
it.effect("uses the latest execution and excludes archived tasks", () =>
  Effect.gen(function* () {
    const c = yield* setup;
    const item = yield* c.create("retry", "running");
    yield* c.execution("retry", "failed", "old");
    yield* c.execution("retry", "running", "new");
    assert.strictEqual((yield* c.service.list({ section: "attention" })).sections[0]?.total, 0);
    assert.strictEqual((yield* c.service.list({ section: "running" })).sections[0]?.total, 1);
    yield* c.sql`UPDATE work_item_executions SET status='succeeded',record_json=json_set(record_json,'$.status','succeeded') WHERE id='new'`;
    yield* c.sql`UPDATE work_items SET status='review',record_json=json_set(record_json,'$.status','review') WHERE id=${item.id}`;
    assert.strictEqual((yield* c.service.list({ section: "review" })).sections[0]?.total, 1);
    yield* c.work.mutate({
      kind: "archive",
      id: item.id,
      commandId: "archive",
      expectedRevision: item.revision,
      archived: true,
    });
    assert.strictEqual((yield* c.service.list({ section: "review" })).sections[0]?.total, 0);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
it.effect(
  "applies every filter to tasks and recent activity with complete counts and bounded pages",
  () =>
    Effect.gen(function* () {
      const c = yield* setup;
      for (let n = 0; n < 11; n++) {
        const item = yield* c.create(`item-${n}`);
        yield* c.activity.append({
          id: `activity-${n}`,
          workItemId: item.id,
          kind: "created",
          source: "work",
          occurredAt: at,
          title: "Created",
          summary: "",
          threadId: null,
          url: null,
          details: [],
        });
      }
      const filters: WorkDashboardInput = {
        projectId: ProjectId.make("project"),
        repository: "example/repo",
        source: "manual",
        agent: ProviderInstanceId.make("codex"),
        status: "inbox",
        priority: "high",
        section: "inbox",
      };
      const first = yield* c.service.list(filters);
      assert.strictEqual(first.sections[0]?.total, 11);
      assert.strictEqual(first.sections[0]?.items.length, 8);
      const second = yield* c.service.list({ ...filters, offset: 8 });
      assert.strictEqual(second.sections[0]?.total, 11);
      assert.strictEqual(second.sections[0]?.items.length, 3);
      assert.strictEqual(
        new Set([...first.sections[0]!.items, ...second.sections[0]!.items].map((i) => i.id)).size,
        11,
      );
      assert.strictEqual(first.activity.length, 11);
      for (const patch of [
        { projectId: ProjectId.make("other") },
        { repository: "other/repo" },
        { source: "slack" as const },
        { agent: ProviderInstanceId.make("other") },
        { status: "done" as const },
        { priority: "low" as const },
      ]) {
        const page = yield* c.service.list({ ...filters, ...patch });
        assert.strictEqual(page.sections[0]?.total, 0);
        assert.strictEqual(page.activity.length, 0);
      }
      assert.strictEqual(
        (yield* c.service.list({ ...filters, limit: 26 }).pipe(Effect.result))._tag,
        "Failure",
      );
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
it.effect("filters ready work by the current plan provider instead of an earlier execution", () =>
  Effect.gen(function* () {
    const c = yield* setup;
    const item = yield* c.create("replanned", "ready");
    yield* c.execution("replanned", "failed", "previous");
    yield* c.plan("replanned", item.revision);
    yield* c.sql`UPDATE work_item_plans SET record_json=json_set(record_json,'$.modelSelection.instanceId','claude','$.agentName','Claude') WHERE work_item_id=${item.id}`;
    const page = yield* c.service.list({
      section: "ready",
      agent: ProviderInstanceId.make("claude"),
    });
    assert.strictEqual(page.sections[0]?.items[0]?.agentName, "Claude");
    assert.strictEqual(
      (yield* c.service.list({ section: "ready", agent: ProviderInstanceId.make("codex") }))
        .sections[0]?.total,
      0,
    );
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
it.effect("streams work changes without polling", () =>
  Effect.gen(function* () {
    const c = yield* setup;
    const initial = yield* Deferred.make<void>();
    const observer = yield* c.service.subscribe({ section: "inbox" }).pipe(
      Stream.tap(() => Deferred.succeed(initial, undefined)),
      Stream.take(2),
      Stream.runCollect,
      Effect.forkChild,
    );
    yield* Deferred.await(initial);
    yield* c.create("new");
    const pages = yield* Fiber.join(observer);
    assert.strictEqual(pages[0]?.sections[0]?.total, 0);
    assert.strictEqual(pages[1]?.sections[0]?.total, 1);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
