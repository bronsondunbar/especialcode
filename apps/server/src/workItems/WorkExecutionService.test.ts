import { assert, it } from "@effect/vitest";
import {
  AutomationRule,
  GitHubIssue,
  GitHubTrackedRepository,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  WorkItemId,
  WorkPlan,
  WorkPullRequestRecord,
  WorkReviewSnapshot,
  type WorkReviewMutation,
  WorkExecutionError,
  ThreadId,
  TurnId,
  MessageId,
  CheckpointRef,
  OrchestrationThread,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import * as WorkItems from "./WorkItemService.ts";
import { WorkExecutionRuntime } from "./WorkExecutionRuntime.ts";
import { make, executionBranch } from "./WorkExecutionService.ts";
const at = "2026-09-14T10:00:00.000Z";
const selection = { instanceId: ProviderInstanceId.make("codex"), model: "test-model" };
const provider: ServerProvider = {
  instanceId: selection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: at,
  models: [{ slug: "test-model", name: "Test", isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
};
const encodePlan = Schema.encodeSync(Schema.fromJsonString(WorkPlan));
const decodePlan = Schema.decodeUnknownEffect(Schema.fromJsonString(WorkPlan));
const setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES ('project','Project','/repo','[]',${at},${at})`;
  const work = yield* WorkItems.make;
  const item = yield* work.mutate({
    kind: "create",
    commandId: "create",
    id: WorkItemId.make("task"),
    title: "Recurring invoices",
    source: "manual",
    fields: { projectId: ProjectId.make("project"), body: "Implement invoices" },
  });
  const ready = yield* work.mutate({
    kind: "status",
    commandId: "ready",
    id: item.id,
    expectedRevision: item.revision,
    status: "ready",
  });
  const plan = WorkPlan.make({
    workItemId: item.id,
    revision: 1,
    generationId: "plan",
    status: "draft",
    modelSelection: selection,
    agentName: "Agent",
    threadId: ThreadId.make("plan-thread"),
    createdAt: at,
    generatedAt: at,
    updatedAt: at,
    sourceWorkItemRevision: 1,
    approvedWorkItemRevision: null,
    approvedAt: null,
    content: {
      summary: "Implement",
      proposedChanges: [],
      affectedFiles: ["src/app.ts"],
      steps: ["Implement"],
      tests: ["Unit tests"],
      risks: [],
      questions: [],
      complexity: "low",
    },
    error: null,
    inspectedFiles: [],
  });
  yield* sql`INSERT INTO work_item_plans(work_item_id,record_json) VALUES (${item.id},${encodePlan(plan)})`;
  yield* sql`INSERT INTO work_item_plan_history(work_item_id,revision,record_json) VALUES (${item.id},1,${encodePlan(plan)})`;
  const started = yield* Deferred.make<void>();
  const preparing = yield* Deferred.make<void>();
  const preparationGate = yield* Deferred.make<void>();
  const validating = yield* Deferred.make<void>();
  const validationGate = yield* Deferred.make<void>();
  const preparationFailure = yield* Ref.make(false);
  const calls = { prepare: 0, start: 0, validate: 0, stop: 0, publish: 0 };
  const publishing = yield* Deferred.make<void>();
  const publishGate = yield* Deferred.make<void>();
  const publishFailure = yield* Ref.make(false);
  const code = yield* Ref.make(0);
  const thread = yield* Ref.make(
    OrchestrationThread.make({
      id: ThreadId.make("execution:run"),
      projectId: ProjectId.make("project"),
      title: "Execution",
      modelSelection: selection,
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: "task/branch",
      worktreePath: "/worktree",
      latestTurn: null,
      createdAt: at,
      updatedAt: at,
      deletedAt: null,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      messages: [],
      proposedPlans: [],
      pullRequests: [],
      activities: [],
      checkpoints: [],
      session: null,
    }),
  );
  const runtime = WorkExecutionRuntime.of({
    verifyRepository: () => Effect.succeed(undefined),
    verifyWorktree: () => Effect.succeed(undefined),
    publish: Effect.fn(function* () {
      calls.publish++;
      yield* Deferred.succeed(publishing, undefined);
      yield* Deferred.await(publishGate);
      if (yield* Ref.get(publishFailure))
        return yield* new WorkExecutionError({ code: "unavailable", message: "Push failed" });
      return {
        action: "commit_push" as const,
        branch: { status: "skipped_not_requested" as const },
        commit: { status: "created" as const },
        push: { status: "pushed" as const },
        pr: { status: "skipped_not_requested" as const },
        toast: { title: "Pushed", cta: { kind: "none" as const } },
      };
    }),
    prepare: Effect.fn(function* (_run, _item, onPath) {
      calls.prepare++;
      if (yield* Ref.get(preparationFailure))
        return yield* new WorkExecutionError({ code: "invalid", message: "Dirty checkout" });
      yield* onPath("/worktree", true);
      yield* Deferred.succeed(preparing, undefined);
      yield* Deferred.await(preparationGate);
      return "/worktree";
    }),
    start: Effect.fn(function* (run) {
      calls.start++;
      const turnId = TurnId.make(run.review ? `review-${run.id}` : "turn");
      yield* Ref.update(thread, (thread): OrchestrationThread => ({
        ...thread,
        latestTurn: {
          turnId,
          state: "running",
          requestedAt: run.startedAt,
          startedAt: run.startedAt,
          completedAt: null,
          assistantMessageId: null,
        },
        messages: [
          ...(run.review ? thread.messages : []),
          {
            id: MessageId.make(`execution-message:${run.id}`),
            role: "user",
            text: "Implement",
            turnId: null,
            streaming: false,
            createdAt: at,
            updatedAt: at,
          },
        ],
        session: {
          threadId: run.threadId,
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: turnId,
          lastError: null,
          updatedAt: at,
        },
      }));
      yield* Deferred.succeed(started, undefined);
      return undefined;
    }),
    validate: Effect.fn(function* () {
      calls.validate++;
      yield* Deferred.succeed(validating, undefined);
      yield* Deferred.await(validationGate);
      return {
        code: (yield* Ref.get(
          code,
        )) as import("effect/unstable/process/ChildProcessSpawner").ExitCode,
        stdout: "Validation output",
        stderr: "",
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
        stdoutInvalidUtf8: false,
        stderrInvalidUtf8: false,
      };
    }),
    stop: Effect.fn(function* () {
      calls.stop++;
      yield* Ref.update(thread, (thread): OrchestrationThread => ({
        ...thread,
        session: thread.session
          ? { ...thread.session, status: "stopped", activeTurnId: null }
          : null,
      }));
      return { sequence: 1 };
    }),
    inspect: () => Ref.get(thread).pipe(Effect.map(Option.some)),
  });
  const makeService = make.pipe(
    Effect.provideService(WorkItems.WorkItemService, work),
    Effect.provideService(WorkExecutionRuntime, runtime),
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(OrchestrationEngineService)({
          subscribeDomainEvents: Effect.succeed(Stream.never),
        }),
        Layer.mock(ProviderInstanceRegistry)({
          listInstances: Effect.succeed([
            {
              enabled: true,
              snapshot: { getSnapshot: Effect.succeed(provider) },
            } as unknown as ProviderInstance,
          ]),
        }),
      ),
    ),
  );
  const service = yield* makeService;
  const start = {
    kind: "start" as const,
    commandId: "run",
    id: item.id,
    expectedWorkItemRevision: ready.revision,
    expectedPlanRevision: 1,
    modelSelection: selection,
    validationCommands: ["npm test"],
  };
  const complete = (marker = true, checkpoint = true) =>
    Ref.update(thread, (thread): OrchestrationThread => ({
      ...thread,
      latestTurn: {
        ...thread.latestTurn!,
        state: "completed",
        completedAt: at,
        assistantMessageId: MessageId.make(`answer-${thread.latestTurn!.turnId}`),
      },
      session: { ...thread.session!, activeTurnId: null, status: "ready" },
      messages: [
        ...thread.messages,
        {
          id: MessageId.make(`answer-${thread.latestTurn!.turnId}`),
          role: "assistant",
          text: marker ? "Implemented\n[WORK_ITEM_COMPLETE]" : "Need clarification",
          turnId: thread.latestTurn!.turnId,
          streaming: false,
          createdAt: at,
          updatedAt: at,
        },
      ],
      checkpoints: checkpoint
        ? [
            {
              turnId: thread.latestTurn!.turnId,
              checkpointTurnCount: 1,
              checkpointRef: CheckpointRef.make("ref"),
              status: "ready",
              files: [{ path: "src/app.ts", kind: "modified", additions: 2, deletions: 1 }],
              assistantMessageId: MessageId.make(`answer-${thread.latestTurn!.turnId}`),
              completedAt: at,
            },
          ]
        : [],
    }));
  const launch = Effect.gen(function* () {
    yield* service.mutate(start);
    yield* Deferred.succeed(preparationGate, undefined);
    yield* Deferred.await(started);
  });
  return {
    service,
    publishing,
    publishGate,
    publishFailure,
    work,
    item,
    start,
    calls,
    preparing,
    preparationGate,
    preparationFailure,
    started,
    validating,
    validationGate,
    code,
    thread,
    complete,
    launch,
    makeService,
    sql,
    plan,
  };
});
const settled = (service: Effect.Success<typeof make>, id: WorkItemId) =>
  service.subscribe(id).pipe(
    Stream.filter((state) => !!state.execution?.completedAt),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );
it.effect("assigns a repository while executing an unassigned inbox task", () =>
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
      expectedPlanRevision: null,
      validationCommands: [],
    };
    yield* ctx.service.mutate(input);
    yield* Deferred.succeed(ctx.preparationGate, undefined);
    yield* Deferred.await(ctx.started);
    yield* ctx.service.mutate(input);
    const state = yield* ctx.service.get(item.id);
    assert.equal(state.item.projectId, "project");
    assert.equal(state.item.status, "running");
    assert.isNull(state.execution?.planRevision);
    assert.equal(ctx.calls.start, 1);
    assert.equal(ctx.calls.prepare, 1);
  }).pipe(Effect.provide(SqlitePersistenceMemory), Effect.scoped),
);

it.effect("rejects an unavailable execution repository without recording a run", () =>
  Effect.gen(function* () {
    const ctx = yield* setup;
    const failure = yield* ctx.service
      .mutate({ ...ctx.start, projectId: ProjectId.make("missing"), expectedPlanRevision: null })
      .pipe(Effect.flip);
    assert.equal(failure.code, "invalid");
    assert.equal((yield* ctx.work.get(ctx.item.id)).projectId, "project");
    assert.isNull((yield* ctx.service.get(ctx.item.id)).execution);
    assert.equal(ctx.calls.prepare, 0);
  }).pipe(Effect.provide(SqlitePersistenceMemory), Effect.scoped),
);

for (const guidance of [undefined, "  Keep the existing API compatible.  "]) {
  it.effect(
    `executes without a plan with ${guidance ? "optional guidance" : "no extra input"}`,
    () =>
      Effect.gen(function* () {
        const ctx = yield* setup;
        yield* ctx.sql`DELETE FROM work_item_plans`;
        yield* ctx.sql`DELETE FROM work_item_plan_history`;
        const inbox = yield* ctx.work.mutate({
          kind: "status",
          commandId: "back-to-inbox",
          id: ctx.item.id,
          expectedRevision: ctx.start.expectedWorkItemRevision,
          status: "inbox",
        });
        const input = {
          ...ctx.start,
          expectedWorkItemRevision: inbox.revision,
          expectedPlanRevision: null,
          validationCommands: [],
          ...(guidance ? { guidance } : {}),
        };
        yield* ctx.service.mutate(input);
        yield* ctx.service.mutate(input);
        yield* Deferred.succeed(ctx.preparationGate, undefined);
        yield* Deferred.await(ctx.started);
        const run = (yield* ctx.service.get(ctx.item.id)).execution!;
        assert.isNull(run.planRevision);
        assert.equal(run.guidance, guidance?.trim());
        assert.equal(ctx.calls.prepare, 1);
        assert.equal(ctx.calls.start, 1);
        assert.isEmpty(yield* ctx.sql`SELECT * FROM work_item_plans`);
        yield* ctx.complete();
        yield* ctx.service.reconcile(run);
        const final = yield* settled(ctx.service, ctx.item.id);
        assert.equal(final.item.status, "review");
        assert.equal(final.execution?.status, "succeeded");
        assert.equal(final.execution?.activity, "Agent completed; ready for review");
        assert.equal(ctx.calls.validate, 0);
      }).pipe(Effect.provide(SqlitePersistenceMemory), Effect.scoped),
  );
}

it.effect(
  "direct execution leaves an existing draft unapproved and rejects changed guidance on retry",
  () =>
    Effect.gen(function* () {
      const ctx = yield* setup;
      const input = { ...ctx.start, expectedPlanRevision: null, guidance: "Keep scope small" };
      yield* ctx.service.mutate(input);
      const rows = yield* ctx.sql<{ record_json: string }>`SELECT record_json FROM work_item_plans`;
      assert.equal((yield* decodePlan(rows[0]!.record_json)).status, "draft");
      assert.equal(
        (yield* ctx.service.mutate({ ...input, guidance: "Different scope" }).pipe(Effect.flip))
          .code,
        "conflict",
      );
    }).pipe(Effect.provide(SqlitePersistenceMemory), Effect.scoped),
);

it.effect(
  "atomically approves, deduplicates execution, waits for a checkpoint and passing validation before review",
  () =>
    Effect.gen(function* () {
      const ctx = yield* setup;
      yield* ctx.launch;
      yield* ctx.service.mutate(ctx.start);
      assert.strictEqual(ctx.calls.start, 1);
      assert.strictEqual((yield* ctx.work.get(ctx.item.id)).status, "running");
      const run = (yield* ctx.service.get(ctx.item.id)).execution!;
      assert.strictEqual(run.planRevision, 2);
      assert.match(run.branch, /^task\/task-recurring-invoices-[a-f0-9]{8}$/);
      yield* ctx.complete(true, false);
      yield* ctx.service.reconcile(run);
      assert.strictEqual(ctx.calls.validate, 0);
      yield* ctx.complete();
      yield* ctx.service.reconcile((yield* ctx.service.get(ctx.item.id)).execution!);
      yield* Deferred.await(ctx.validating);
      assert.strictEqual((yield* ctx.work.get(ctx.item.id)).status, "running");
      yield* Deferred.succeed(ctx.validationGate, undefined);
      const final = yield* settled(ctx.service, ctx.item.id);
      assert.strictEqual(final.item.status, "review");
      assert.deepEqual(final.execution?.changedFiles, ["src/app.ts"]);
      assert.strictEqual(final.execution?.validationResults[0]?.exitCode, 0);
      assert.strictEqual(ctx.calls.validate, 1);
      const sql = yield* SqlClient.SqlClient;
      const milestones = yield* sql<{
        kind: string;
        summary: string;
      }>`SELECT json_extract(record_json,'$.kind') AS kind,json_extract(record_json,'$.summary') AS summary FROM work_item_activity WHERE work_item_id=${ctx.item.id}`;
      assert.strictEqual(milestones.filter((event) => event.kind === "agent_started").length, 1);
      assert.strictEqual(
        milestones.filter((event) => event.kind === "validation_completed").length,
        1,
      );
      assert.isFalse(milestones.some((event) => event.summary.includes("Validation output")));
    }).pipe(Effect.provide(SqlitePersistenceMemory), Effect.scoped),
);
it.effect("does not mistake a completed conversational turn for completed work", () =>
  Effect.gen(function* () {
    const ctx = yield* setup;
    yield* ctx.launch;
    yield* ctx.complete(false);
    yield* ctx.service.reconcile((yield* ctx.service.get(ctx.item.id)).execution!);
    const final = yield* settled(ctx.service, ctx.item.id);
    assert.strictEqual(final.item.status, "blocked");
    assert.include(final.item.failureReason ?? "", "did not confirm");
    assert.strictEqual(ctx.calls.validate, 0);
  }).pipe(Effect.provide(SqlitePersistenceMemory), Effect.scoped),
);
it.effect("records nonzero validation output and blocks the work", () =>
  Effect.gen(function* () {
    const ctx = yield* setup;
    yield* ctx.launch;
    yield* ctx.complete();
    yield* Ref.set(ctx.code, 1);
    yield* ctx.service.reconcile((yield* ctx.service.get(ctx.item.id)).execution!);
    yield* Deferred.await(ctx.validating);
    yield* Deferred.succeed(ctx.validationGate, undefined);
    const final = yield* settled(ctx.service, ctx.item.id);
    assert.strictEqual(final.item.status, "blocked");
    assert.strictEqual(final.execution?.validationResults[0]?.exitCode, 1);
  }).pipe(Effect.provide(SqlitePersistenceMemory), Effect.scoped),
);
it.effect("stops preparation without dispatching a turn or discarding its worktree", () =>
  Effect.gen(function* () {
    const ctx = yield* setup;
    yield* ctx.service.mutate(ctx.start);
    yield* Deferred.await(ctx.preparing);
    const run = (yield* ctx.service.get(ctx.item.id)).execution!;
    yield* ctx.service.mutate({
      kind: "stop",
      commandId: "stop",
      id: ctx.item.id,
      expectedRevision: run.revision,
    });
    yield* Deferred.succeed(ctx.preparationGate, undefined);
    const final = yield* settled(ctx.service, ctx.item.id);
    assert.strictEqual(final.execution?.status, "stopped");
    assert.strictEqual(final.execution?.worktreePath, "/worktree");
    assert.strictEqual(ctx.calls.start, 0);
  }).pipe(Effect.provide(SqlitePersistenceMemory), Effect.scoped),
);
it.effect("stops an agent through its runtime and ignores late completion", () =>
  Effect.gen(function* () {
    const ctx = yield* setup;
    yield* ctx.launch;
    const run = (yield* ctx.service.get(ctx.item.id)).execution!;
    yield* ctx.service.mutate({
      kind: "stop",
      commandId: "stop",
      id: ctx.item.id,
      expectedRevision: run.revision,
    });
    yield* ctx.complete();
    yield* ctx.service.reconcile((yield* ctx.service.get(ctx.item.id)).execution!);
    const final = yield* settled(ctx.service, ctx.item.id);
    assert.strictEqual(final.execution?.status, "stopped");
    assert.strictEqual(final.item.status, "blocked");
    assert.strictEqual(ctx.calls.stop, 1);
    assert.strictEqual(ctx.calls.validate, 0);
  }).pipe(Effect.provide(SqlitePersistenceMemory), Effect.scoped),
);
it.effect("restart stops unfinished execution without replaying preparation or validation", () =>
  Effect.gen(function* () {
    const ctx = yield* setup;
    yield* ctx.launch;
    const restored = yield* ctx.makeService;
    assert.strictEqual((yield* restored.get(ctx.item.id)).item.status, "blocked");
    assert.strictEqual(ctx.calls.start, 1);
    assert.strictEqual(ctx.calls.stop, 1);
    assert.strictEqual(ctx.calls.validate, 0);
  }).pipe(Effect.provide(SqlitePersistenceMemory), Effect.scoped),
);
it.effect("rejects stale approval, invalid models and changed retries before dispatch", () =>
  Effect.gen(function* () {
    const ctx = yield* setup;
    assert.strictEqual(
      (yield* ctx.service.mutate({ ...ctx.start, expectedPlanRevision: 2 }).pipe(Effect.flip)).code,
      "conflict",
    );
    assert.strictEqual(
      (yield* ctx.service
        .mutate({ ...ctx.start, modelSelection: { ...selection, model: "missing" } })
        .pipe(Effect.flip)).code,
      "unavailable",
    );
    yield* ctx.launch;
    assert.strictEqual(
      (yield* ctx.service.mutate({ ...ctx.start, validationCommands: ["other"] }).pipe(Effect.flip))
        .code,
      "conflict",
    );
    assert.strictEqual(ctx.calls.prepare, 1);
  }).pipe(Effect.provide(SqlitePersistenceMemory), Effect.scoped),
);
it.effect("uses issue numbers and unique sanitized branches", () =>
  Effect.gen(function* () {
    const { item } = yield* setup;
    const branch = executionBranch(
      {
        ...item,
        source: "github_issue",
        externalUrl: "https://github.com/owner/repo/issues/142",
        title: 'Fix "invoices" / now',
      },
      "one",
    );
    assert.match(branch, /^issue\/142-fix-invoices-now-[a-f0-9]{8}$/);
    assert.notEqual(branch, executionBranch(item, "two"));
  }).pipe(Effect.provide(SqlitePersistenceMemory), Effect.scoped),
);
it.effect("cancels validation and rejects its late success", () =>
  Effect.gen(function* () {
    const ctx = yield* setup;
    yield* ctx.launch;
    yield* ctx.complete();
    yield* ctx.service.reconcile((yield* ctx.service.get(ctx.item.id)).execution!);
    yield* Deferred.await(ctx.validating);
    yield* ctx.service.mutate({
      kind: "stop",
      commandId: "stop-validation",
      id: ctx.item.id,
      expectedRevision: (yield* ctx.service.get(ctx.item.id)).execution!.revision,
    });
    yield* Deferred.succeed(ctx.validationGate, undefined);
    const final = yield* settled(ctx.service, ctx.item.id);
    assert.strictEqual(final.execution?.status, "stopped");
    assert.strictEqual(final.item.status, "blocked");
  }).pipe(Effect.provide(SqlitePersistenceMemory), Effect.scoped),
);
it.effect("does not approve an edited WorkItem against an older approval", () =>
  Effect.gen(function* () {
    const ctx = yield* setup;
    yield* ctx.sql`UPDATE work_item_plans SET record_json=${encodePlan({ ...ctx.plan, status: "approved", approvedAt: at, approvedWorkItemRevision: 1 })} WHERE work_item_id=${ctx.item.id}`;
    const error = yield* ctx.service.mutate(ctx.start).pipe(Effect.flip);
    assert.strictEqual(error.code, "conflict");
    assert.include(error.message, "changed since approval");
    assert.strictEqual(ctx.calls.prepare, 0);
  }).pipe(Effect.provide(SqlitePersistenceMemory), Effect.scoped),
);
it.effect("a new pending user message invalidates validation even before its turn starts", () =>
  Effect.gen(function* () {
    const ctx = yield* setup;
    yield* ctx.launch;
    yield* ctx.complete();
    yield* ctx.service.reconcile((yield* ctx.service.get(ctx.item.id)).execution!);
    yield* Deferred.await(ctx.validating);
    yield* Ref.update(ctx.thread, (thread): OrchestrationThread => ({
      ...thread,
      messages: [
        ...thread.messages,
        {
          id: MessageId.make("other"),
          role: "user",
          text: "Do more",
          turnId: null,
          streaming: false,
          createdAt: at,
          updatedAt: at,
        },
      ],
    }));
    yield* ctx.service.reconcile((yield* ctx.service.get(ctx.item.id)).execution!);
    yield* Deferred.succeed(ctx.validationGate, undefined);
    assert.strictEqual((yield* settled(ctx.service, ctx.item.id)).item.status, "blocked");
  }).pipe(Effect.provide(SqlitePersistenceMemory), Effect.scoped),
);
it.effect("a failure before worktree creation preserves the original base branch for retry", () =>
  Effect.gen(function* () {
    const ctx = yield* setup;
    yield* Ref.set(ctx.preparationFailure, true);
    yield* ctx.service.mutate(ctx.start);
    const final = yield* settled(ctx.service, ctx.item.id);
    assert.strictEqual(final.item.status, "blocked");
    assert.isNull(final.item.branch);
    assert.isNull(final.execution?.worktreePath);
    assert.strictEqual(ctx.calls.start, 0);
  }).pipe(Effect.provide(SqlitePersistenceMemory), Effect.scoped),
);

const encodePr = Schema.encodeSync(Schema.fromJsonString(WorkPullRequestRecord));
const encodeReview = Schema.encodeSync(Schema.fromJsonString(WorkReviewSnapshot));
const makeReviewSetup = (direct = false) =>
  Effect.gen(function* () {
    const ctx = yield* setup;
    if (direct) {
      yield* ctx.sql`DELETE FROM work_item_plans`;
      yield* ctx.sql`DELETE FROM work_item_plan_history`;
      yield* ctx.service.mutate({ ...ctx.start, expectedPlanRevision: null });
      yield* Deferred.succeed(ctx.preparationGate, undefined);
      yield* Deferred.await(ctx.started);
    } else yield* ctx.launch;
    yield* ctx.complete();
    yield* ctx.service.reconcile((yield* ctx.service.get(ctx.item.id)).execution!);
    yield* Deferred.succeed(ctx.validationGate, undefined);
    yield* settled(ctx.service, ctx.item.id);
    const state = yield* ctx.service.get(ctx.item.id);
    const reference = {
      projectId: ProjectId.make("project"),
      host: "github.com",
      repository: "acme/app",
      number: 7,
    };
    const record = {
      workItemId: ctx.item.id,
      executionId: "run",
      commandId: "pr-create",
      status: "linked" as const,
      content: { title: "Fix", body: "Body" },
      reference,
      url: "https://github.com/acme/app/pull/7",
      error: null,
    };
    yield* ctx.sql`INSERT INTO work_item_pull_requests(work_item_id,record_json) VALUES (${ctx.item.id},${encodePr(record)})`;
    const snapshot: WorkReviewSnapshot = {
      reference,
      revision: 1,
      fingerprint: "feedback-v1",
      state: "open",
      headBranch: state.execution!.branch,
      reviewDecision: "changes-requested",
      reviewers: ["reviewer"],
      checks: [],
      comments: [],
      commentsTruncated: false,
      mergedAt: null,
      syncedAt: at,
    };
    yield* ctx.sql`INSERT INTO work_item_reviews(work_item_id,snapshot_json,sync_error) VALUES (${ctx.item.id},${encodeReview(snapshot)},NULL)`;
    const input: Extract<WorkReviewMutation, { kind: "send" }> = {
      kind: "send",
      id: ctx.item.id,
      commandId: "review-1",
      expectedWorkItemRevision: state.item.revision,
      expectedReviewRevision: 1,
      guidance: "Fix rounding",
      validationCommands: ["npm test"],
    };
    const launchReview = Effect.gen(function* () {
      yield* ctx.service.startReview(input, snapshot, "Fix rounding; failed test details");
      yield* ctx.service.subscribe(ctx.item.id).pipe(
        Stream.filter(
          (state) =>
            state.execution?.id === input.commandId && state.execution.status === "running",
        ),
        Stream.runHead,
      );
    });
    return { ...ctx, snapshot, input, launchReview };
  });
const reviewSetup = makeReviewSetup();
for (const direct of [false, true]) {
  it.effect(
    `review cycles reuse the original ${direct ? "unplanned" : "planned"} thread and worktree and push only after validation`,
    () =>
      Effect.gen(function* () {
        const ctx = yield* makeReviewSetup(direct);
        yield* ctx.launchReview;
        yield* ctx.service.startReview(
          ctx.input,
          ctx.snapshot,
          "Fix rounding; failed test details",
        );
        assert.equal(ctx.calls.start, 2);
        assert.equal(ctx.calls.prepare, 1);
        const run = (yield* ctx.service.get(ctx.item.id)).execution!;
        assert.equal(run.threadId, "execution:run");
        assert.equal(run.worktreePath, "/worktree");
        assert.deepEqual(run.review?.previousUserMessageIds, ["execution-message:run"]);
        assert.equal(ctx.calls.publish, 0);
        yield* ctx.complete();
        yield* ctx.service.reconcile(run);
        yield* Deferred.await(ctx.publishing);
        assert.equal((yield* ctx.service.get(ctx.item.id)).execution?.status, "publishing");
        yield* Deferred.succeed(ctx.publishGate, undefined);
        const finished = yield* settled(ctx.service, ctx.item.id);
        assert.equal(finished.item.status, "review");
        assert.equal(finished.execution?.status, "succeeded");
        assert.equal(ctx.calls.publish, 1);
        const items = yield* ctx.sql`SELECT * FROM work_items`;
        assert.equal(items.length, 1);
      }).pipe(Effect.provide(SqlitePersistenceMemory), Effect.scoped),
  );
}
it.effect("failed review validation blocks the item without publishing", () =>
  Effect.gen(function* () {
    const ctx = yield* reviewSetup;
    yield* ctx.launchReview;
    yield* Ref.set(ctx.code, 1);
    yield* ctx.complete();
    yield* ctx.service.reconcile((yield* ctx.service.get(ctx.item.id)).execution!);
    assert.equal((yield* settled(ctx.service, ctx.item.id)).item.status, "blocked");
    assert.equal(ctx.calls.publish, 0);
  }).pipe(Effect.provide(SqlitePersistenceMemory), Effect.scoped),
);
it.effect("a failed push is retained as a blocked review cycle", () =>
  Effect.gen(function* () {
    const ctx = yield* reviewSetup;
    yield* ctx.launchReview;
    yield* Ref.set(ctx.publishFailure, true);
    yield* ctx.complete();
    yield* ctx.service.reconcile((yield* ctx.service.get(ctx.item.id)).execution!);
    yield* Deferred.await(ctx.publishing);
    yield* Deferred.succeed(ctx.publishGate, undefined);
    const finished = yield* settled(ctx.service, ctx.item.id);
    assert.equal(finished.item.status, "blocked");
    assert.include(finished.execution?.error ?? "", "Push failed");
  }).pipe(Effect.provide(SqlitePersistenceMemory), Effect.scoped),
);
it.effect("a confirmed merge wins over late review completion and is idempotent", () =>
  Effect.gen(function* () {
    const ctx = yield* reviewSetup;
    yield* ctx.launchReview;
    const run = (yield* ctx.service.get(ctx.item.id)).execution!;
    yield* ctx.service.completeMerged(ctx.item.id, at, "pr-7");
    yield* ctx.complete();
    yield* ctx.service.reconcile(run);
    const item = yield* ctx.work.get(ctx.item.id);
    assert.equal(item.status, "done");
    assert.equal(item.completedAt, at);
    yield* ctx.service.completeMerged(ctx.item.id, at, "pr-7");
    assert.equal((yield* ctx.work.get(ctx.item.id)).revision, item.revision);
    assert.equal(ctx.calls.publish, 0);
  }).pipe(Effect.provide(SqlitePersistenceMemory), Effect.scoped),
);
it.effect("rejects stale feedback admission and conflicting review command IDs", () =>
  Effect.gen(function* () {
    const ctx = yield* reviewSetup;
    const error = yield* ctx.service
      .startReview(ctx.input, { ...ctx.snapshot, revision: 2 }, "Feedback")
      .pipe(Effect.flip);
    assert.equal(error.code, "conflict");
    yield* ctx.launchReview;
    const duplicate = yield* ctx.service
      .startReview({ ...ctx.input, guidance: "Different" }, ctx.snapshot, "Different")
      .pipe(Effect.flip);
    assert.equal(duplicate.code, "conflict");
    const run = (yield* ctx.service.get(ctx.item.id)).execution!;
    yield* ctx.service.mutate({
      kind: "stop",
      commandId: "stop-review",
      id: ctx.item.id,
      expectedRevision: run.revision,
    });
    assert.equal((yield* ctx.work.get(ctx.item.id)).status, "blocked");
  }).pipe(Effect.provide(SqlitePersistenceMemory), Effect.scoped),
);

it.effect("server restart blocks an interrupted review without replaying the agent or push", () =>
  Effect.gen(function* () {
    const ctx = yield* reviewSetup;
    yield* ctx.launchReview;
    const restarted = yield* ctx.makeService;
    const state = yield* restarted.get(ctx.item.id);
    assert.equal(state.item.status, "blocked");
    assert.equal(state.execution?.status, "failed");
    assert.include(state.execution?.error ?? "", "server restart");
    assert.equal(ctx.calls.start, 2);
    assert.equal(ctx.calls.publish, 0);
  }).pipe(Effect.provide(SqlitePersistenceMemory), Effect.scoped),
);

const encodeAutomationRule = Schema.encodeSync(Schema.fromJsonString(AutomationRule));
const encodeIssue = Schema.encodeSync(Schema.fromJsonString(GitHubIssue));
const encodeRepository = Schema.encodeSync(Schema.fromJsonString(GitHubTrackedRepository));
const automaticRule: AutomationRule = {
  id: "trusted",
  revision: 1,
  name: "Trusted execution",
  enabled: true,
  trigger: "plan_approved",
  conditions: {},
  actions: [
    { kind: "execute_approved", modelSelection: selection, validationCommands: ["npm test"] },
  ],
  createdAt: at,
  updatedAt: at,
  execution: {
    trusted: true,
    allowedRepositories: [{ host: "github.com", repository: "example/repo" }],
    allowedLabels: ["agent-ready"],
    allowedProviders: [selection.instanceId],
    maxConcurrentRuns: 1,
    permissionMode: "auto-accept-edits",
    requireTests: true,
    requirePullRequest: true,
  },
};
const owned = { ruleId: "trusted", ruleRevision: 1, runId: "automation-run" };
const prepareAutomatic = Effect.fn(function* (ctx: Effect.Success<typeof setup>, approved = true) {
  const resource = {
    source: "github_issue" as const,
    namespace: "github.com/example/repo",
    externalId: "9001",
    url: "https://github.com/example/repo/issues/1",
  };
  const item = yield* ctx.work.mutate({
    kind: "attachResource",
    commandId: "attach",
    id: ctx.item.id,
    expectedRevision: ctx.start.expectedWorkItemRevision,
    resource,
  });
  yield* ctx.sql`INSERT INTO github_tracked_repositories(namespace,record_json) VALUES (${resource.namespace},${encodeRepository({ host: "github.com", repository: "example/repo", projectId: item.projectId, importLabels: [], lastSyncedAt: at, syncError: null })})`;
  const issue: GitHubIssue = {
    host: "github.com",
    repository: "example/repo",
    number: 1,
    externalId: resource.externalId,
    url: resource.url,
    title: item.title,
    body: item.body,
    state: "open",
    labels: ["agent-ready"],
    assignees: [],
    milestone: null,
    updatedAt: at,
    comments: [],
    commentsFetchedAt: at,
  };
  yield* ctx.sql`INSERT INTO github_issues(namespace,external_id,number,state,updated_at,record_json) VALUES (${resource.namespace},'9001',1,'open',${at},${encodeIssue(issue)})`;
  yield* ctx.sql`INSERT INTO work_automation_rules(id,revision,starts_after,record_json) VALUES ('trusted',1,0,${encodeAutomationRule(automaticRule)})`;
  if (approved)
    yield* ctx.sql`UPDATE work_item_plans SET record_json=${encodePlan({ ...ctx.plan, status: "approved", approvedAt: at, approvedWorkItemRevision: item.revision })} WHERE work_item_id=${item.id}`;
  return { ...ctx.start, commandId: "automation:run", expectedWorkItemRevision: item.revision };
});
it.effect("autonomous starts never approve drafts or stale approvals", () =>
  Effect.gen(function* () {
    const ctx = yield* setup;
    const input = yield* prepareAutomatic(ctx, false);
    const draft = yield* ctx.service.startAutomation(input, owned).pipe(Effect.result);
    assert.strictEqual(draft._tag, "Failure");
    assert.strictEqual((yield* ctx.service.get(ctx.item.id)).execution, null);
    assert.strictEqual(ctx.calls.prepare, 0);
    yield* ctx.sql`UPDATE work_item_plans SET record_json=${encodePlan({ ...ctx.plan, status: "approved", approvedAt: at, approvedWorkItemRevision: 1 })} WHERE work_item_id=${ctx.item.id}`;
    const stale = yield* ctx.service.startAutomation(input, owned).pipe(Effect.result);
    assert.strictEqual(stale._tag, "Failure");
    assert.strictEqual(ctx.calls.prepare, 0);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
it.effect(
  "autonomous admission enforces trust, repository, label, provider, validation and emergency pause",
  () =>
    Effect.gen(function* () {
      const ctx = yield* setup;
      const input = yield* prepareAutomatic(ctx);
      for (const execution of [
        { ...automaticRule.execution!, trusted: false },
        {
          ...automaticRule.execution!,
          allowedRepositories: [{ host: "github.com", repository: "other/repo" }],
        },
        { ...automaticRule.execution!, allowedLabels: ["not-allowed"] },
        { ...automaticRule.execution!, allowedProviders: [ProviderInstanceId.make("other")] },
      ]) {
        yield* ctx.sql`UPDATE work_automation_rules SET record_json=${encodeAutomationRule({ ...automaticRule, execution })} WHERE id='trusted'`;
        assert.strictEqual(
          (yield* ctx.service.startAutomation(input, owned).pipe(Effect.result))._tag,
          "Failure",
        );
      }
      yield* ctx.sql`UPDATE work_automation_rules SET record_json=${encodeAutomationRule(automaticRule)} WHERE id='trusted'`;
      assert.strictEqual(
        (yield* ctx.service
          .startAutomation({ ...input, validationCommands: [] }, owned)
          .pipe(Effect.result))._tag,
        "Failure",
      );
      yield* ctx.sql`UPDATE work_automation_control SET paused=1 WHERE id=1`;
      assert.strictEqual(
        (yield* ctx.service.startAutomation(input, owned).pipe(Effect.result))._tag,
        "Failure",
      );
      assert.strictEqual(ctx.calls.prepare, 0);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
it.effect(
  "trusted execution can explicitly waive validation without weakening manual execution",
  () =>
    Effect.gen(function* () {
      const ctx = yield* setup;
      const input = yield* prepareAutomatic(ctx);
      yield* ctx.sql`UPDATE work_automation_rules SET record_json=${encodeAutomationRule({ ...automaticRule, execution: { ...automaticRule.execution!, requireTests: false } })} WHERE id='trusted'`;
      assert.strictEqual(
        (yield* ctx.service.mutate({ ...input, validationCommands: [] }).pipe(Effect.result))._tag,
        "Failure",
      );
      yield* ctx.service.startAutomation({ ...input, validationCommands: [] }, owned);
      const run = (yield* ctx.service.get(ctx.item.id)).execution!;
      assert.deepEqual(run.validationCommands, []);
      assert.strictEqual(run.automation?.permissionMode, "auto-accept-edits");
      assert.strictEqual(run.automation?.requireTests, false);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
it.effect("concurrent autonomous admissions cannot exceed the rule limit", () =>
  Effect.gen(function* () {
    const ctx = yield* setup;
    const first = yield* prepareAutomatic(ctx);
    const other = yield* ctx.work.mutate({
      kind: "create",
      commandId: "other-create",
      id: WorkItemId.make("other"),
      title: "Other",
      source: "github_issue",
      fields: { projectId: ProjectId.make("project") },
      resource: {
        source: "github_issue",
        namespace: "github.com/example/repo",
        externalId: "9002",
        url: "https://github.com/example/repo/issues/2",
      },
    });
    const ready = yield* ctx.work.mutate({
      kind: "status",
      commandId: "other-ready",
      id: other.id,
      expectedRevision: other.revision,
      status: "ready",
    });
    yield* ctx.sql`INSERT INTO github_issues(namespace,external_id,number,state,updated_at,record_json) SELECT namespace,'9002',2,state,updated_at,json_set(record_json,'$.externalId','9002','$.number',2) FROM github_issues WHERE external_id='9001'`;
    yield* ctx.sql`INSERT INTO work_item_plans(work_item_id,record_json) VALUES (${other.id},${encodePlan({ ...ctx.plan, workItemId: other.id, status: "approved", approvedAt: at, approvedWorkItemRevision: ready.revision })})`;
    const results = yield* Effect.all(
      [
        ctx.service.startAutomation(first, owned).pipe(Effect.result),
        ctx.service
          .startAutomation(
            {
              ...first,
              id: other.id,
              commandId: "automation:other",
              expectedWorkItemRevision: ready.revision,
            },
            { ...owned, runId: "other-run" },
          )
          .pipe(Effect.result),
      ],
      { concurrency: 2 },
    );
    assert.strictEqual(results.filter((r) => r._tag === "Success").length, 1);
    assert.strictEqual(results.find((r) => r._tag === "Failure")?.failure.code, "capacity");
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect(
  "unavailable issue snapshots and failed repository syncs cannot admit autonomous work",
  () =>
    Effect.gen(function* () {
      const ctx = yield* setup;
      const input = yield* prepareAutomatic(ctx);
      yield* ctx.sql`UPDATE github_issues SET record_json=json_set(record_json,'$.syncStatus','unavailable')`;
      assert.strictEqual(
        (yield* ctx.service.startAutomation(input, owned).pipe(Effect.result))._tag,
        "Failure",
      );
      yield* ctx.sql`UPDATE github_issues SET record_json=json_set(record_json,'$.syncStatus','ready')`;
      yield* ctx.sql`UPDATE github_tracked_repositories SET record_json=json_set(record_json,'$.syncStatus','error')`;
      assert.strictEqual(
        (yield* ctx.service.startAutomation(input, owned).pipe(Effect.result))._tag,
        "Failure",
      );
      assert.strictEqual(ctx.calls.prepare, 0);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
