import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  WorkItemId,
  type ServerProvider,
  type WorkPlanContent,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import * as WorkItems from "./WorkItemService.ts";
import { WorkPlanGenerator } from "./WorkPlanGenerator.ts";
import { make } from "./WorkPlanService.ts";
const content: WorkPlanContent = {
  summary: "Add feature",
  proposedChanges: ["Implement"],
  affectedFiles: ["src/app.ts"],
  steps: ["Inspect", "Implement"],
  tests: ["Regression test"],
  risks: ["Compatibility"],
  questions: [],
  complexity: "medium",
};
const selection = { instanceId: ProviderInstanceId.make("codex"), model: "test-model" };
const provider: ServerProvider = {
  instanceId: selection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-01-01T00:00:00Z",
  models: [{ slug: "test-model", name: "Test model", isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
};
const setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES ('project','Project','/repo','[]','2026','2026')`;
  const work = yield* WorkItems.make;
  const item = yield* work.mutate({
    kind: "create",
    commandId: "create",
    id: WorkItemId.make("task"),
    title: "Task",
    source: "manual",
    fields: { projectId: ProjectId.make("project"), body: "Description" },
  });
  const ready = yield* work.mutate({
    kind: "status",
    commandId: "ready",
    id: item.id,
    expectedRevision: 1,
    status: "ready",
  });
  const entered = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  const calls = yield* Ref.make(0);
  const commands: OrchestrationCommand[] = [];
  const generator = WorkPlanGenerator.of({
    agents: () => Effect.succeed([provider]),
    generate: Effect.fn(function* () {
      yield* Ref.update(calls, (n) => n + 1);
      yield* Deferred.succeed(entered, undefined);
      yield* Deferred.await(release);
      return { content, inspectedFiles: ["src/app.ts"] };
    }),
  });
  const engineLayer = Layer.mock(OrchestrationEngineService)({
    dispatch: (command) => {
      commands.push(command);
      return Effect.succeed({ sequence: commands.length });
    },
  });
  const createService = make.pipe(
    Effect.provideService(WorkItems.WorkItemService, work),
    Effect.provideService(WorkPlanGenerator, generator),
    Effect.provide(engineLayer),
  );
  const service = yield* createService;
  const start = {
    kind: "start" as const,
    commandId: "generate-1",
    id: item.id,
    expectedWorkItemRevision: ready.revision,
    modelSelection: selection,
  };
  return { service, work, item, entered, release, calls, commands, start, createService, sql };
});
const settled = (service: Effect.Success<typeof make>, id: WorkItemId) =>
  service.subscribe(id).pipe(
    Stream.filter((state) => state.plan !== null && state.plan.status !== "generating"),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );
it.effect("assigns the selected repository and starts planning from an unassigned inbox task", () =>
  Effect.gen(function* () {
    const ctx = yield* setup;
    const item = yield* ctx.work.mutate({
      kind: "create",
      commandId: "new-task",
      id: WorkItemId.make("inbox-task"),
      title: "Imported issue",
      fields: {},
      source: "manual",
    });
    const input = {
      ...ctx.start,
      id: item.id,
      expectedWorkItemRevision: item.revision,
      projectId: ProjectId.make("project"),
    };
    yield* ctx.service.mutate(input);
    yield* Deferred.await(ctx.entered);
    yield* ctx.service.mutate(input);
    const state = yield* ctx.service.get(item.id);
    assert.equal(state.item.projectId, "project");
    assert.equal(state.item.status, "planning");
    assert.equal(yield* Ref.get(ctx.calls), 1);
    const created = ctx.commands.find((command) => command.type === "thread.create");
    assert.equal(
      created?.type === "thread.create" ? created.projectId : null,
      ProjectId.make("project"),
    );
    yield* Deferred.succeed(ctx.release, undefined);
    assert.equal((yield* settled(ctx.service, item.id)).item.status, "awaiting_approval");
  }).pipe(Effect.provide(SqlitePersistenceMemory), Effect.scoped),
);

it.effect("rejects an unavailable repository without changing the task or starting an agent", () =>
  Effect.gen(function* () {
    const ctx = yield* setup;
    const failure = yield* ctx.service
      .mutate({ ...ctx.start, projectId: ProjectId.make("missing") })
      .pipe(Effect.flip);
    assert.equal(failure.code, "invalid");
    assert.equal((yield* ctx.work.get(ctx.item.id)).projectId, "project");
    assert.equal((yield* ctx.service.get(ctx.item.id)).plan, null);
    assert.equal(ctx.commands.length, 0);
  }).pipe(Effect.provide(SqlitePersistenceMemory), Effect.scoped),
);

it.effect(
  "persists plans and transcripts, deduplicates starts and keeps approval separate from execution",
  () =>
    Effect.gen(function* () {
      const { service, work, item, release, entered, commands, start, calls, sql } = yield* setup;
      yield* service.mutate(start);
      yield* Deferred.await(entered);
      assert.strictEqual((yield* work.get(item.id)).status, "planning");
      yield* service.mutate(start);
      assert.strictEqual(yield* Ref.get(calls), 1);
      yield* Deferred.succeed(release, undefined);
      const state = yield* settled(service, item.id);
      assert.strictEqual(state.item.status, "awaiting_approval");
      assert.deepEqual(state.plan?.content, content);
      assert.deepEqual(state.plan?.inspectedFiles, ["src/app.ts"]);
      assert.deepEqual(
        commands.map((command) => command.type),
        ["thread.create", "thread.history.import"],
      );
      assert.strictEqual(state.item.agentThreadId, state.plan?.threadId);
      const approve = {
        kind: "approve" as const,
        id: item.id,
        commandId: "approve",
        expectedRevision: state.plan!.revision,
      };
      yield* service.mutate(approve);
      yield* service.mutate(approve);
      const approved = yield* service.get(item.id);
      assert.strictEqual(approved.plan?.status, "approved");
      assert.strictEqual(approved.item.status, "ready");
      assert.strictEqual(approved.plan?.approvedWorkItemRevision, approved.item.revision);
      assert.strictEqual(yield* Ref.get(calls), 1);
      assert.strictEqual(
        (yield* sql<{ n: number }>`SELECT count(*) AS n FROM work_item_plan_history`)[0]?.n,
        3,
      );
    }).pipe(Effect.provide(SqlitePersistenceMemory), Effect.scoped),
);
it.effect(
  "edits invalidate approval, stale edits conflict, and reject/replan retains previous versions",
  () =>
    Effect.gen(function* () {
      const { service, item, start, entered, release, sql } = yield* setup;
      yield* service.mutate(start);
      yield* Deferred.await(entered);
      yield* Deferred.succeed(release, undefined);
      const draft = (yield* settled(service, item.id)).plan!;
      yield* service.mutate({
        kind: "approve",
        id: item.id,
        commandId: "approve",
        expectedRevision: draft.revision,
      });
      const approved = (yield* service.get(item.id)).plan!;
      yield* service.mutate({
        kind: "edit",
        id: item.id,
        commandId: "edit",
        expectedRevision: approved.revision,
        content: { ...content, summary: "Edited" },
      });
      const edited = yield* service.get(item.id);
      assert.isNull(edited.plan?.approvedAt);
      assert.isNull(edited.plan?.approvedWorkItemRevision);
      assert.strictEqual(edited.plan?.status, "draft");
      assert.strictEqual(
        (yield* service
          .mutate({
            kind: "edit",
            id: item.id,
            commandId: "stale",
            expectedRevision: approved.revision,
            content,
          })
          .pipe(Effect.flip)).code,
        "conflict",
      );
      yield* service.mutate({
        kind: "reject",
        id: item.id,
        commandId: "reject",
        expectedRevision: edited.plan!.revision,
      });
      const rejected = yield* service.get(item.id);
      assert.strictEqual(rejected.item.status, "ready");
      yield* service.mutate({
        ...start,
        commandId: "generate-2",
        expectedWorkItemRevision: rejected.item.revision,
        feedback: "Improve tests",
      });
      const regenerated = yield* settled(service, item.id);
      assert.strictEqual(regenerated.plan?.generationId, "generate-2");
      assert.notEqual(regenerated.plan?.threadId, draft.threadId);
      assert.isTrue(
        (yield* sql<{ n: number }>`SELECT count(*) AS n FROM work_item_plan_history`)[0]!.n >= 6,
      );
    }).pipe(Effect.provide(SqlitePersistenceMemory), Effect.scoped),
);
it.effect("cancels a blocked provider call and refuses its late result", () =>
  Effect.gen(function* () {
    const { service, item, start, entered, release, work } = yield* setup;
    yield* service.mutate(start);
    yield* Deferred.await(entered);
    const active = (yield* service.get(item.id)).plan!;
    assert.strictEqual(
      (yield* work
        .mutate({
          kind: "status",
          id: item.id,
          commandId: "manual",
          expectedRevision: 3,
          status: "done",
        })
        .pipe(Effect.flip)).code,
      "invalid",
    );
    yield* service.mutate({
      kind: "cancel",
      id: item.id,
      commandId: "cancel",
      expectedRevision: active.revision,
    });
    yield* Deferred.succeed(release, undefined);
    const cancelled = yield* service.get(item.id);
    assert.strictEqual(cancelled.item.status, "ready");
    assert.strictEqual(cancelled.plan?.status, "failed");
    assert.isNull(cancelled.plan?.content);
  }).pipe(Effect.provide(SqlitePersistenceMemory), Effect.scoped),
);
it.effect("recovers interrupted generation without repeating provider work", () =>
  Effect.gen(function* () {
    const { service, item, start, entered, calls, createService } = yield* setup;
    yield* service.mutate(start);
    yield* Deferred.await(entered);
    const recreated = yield* createService;
    const recovered = yield* recreated.get(item.id);
    assert.strictEqual(recovered.plan?.status, "failed");
    assert.include(recovered.plan?.error ?? "", "restart");
    assert.strictEqual(recovered.item.status, "ready");
    assert.strictEqual(yield* Ref.get(calls), 1);
  }).pipe(Effect.provide(SqlitePersistenceMemory), Effect.scoped),
);
it.effect(
  "rejects invalid providers, stale work and changed receipts before starting another provider call",
  () =>
    Effect.gen(function* () {
      const { service, start, commands, entered } = yield* setup;
      assert.strictEqual(
        (yield* service
          .mutate({ ...start, modelSelection: { ...selection, model: "missing" } })
          .pipe(Effect.flip)).code,
        "unavailable",
      );
      assert.strictEqual(commands.length, 0);
      assert.strictEqual(
        (yield* service.mutate({ ...start, expectedWorkItemRevision: 1 }).pipe(Effect.flip)).code,
        "conflict",
      );
      yield* service.mutate(start);
      yield* Deferred.await(entered);
      assert.strictEqual(
        (yield* service.mutate({ ...start, feedback: "changed" }).pipe(Effect.flip)).code,
        "conflict",
      );
    }).pipe(Effect.provide(SqlitePersistenceMemory), Effect.scoped),
);

it.effect("keeps plan results without a stale thread action after deletion during generation", () =>
  Effect.gen(function* () {
    const ctx = yield* setup;
    yield* ctx.service.mutate(ctx.start);
    yield* Deferred.await(ctx.entered);
    const threadId = (yield* ctx.service.get(ctx.item.id)).plan!.threadId;
    yield* ctx.sql`INSERT INTO projection_threads(thread_id,project_id,title,model_selection_json,created_at,updated_at)
      VALUES (${threadId},'project','Plan','{"instanceId":"codex","model":"test"}','2026','2026')`;
    assert.isTrue((yield* ctx.service.get(ctx.item.id)).threadAvailable);
    yield* ctx.sql`UPDATE projection_threads SET deleted_at='2026' WHERE thread_id=${threadId}`;
    yield* ctx.work.clearDeletedThreadLinks(threadId);
    yield* Deferred.succeed(ctx.release, undefined);
    const state = yield* settled(ctx.service, ctx.item.id);
    assert.isNull(state.item.agentThreadId);
    assert.equal(state.item.status, "blocked");
    assert.isFalse(state.threadAvailable);
    assert.deepEqual(state.plan?.content, content);
  }).pipe(Effect.provide(SqlitePersistenceMemory), Effect.scoped),
);
