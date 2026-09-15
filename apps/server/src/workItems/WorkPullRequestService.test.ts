import { makeWorkItemRepository } from "../persistence/WorkItems.ts";
import { assert, it } from "@effect/vitest";
import {
  WorkItemId,
  ProjectId,
  ThreadId,
  ProviderInstanceId,
  WorkExecution,
  WorkPullRequestError,
  type GitRunStackedActionInput,
  type GitRunStackedActionResult,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { PullRequestService } from "../pullRequest/PullRequestService.ts";
import * as WorkItems from "./WorkItemService.ts";
import { make, pullRequestDraft } from "./WorkPullRequestService.ts";
const encodeRun = Schema.encodeSync(Schema.fromJsonString(WorkExecution));
const encodeUnknown = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const at = "2026-09-14T10:00:00.000Z";
const setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES ('project','Project','/repo','[]',${at},${at})`;
  const work = yield* WorkItems.make;
  const created = yield* work.mutate({
    kind: "create",
    id: WorkItemId.make("task"),
    commandId: "task-create",
    title: "Recurring invoices",
    source: "github_issue",
    fields: { projectId: ProjectId.make("project"), branch: "task/invoices" },
    resource: {
      source: "github_issue",
      namespace: "github.com/acme/app",
      externalId: "42",
      url: "https://github.com/acme/app/issues/42",
    },
  });
  const item = yield* work.mutate({
    kind: "status",
    id: created.id,
    commandId: "review",
    expectedRevision: created.revision,
    status: "review",
  });
  const run: WorkExecution = {
    id: "run",
    workItemId: item.id,
    revision: 1,
    planRevision: 1,
    threadId: ThreadId.make("thread"),
    turnId: null,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
    agentName: "Agent",
    branch: "task/invoices",
    baseRef: "main",
    worktreePath: "/worktree",
    threadReady: true,
    status: "succeeded",
    activity: "Validated",
    error: null,
    startedAt: at,
    updatedAt: at,
    completedAt: at,
    validationCommands: ["test"],
    validationResults: [
      {
        command: "test",
        exitCode: 0,
        output: "Passed",
        startedAt: at,
        completedAt: at,
        timedOut: false,
      },
    ],
    changedFiles: ["src/invoices.ts"],
  };
  // The execution service sets the attached thread as part of its own transaction.
  const repo = yield* makeWorkItemRepository;
  yield* repo.save({ ...item, agentThreadId: run.threadId });
  yield* sql`INSERT INTO work_item_executions(id,work_item_id,thread_id,status,record_json) VALUES ('run',${item.id},'thread','succeeded',${encodeRun(run)})`;
  const calls: GitRunStackedActionInput[] = [];
  const actions: string[] = [];
  const started = yield* Deferred.make<void>();
  const gate = yield* Deferred.make<void>();
  let hold = false;
  let failOnce = false;
  let branch = run.branch;
  let remoteError = false;
  let invalidateFailure = false;
  const result: GitRunStackedActionResult = {
    toast: { title: "Created", cta: { kind: "none" } },
    action: "commit_push_pr",
    branch: { status: "skipped_not_requested" },
    commit: { status: "skipped_no_changes" },
    push: { status: "pushed", branch: run.branch, setUpstream: true },
    pr: {
      status: "created",
      number: 7,
      url: "https://github.com/acme/app/pull/7",
      headBranch: run.branch,
      baseBranch: "main",
      title: item.title,
    },
  };
  const dependencies = Layer.mergeAll(
    Layer.succeed(WorkItems.WorkItemService, work),
    Layer.succeed(
      GitWorkflowService,
      GitWorkflowService.of({
        invalidateStatus: () => Effect.void,
        localStatus: () =>
          Effect.succeed({
            isRepo: true,
            hasPrimaryRemote: true,
            isDefaultRef: false,
            refName: branch,
            hasWorkingTreeChanges: true,
            workingTree: { files: [], insertions: 0, deletions: 0 },
          }),
        runStackedAction: Effect.fn(function* (input: GitRunStackedActionInput) {
          calls.push(input);
          yield* Deferred.succeed(started, undefined);
          if (hold) yield* Deferred.await(gate);
          if (failOnce) {
            failOnce = false;
            return yield* Effect.fail(
              new WorkPullRequestError({ code: "unavailable", message: "push failed" }),
            );
          }
          return result;
        }),
      } as unknown as GitWorkflowService["Service"]),
    ),
    Layer.succeed(ProjectionSnapshotQuery, {
      getThreadDetailById: () =>
        Effect.succeed(
          Option.some({
            projectId: item.projectId,
            worktreePath: run.worktreePath,
            deletedAt: null,
            session: null,
          } as OrchestrationThread),
        ),
      getThreadShellById: () => Effect.succeed(Option.none()),
      getProjectShellById: () => Effect.succeed(Option.none()),
    } as unknown as ProjectionSnapshotQuery["Service"]),
    Layer.succeed(OrchestrationEngineService, {} as OrchestrationEngineService["Service"]),
    Layer.succeed(PullRequestService, {
      invalidate: () => {
        if (invalidateFailure) {
          invalidateFailure = false;
          return Effect.fail(
            new WorkPullRequestError({ code: "unavailable", message: "Cache refresh failed" }),
          );
        }
        return Effect.void;
      },
      detail: () =>
        remoteError
          ? Effect.fail(
              new WorkPullRequestError({ code: "unavailable", message: "GitHub offline" }),
            )
          : Effect.succeed(null),
      activity: () => Effect.succeed(null),
      summary: () => Effect.succeed(null),
      runAction: (input: { action: string }) =>
        Effect.sync(() => {
          actions.push(input.action);
        }),
    } as unknown as PullRequestService["Service"]),
  );
  const service = yield* make.pipe(Effect.provide(dependencies));
  const input = {
    kind: "create" as const,
    id: item.id,
    commandId: "publish",
    expectedRevision: item.revision,
    content: {
      title: "Reviewed title",
      body: "Reviewed body\n\nIssue: https://github.com/acme/app/issues/42",
    },
  };
  return {
    sql,
    service,
    work,
    run,
    item,
    input,
    calls,
    actions,
    started,
    gate,
    dependencies,
    setHold: () => {
      hold = true;
    },
    setFailure: () => {
      failOnce = true;
    },
    setBranch: () => {
      branch = "main";
    },
    failAfterLink: () => {
      invalidateFailure = true;
    },
    setRemoteError: () => {
      remoteError = true;
    },
  };
});
const test = <E>(
  name: string,
  body: (ctx: Effect.Success<typeof setup>) => Effect.Effect<void, E, SqlClient.SqlClient>,
) =>
  it.effect(name, () =>
    Effect.gen(function* () {
      const ctx = yield* setup;
      yield* body(ctx);
    }).pipe(Effect.provide(SqlitePersistenceMemory), Effect.scoped),
  );
test("creates through the existing Git workflow using reviewed content and links the WorkItem", (ctx) =>
  Effect.gen(function* () {
    yield* ctx.service.mutate(ctx.input);
    assert.equal(ctx.calls.length, 1);
    assert.deepEqual(ctx.calls[0]?.pullRequestContent, ctx.input.content);
    assert.equal(ctx.calls[0]?.cwd, "/worktree");
    assert.equal(ctx.calls[0]?.action, "commit_push_pr");
    const state = yield* ctx.service.get(ctx.item.id);
    assert.equal(state.item.status, "review");
    assert.equal(state.record?.reference?.number, 7);
    assert.equal(state.record?.url, "https://github.com/acme/app/pull/7");
    assert.equal(state.item.resources.length, 2);
    yield* ctx.service.mutate(ctx.input);
    assert.equal(ctx.calls.length, 1);
    const error = yield* ctx.service
      .mutate({ ...ctx.input, content: { ...ctx.input.content, title: "Changed" } })
      .pipe(Effect.flip);
    assert.equal(error.code, "conflict");
  }));
test("rejects stale revisions and changed execution branches before Git writes", (ctx) =>
  Effect.gen(function* () {
    const stale = yield* ctx.service
      .mutate({ ...ctx.input, expectedRevision: 1 })
      .pipe(Effect.flip);
    assert.equal(stale.code, "conflict");
    ctx.setBranch();
    yield* ctx.service.mutate(ctx.input).pipe(Effect.flip);
    assert.equal(ctx.calls.length, 0);
  }));
test("retains failed content and permits an explicit retry", (ctx) =>
  Effect.gen(function* () {
    ctx.setFailure();
    yield* ctx.service.mutate(ctx.input).pipe(Effect.flip);
    const failed = yield* ctx.service.get(ctx.item.id);
    assert.equal(failed.record?.status, "failed");
    assert.match(failed.record?.error ?? "", /push failed/);
    yield* ctx.service.mutate(ctx.input);
    assert.equal(ctx.calls.length, 2);
    assert.equal((yield* ctx.service.get(ctx.item.id)).record?.status, "linked");
  }));
test("serializes concurrent submissions from different clients", (ctx) =>
  Effect.gen(function* () {
    ctx.setHold();
    const fiber = yield* ctx.service.mutate(ctx.input).pipe(Effect.forkChild);
    yield* Deferred.await(ctx.started);
    const error = yield* ctx.service.mutate({ ...ctx.input, commandId: "other" }).pipe(Effect.flip);
    assert.equal(error.code, "conflict");
    yield* Deferred.succeed(ctx.gate, undefined);
    yield* Fiber.join(fiber);
    assert.equal(ctx.calls.length, 1);
  }));
test("restart recovery does not repeat Git operations", (ctx) =>
  Effect.gen(function* () {
    const record = {
      workItemId: ctx.item.id,
      executionId: ctx.run.id,
      commandId: "interrupted",
      status: "creating",
      content: ctx.input.content,
      reference: null,
      url: null,
      error: null,
    };
    const encoded = encodeUnknown(record);
    yield* ctx.sql`INSERT INTO work_item_pull_requests(work_item_id,record_json) VALUES (${ctx.item.id},${encoded})`;
    const restarted = yield* make.pipe(Effect.provide(ctx.dependencies));
    assert.equal((yield* restarted.get(ctx.item.id)).record?.status, "failed");
    assert.equal(ctx.calls.length, 0);
  }));
test("keeps the PR link during host outages and delegates merge to existing permissions", (ctx) =>
  Effect.gen(function* () {
    yield* ctx.service.mutate(ctx.input);
    ctx.setRemoteError();
    const state = yield* ctx.service.get(ctx.item.id);
    assert.equal(state.record?.reference?.number, 7);
    assert.equal(state.refreshError, "GitHub offline");
    yield* ctx.service.mutate({ kind: "merge", id: ctx.item.id, mergeMethod: "squash" });
    assert.deepEqual(ctx.actions, ["merge"]);
    assert.equal((yield* ctx.work.get(ctx.item.id)).status, "review");
  }));
test("draft includes work, changes, tests and issue links without automatic closing syntax", (ctx) =>
  Effect.sync(() => {
    const draft = pullRequestDraft(ctx.item, ctx.run, null);
    assert.include(draft.body, "WorkItem: task");
    assert.include(draft.body, "src/invoices.ts");
    assert.include(draft.body, "test: exit 0");
    assert.include(draft.body, "https://github.com/acme/app/issues/42");
    assert.notInclude(draft.body, "Closes");
  }));

test("rejects execution without passing validation before publishing", (ctx) =>
  Effect.gen(function* () {
    yield* ctx.sql`UPDATE work_item_executions SET record_json=${encodeRun({ ...ctx.run, status: "failed" })} WHERE id='run'`;
    const error = yield* ctx.service.mutate(ctx.input).pipe(Effect.flip);
    assert.equal(error.code, "invalid");
    assert.equal(ctx.calls.length, 0);
  }));

test("large descriptions cannot truncate the WorkItem and issue references", (ctx) =>
  Effect.sync(() => {
    const draft = pullRequestDraft({ ...ctx.item, body: "x".repeat(100_000) }, ctx.run, null);
    assert.isBelow(draft.body.length, 65_536);
    assert.include(draft.body, "WorkItem: task");
    assert.include(draft.body, "https://github.com/acme/app/issues/42");
  }));

test("keeps a committed PR linked when a later refresh fails and never republishes on retry", (ctx) =>
  Effect.gen(function* () {
    ctx.failAfterLink();
    yield* ctx.service.mutate(ctx.input).pipe(Effect.flip);
    const record = (yield* ctx.service.get(ctx.item.id)).record;
    assert.equal(record?.status, "linked");
    assert.equal(record?.reference?.number, 7);
    yield* ctx.service.mutate(ctx.input);
    assert.equal(ctx.calls.length, 1);
    assert.equal(
      (yield* ctx.work.get(ctx.item.id)).resources.filter((r) => r.source === "github_pr").length,
      1,
    );
  }));
