import { assert, it } from "@effect/vitest";
import {
  AutomationExecutionPolicy,
  AutomationRun,
  WorkExecution,
  WorkExecutionError,
  WorkItemId,
  WorkPlan,
  ThreadId,
  ProviderInstanceId,
  type AutomationConfig,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as Work from "../workItems/WorkItemService.ts";
import { WorkPlanService } from "../workItems/WorkPlanService.ts";
import { WorkExecutionService } from "../workItems/WorkExecutionService.ts";
import { WorkPullRequestService } from "../workItems/WorkPullRequestService.ts";
import * as Events from "../notifications/ApplicationEventService.ts";
import { makeEventRepository } from "./AutomationEvents.ts";
import { make } from "./WorkAutomationService.ts";
const encodeRun = Schema.encodeSync(Schema.fromJsonString(AutomationRun));
const encodeExecution = Schema.encodeSync(Schema.fromJsonString(WorkExecution));
const decodePolicy = Schema.decodeUnknownExit(AutomationExecutionPolicy);
const at = "2026-09-15T10:00:00.000Z";
const id = WorkItemId.make("task");
const model = { instanceId: ProviderInstanceId.make("codex"), model: "test" };
const policy: AutomationExecutionPolicy = {
  trusted: true,
  allowedRepositories: [{ host: "github.com", repository: "example/repo" }],
  allowedLabels: ["agent-ready"],
  allowedProviders: [model.instanceId],
  maxConcurrentRuns: 1,
  permissionMode: "auto-accept-edits",
  requireTests: true,
  requirePullRequest: true,
};
const rule: AutomationConfig = {
  name: "Execute approved work",
  enabled: true,
  trigger: "plan_approved",
  conditions: {},
  execution: policy,
  actions: [
    { kind: "execute_approved", modelSelection: model, validationCommands: ["npm test"] },
    { kind: "notify", message: "PR ready" },
  ],
};
const setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const work = yield* Work.make;
  const appEvents = yield* Events.make;
  const events = yield* makeEventRepository;
  const item = yield* work.mutate({
    kind: "create",
    commandId: "create",
    id,
    title: "Task",
    source: "manual",
    fields: {},
  });
  const plan: WorkPlan = {
    workItemId: id,
    revision: 1,
    generationId: "plan",
    status: "approved",
    modelSelection: model,
    agentName: "Codex",
    threadId: ThreadId.make("plan"),
    createdAt: at,
    generatedAt: at,
    updatedAt: at,
    sourceWorkItemRevision: item.revision,
    approvedWorkItemRevision: item.revision,
    approvedAt: at,
    content: {
      summary: "Implement",
      proposedChanges: [],
      affectedFiles: [],
      steps: [],
      tests: [],
      risks: [],
      questions: [],
      complexity: "low",
    },
    error: null,
    inspectedFiles: [],
  };
  const execution = yield* Ref.make<WorkExecution | null>(null);
  const capacity = yield* Ref.make(false);
  const actions: string[] = [];
  const update = Effect.fn(function* (run: WorkExecution) {
    yield* Ref.set(execution, run);
    yield* sql`INSERT INTO work_item_executions(id,work_item_id,thread_id,status,record_json) VALUES (${run.id},${run.workItemId},${run.threadId},${run.status},${encodeExecution(run)}) ON CONFLICT(id) DO UPDATE SET status=excluded.status,record_json=excluded.record_json`;
  }, Effect.orDie);
  const build = make.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(Work.WorkItemService, work),
        Layer.succeed(Events.ApplicationEventService, appEvents),
        Layer.mock(WorkPlanService)({ get: () => Effect.succeed({ item, plan, agents: [] }) }),
        Layer.mock(WorkExecutionService)({
          get: Effect.fn(function* () {
            return { item, execution: yield* Ref.get(execution), agents: [] };
          }),
          verifyAutomationRepository: () =>
            Effect.sync(() => {
              actions.push("verify-origin");
              return undefined;
            }),
          startAutomation: Effect.fn(function* (input, owner) {
            if (yield* Ref.get(capacity))
              return yield* new WorkExecutionError({
                code: "capacity",
                message: "Waiting for capacity",
              });
            actions.push("start");
            yield* update({
              id: input.commandId,
              workItemId: id,
              revision: 1,
              planRevision: 1,
              threadId: ThreadId.make(`execution:${input.commandId}`),
              turnId: null,
              modelSelection: model,
              agentName: "Codex",
              branch: "task/branch",
              baseRef: "main",
              worktreePath: "/repo/worktree",
              threadReady: true,
              status: "running",
              activity: "Running",
              error: null,
              startedAt: at,
              updatedAt: at,
              completedAt: null,
              validationCommands: input.validationCommands,
              validationResults: [],
              changedFiles: [],
              automation: {
                ...owner,
                repository: policy.allowedRepositories[0]!,
                permissionMode: policy.permissionMode,
                requireTests: policy.requireTests,
                requirePullRequest: policy.requirePullRequest,
              },
            });
          }),
          mutate: Effect.fn(function* (input) {
            assert.strictEqual(input.kind, "stop");
            actions.push("stop");
            const run = yield* Ref.get(execution);
            if (run) yield* update({ ...run, status: "stopped", completedAt: at });
          }),
        }),
        Layer.mock(WorkPullRequestService)({
          get: () =>
            Effect.succeed({
              item,
              draft: { title: "PR", body: "Changes" },
              unavailableReason: null,
              record: null,
              detail: null,
              activity: null,
              summary: null,
              refreshError: null,
            }),
          mutate: Effect.fn(function* (input) {
            yield* Effect.sync(() => {
              assert.strictEqual(input.kind, "create");
              actions.push("create-pr");
            });
            return undefined;
          }),
        }),
      ),
    ),
  );
  const service = yield* build;
  yield* service.mutate({ kind: "save", id: "rule", expectedRevision: 0, value: rule });
  const emit = (eventId = "approve") =>
    events.append({
      id: eventId,
      trigger: "plan_approved",
      occurredAt: at,
      workItemId: id,
      projectId: null,
      title: "Task",
      repository: "example/repo",
      labels: ["agent-ready"],
      status: "ready",
      hasAgentThread: false,
      issue: null,
    });
  const finish = Effect.fn(function* (status: "succeeded" | "failed", requirePullRequest = true) {
    const run = (yield* Ref.get(execution))!;
    yield* update({
      ...run,
      status,
      completedAt: at,
      error: status === "failed" ? "Validation failed" : null,
      automation: { ...run.automation!, requirePullRequest },
    });
    yield* work.notifyChange;
    yield* service.drain;
  });
  return { sql, service, build, execution, actions, emit, finish, capacity };
});
it.effect("waits for validated execution before creating a PR and notifying, without merging", () =>
  Effect.gen(function* () {
    const ctx = yield* setup;
    yield* ctx.emit();
    yield* ctx.service.sync();
    assert.deepEqual(ctx.actions, ["start"]);
    assert.strictEqual((yield* ctx.service.list({})).runs[0]?.status, "waiting");
    yield* ctx.finish("succeeded");
    assert.deepEqual(ctx.actions, ["start", "verify-origin", "create-pr"]);
    assert.strictEqual((yield* ctx.service.list({})).runs[0]?.status, "succeeded");
    assert.strictEqual(
      (yield* ctx.sql<{ n: number }>`SELECT count(*) AS n FROM application_events`)[0]?.n,
      1,
    );
    yield* ctx.service.sync();
    assert.strictEqual(ctx.actions.filter((s) => s === "create-pr").length, 1);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
it.effect("failed validation prevents PR creation and later rule actions", () =>
  Effect.gen(function* () {
    const ctx = yield* setup;
    yield* ctx.emit();
    yield* ctx.service.sync();
    yield* ctx.finish("failed");
    assert.deepEqual(ctx.actions, ["start"]);
    assert.strictEqual((yield* ctx.service.list({})).runs[0]?.status, "failed");
    assert.strictEqual(
      (yield* ctx.sql<{ n: number }>`SELECT count(*) AS n FROM application_events`)[0]?.n,
      0,
    );
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
it.effect("capacity waiters resume on work events and PR creation is optional", () =>
  Effect.gen(function* () {
    const ctx = yield* setup;
    yield* Ref.set(ctx.capacity, true);
    yield* ctx.emit();
    yield* ctx.service.sync();
    assert.deepEqual(ctx.actions, []);
    assert.strictEqual((yield* ctx.service.list({})).runs[0]?.executionId, undefined);
    yield* Ref.set(ctx.capacity, false);
    yield* ctx.service.sync();
    assert.deepEqual(ctx.actions, ["start"]);
    yield* ctx.finish("succeeded", false);
    assert.deepEqual(ctx.actions, ["start"]);
    assert.strictEqual((yield* ctx.service.list({})).runs[0]?.status, "succeeded");
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
it.effect("capacity waiters beyond the first batch are not starved by active executions", () =>
  Effect.gen(function* () {
    const ctx = yield* setup;
    yield* ctx.emit();
    yield* ctx.service.sync();
    const run = (yield* ctx.service.list({})).runs[0]!;
    for (let index = 1; index <= 100; index++) {
      const next = {
        ...(index === 100 ? Struct.omit(run, ["executionId"]) : run),
        id: `waiting-${index}`,
        eventId: `event-${index}`,
      };
      yield* ctx.sql`INSERT INTO work_automation_runs(id,rule_id,event_id,status,record_json,rule_json,event_json) SELECT ${next.id},rule_id,${next.eventId},'waiting',${encodeRun(next)},rule_json,event_json FROM work_automation_runs WHERE id=${run.id}`;
    }
    yield* ctx.service.sync();
    assert.deepEqual(ctx.actions, ["start", "start"]);
    assert.strictEqual((yield* Ref.get(ctx.execution))?.id, "automation:waiting-100:0");
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
it.effect(
  "emergency stop cancels follow-ups, stops owned agents, persists pause, and never replays paused events",
  () =>
    Effect.gen(function* () {
      const ctx = yield* setup;
      yield* ctx.emit();
      yield* ctx.service.sync();
      yield* ctx.service.control({ kind: "stop_all" });
      assert.deepEqual(ctx.actions, ["start", "stop"]);
      assert.strictEqual((yield* ctx.service.list({})).control?.paused, true);
      assert.strictEqual((yield* ctx.service.list({})).runs[0]?.status, "cancelled");
      yield* ctx.emit("during-pause");
      yield* ctx.service.sync();
      yield* Effect.scoped(ctx.build);
      assert.strictEqual((yield* ctx.service.list({})).control?.paused, true);
      const revision = (yield* ctx.service.list({})).control!.revision;
      yield* ctx.service.control({ kind: "resume", expectedRevision: revision });
      yield* ctx.service.sync();
      assert.deepEqual(ctx.actions, ["start", "stop"]);
      assert.strictEqual((yield* ctx.service.list({})).total, 1);
      assert.strictEqual(
        (yield* ctx.service
          .control({ kind: "resume", expectedRevision: revision })
          .pipe(Effect.result))._tag,
        "Failure",
      );
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
it.effect(
  "execution trust is opt-in and automatic approval and full access cannot be configured",
  () =>
    Effect.gen(function* () {
      const ctx = yield* setup;
      const denied = yield* ctx.service
        .mutate({
          kind: "save",
          id: "untrusted",
          expectedRevision: 0,
          value: { ...rule, execution: { ...policy, trusted: false } },
        })
        .pipe(Effect.result);
      assert.strictEqual(denied._tag, "Failure");
      const automaticPlan = yield* ctx.service
        .mutate({
          kind: "save",
          id: "automatic-plan",
          expectedRevision: 0,
          value: {
            ...rule,
            actions: [{ kind: "generate_plan", modelSelection: model }, ...rule.actions],
          },
        })
        .pipe(Effect.result);
      assert.strictEqual(automaticPlan._tag, "Failure");
      assert.strictEqual(
        decodePolicy({ ...policy, permissionMode: "full-access" })._tag,
        "Failure",
      );
      assert.strictEqual(decodePolicy({ ...policy, allowedRepositories: [] })._tag, "Failure");
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
