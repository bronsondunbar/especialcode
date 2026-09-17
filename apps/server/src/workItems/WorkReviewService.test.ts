import { assert, it } from "@effect/vitest";
import {
  WorkItemId,
  ProjectId,
  ThreadId,
  WorkPullRequestRecord,
  PullRequestOperationError,
  type PullRequestSummary,
  type PullRequestDetail,
  type PullRequestActivity,
  type WorkReviewMutation,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { PullRequestService } from "../pullRequest/PullRequestService.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import * as WorkItems from "./WorkItemService.ts";
import { WorkExecutionService } from "./WorkExecutionService.ts";
import { make } from "./WorkReviewService.ts";
const at = "2026-09-14T10:00:00.000Z";
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const encodePr = Schema.encodeSync(Schema.fromJsonString(WorkPullRequestRecord));
const setupWithThread = (source?: "created" | "manual" | "branch") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES ('project','Project','/repo','[]',${at},${at})`;
    const work = yield* WorkItems.make;
    const item = yield* work.mutate({
      kind: "create",
      commandId: "create",
      id: WorkItemId.make("task"),
      title: "Invoices",
      source: "manual",
      fields: { projectId: ProjectId.make("project") },
    });
    yield* work.mutate({
      kind: "status",
      commandId: "review",
      id: item.id,
      expectedRevision: item.revision,
      status: "review",
    });
    const reference = {
      projectId: ProjectId.make("project"),
      host: "github.com",
      repository: "acme/app",
      number: 7,
    };
    const pr = {
      workItemId: item.id,
      executionId: "run",
      commandId: "create-pr",
      content: { title: "Invoices", body: "Body" },
      status: "linked" as const,
      reference,
      url: "https://github.com/acme/app/pull/7",
      error: null,
    };
    yield* sql`INSERT INTO work_item_pull_requests(work_item_id,record_json) VALUES (${item.id},${encodePr(pr)})`;
    if (source) {
      yield* sql`DELETE FROM work_item_pull_requests`;
      yield* sql`INSERT INTO projection_threads(thread_id,project_id,title,model_selection_json,branch,created_at,updated_at)
      VALUES ('thread','project','Invoices','{"instanceId":"codex","model":"test"}','task/invoices',${at},${at})`;
      const current = yield* work.get(item.id);
      yield* work.mutate({
        kind: "update",
        id: item.id,
        commandId: "link-thread",
        expectedRevision: current.revision,
        patch: { agentThreadId: ThreadId.make("thread") },
      });
      if (source === "branch") {
        yield* sql`UPDATE projection_threads SET branch_pull_request_json=${encode({ ...reference, url: pr.url })} WHERE thread_id='thread'`;
      } else {
        yield* sql`INSERT INTO projection_thread_pull_requests(thread_id,host,repository,number,url,source,linked_at)
        VALUES ('thread',${reference.host},${reference.repository},${reference.number},${pr.url},${source},${at})`;
      }
    }
    let summary: PullRequestSummary = {
      ...reference,
      provider: "github",
      title: "Invoices",
      url: pr.url,
      state: "open",
      headBranch: "task/invoices",
      baseBranch: "main",
      updatedAt: at,
      reviewDecision: "changes-requested",
      mergedAt: null,
    };
    let checks = [
      {
        name: "Unit tests",
        status: "failure" as "failure" | "success",
        description: "Rounding failed",
        url: null,
      },
    ];
    let activity: PullRequestActivity = {
      comments: [
        {
          id: "comment",
          kind: "issue-comment",
          author: { login: "reviewer", name: null, avatarUrl: null },
          body: "Fix rounding",
          path: null,
          reviewState: null,
          createdAt: at,
          url: null,
        },
      ],
      commentCount: 1,
      commentsTruncated: false,
      reviewThreads: [],
      commits: [],
    };
    let offline = false;
    const sent: { input: WorkReviewMutation; feedback: string }[] = [];
    const merged: string[] = [];
    const service = yield* make.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(WorkItems.WorkItemService, work),
          Layer.mock(WorkExecutionService)({
            get: (id) =>
              work.get(id).pipe(
                Effect.orDie,
                Effect.map((item) => ({ item, execution: null, agents: [] })),
              ),
            startReview: Effect.fn(function* (input, _snapshot, feedback) {
              sent.push({ input, feedback });
              yield* sql`INSERT INTO work_item_execution_commands(command_id,request_json) VALUES (${input.commandId},${encode(input)})`.pipe(
                Effect.orDie,
              );
            }),
            completeMerged: Effect.fn(function* (id, mergedAt) {
              merged.push(mergedAt);
              const current = yield* work.get(id).pipe(Effect.orDie);
              if (current.status !== "done")
                yield* work
                  .mutate({
                    kind: "status",
                    id,
                    commandId: "merge-complete",
                    expectedRevision: current.revision,
                    status: "done",
                  })
                  .pipe(Effect.orDie);
            }),
          }),
          Layer.mock(OrchestrationEngineService)({
            subscribeDomainEvents: Effect.succeed(Stream.never),
          }),
          Layer.mock(PullRequestService)({
            invalidate: () => Effect.void,
            summary: () =>
              offline
                ? Effect.fail(
                    new PullRequestOperationError({ operation: "summary", detail: "Host offline" }),
                  )
                : Effect.succeed(summary),
            detail: () =>
              Effect.succeed({
                reviewers: [{ login: "reviewer", name: null, avatarUrl: null }],
                checks,
              } as unknown as PullRequestDetail),
            activity: () => Effect.succeed(activity),
            subscribeMerges: Effect.succeed(Stream.never),
            subscribeRefreshes: Stream.never,
          }),
        ),
      ),
    );
    yield* service.drain;
    return {
      service,
      work,
      item,
      sent,
      merged,
      sql,
      setOffline: () => {
        offline = true;
      },
      approve: () => {
        summary = { ...summary, reviewDecision: "approved" };
        checks = [{ ...checks[0]!, status: "success" }];
      },
      close: () => {
        summary = { ...summary, state: "closed", mergedAt: null };
      },
      merge: () => {
        summary = { ...summary, state: "merged", mergedAt: at };
      },
      truncate: () => {
        activity = { ...activity, commentsTruncated: true };
      },
      editComment: () => {
        activity = {
          ...activity,
          comments: [{ ...activity.comments[0]!, body: "Fix rounding and taxes" }],
        };
      },
    };
  });
const setup = setupWithThread();
it.effect(
  "records reviews, comments and check transitions without duplicating unchanged snapshots",
  () =>
    Effect.gen(function* () {
      const ctx = yield* setup;
      const first = yield* ctx.service.get(ctx.item.id);
      assert.equal(first.snapshot?.revision, 1);
      assert.isTrue(first.history.some((event) => event.kind === "pr_changes_requested"));
      assert.isTrue(first.history.some((event) => event.kind === "pr_comment"));
      assert.isTrue(first.history.some((event) => event.kind === "pr_check_failed"));
      yield* ctx.service.requestSync(undefined);
      yield* ctx.service.drain;
      const same = yield* ctx.service.get(ctx.item.id);
      assert.equal(same.history.length, first.history.length);
      assert.equal(same.item.revision, first.item.revision);
      ctx.approve();
      yield* ctx.service.refresh(ctx.item.id, true);
      const approved = yield* ctx.service.get(ctx.item.id);
      assert.isTrue(approved.history.some((event) => event.kind === "pr_approved"));
      assert.isTrue(approved.history.some((event) => event.kind === "pr_checks_passed"));
    }).pipe(Effect.provide(SqlitePersistenceMemory), Effect.scoped),
);
it.effect(
  "sends the reviewed comments and failed checks with guidance and deduplicates retries",
  () =>
    Effect.gen(function* () {
      const ctx = yield* setup;
      const state = yield* ctx.service.get(ctx.item.id);
      const input: WorkReviewMutation = {
        kind: "send",
        id: ctx.item.id,
        commandId: "send",
        expectedWorkItemRevision: state.item.revision,
        expectedReviewRevision: state.snapshot!.revision,
        guidance: "Use integer cents",
        validationCommands: ["npm test"],
      };
      yield* ctx.service.mutate(input);
      yield* ctx.service.mutate(input);
      assert.equal(ctx.sent.length, 1);
      assert.include(ctx.sent[0]!.feedback, "Fix rounding");
      assert.include(ctx.sent[0]!.feedback, "Rounding failed");
      assert.include(ctx.sent[0]!.feedback, "Use integer cents");
      const conflict = yield* ctx.service
        .mutate({ ...input, guidance: "Changed" })
        .pipe(Effect.flip);
      assert.equal(conflict.code, "conflict");
    }).pipe(Effect.provide(SqlitePersistenceMemory), Effect.scoped),
);
it.effect("new or incomplete review feedback requires a fresh review before execution", () =>
  Effect.gen(function* () {
    const ctx = yield* setup;
    const state = yield* ctx.service.get(ctx.item.id);
    const input: WorkReviewMutation = {
      kind: "send",
      id: ctx.item.id,
      commandId: "send",
      expectedWorkItemRevision: state.item.revision,
      expectedReviewRevision: state.snapshot!.revision,
      guidance: "",
      validationCommands: ["npm test"],
    };
    ctx.editComment();
    assert.equal((yield* ctx.service.mutate(input).pipe(Effect.flip)).code, "conflict");
    ctx.truncate();
    yield* ctx.service.refresh(ctx.item.id, true);
    const current = yield* ctx.service.get(ctx.item.id);
    const error = yield* ctx.service
      .mutate({
        ...input,
        expectedWorkItemRevision: current.item.revision,
        expectedReviewRevision: current.snapshot!.revision,
      })
      .pipe(Effect.flip);
    assert.include(error.message, "incomplete");
    assert.equal(ctx.sent.length, 0);
  }).pipe(Effect.provide(SqlitePersistenceMemory), Effect.scoped),
);
it.effect("retains cached review data during a host outage and does not start an agent", () =>
  Effect.gen(function* () {
    const ctx = yield* setup;
    const before = yield* ctx.service.get(ctx.item.id);
    ctx.setOffline();
    yield* ctx.service.refresh(ctx.item.id, true).pipe(Effect.flip);
    const after = yield* ctx.service.get(ctx.item.id);
    assert.equal(after.snapshot?.fingerprint, before.snapshot?.fingerprint);
    assert.include(after.syncError ?? "", "Host offline");
    assert.equal(ctx.sent.length, 0);
  }).pipe(Effect.provide(SqlitePersistenceMemory), Effect.scoped),
);
it.effect("background PR synchronization completes merged WorkItems", () =>
  Effect.gen(function* () {
    const ctx = yield* setup;
    ctx.merge();
    yield* ctx.service.requestSync(undefined);
    yield* ctx.service.drain;
    assert.equal((yield* ctx.service.get(ctx.item.id)).item.status, "done");
    assert.deepEqual(ctx.merged, [at]);
  }).pipe(Effect.provide(SqlitePersistenceMemory), Effect.scoped),
);

for (const source of ["created", "branch"] as const) {
  it.effect(`tracks ${source} thread PRs through Review and Done without a task PR record`, () =>
    Effect.gen(function* () {
      const ctx = yield* setupWithThread(source);
      const first = yield* ctx.work.get(ctx.item.id);
      assert.equal(first.status, "review");
      assert.isEmpty(yield* ctx.sql`SELECT * FROM work_item_pull_requests`);
      yield* ctx.service.requestSync(undefined);
      yield* ctx.service.drain;
      assert.equal((yield* ctx.work.get(ctx.item.id)).revision, first.revision);
      ctx.close();
      yield* ctx.service.requestSync(undefined);
      yield* ctx.service.drain;
      assert.equal((yield* ctx.work.get(ctx.item.id)).status, "review");
      ctx.merge();
      yield* ctx.service.requestSync(undefined);
      yield* ctx.service.drain;
      assert.equal((yield* ctx.work.get(ctx.item.id)).status, "done");
      assert.deepEqual(ctx.merged, [at]);
    }).pipe(Effect.provide(SqlitePersistenceMemory), Effect.scoped),
  );
}
it.effect("does not advance tasks for unrelated manually linked PRs", () =>
  Effect.gen(function* () {
    const ctx = yield* setupWithThread("manual");
    assert.equal((yield* ctx.work.get(ctx.item.id)).status, "running");
    ctx.merge();
    yield* ctx.service.requestSync(undefined);
    yield* ctx.service.drain;
    assert.equal((yield* ctx.work.get(ctx.item.id)).status, "running");
    assert.isEmpty(ctx.merged);
  }).pipe(Effect.provide(SqlitePersistenceMemory), Effect.scoped),
);

it.effect("detects merges on the background schedule without a client refresh", () =>
  Effect.gen(function* () {
    const ctx = yield* setupWithThread("created");
    ctx.merge();
    yield* TestClock.adjust("1 minute");
    yield* ctx.service.drain;
    assert.equal((yield* ctx.work.get(ctx.item.id)).status, "done");
  }).pipe(Effect.provide(SqlitePersistenceMemory), Effect.scoped),
);
it.effect("keeps archived tasks unchanged when their thread PR merges", () =>
  Effect.gen(function* () {
    const ctx = yield* setupWithThread("created");
    const item = yield* ctx.work.get(ctx.item.id);
    const archived = yield* ctx.work.mutate({
      kind: "archive",
      id: item.id,
      commandId: "archive",
      expectedRevision: item.revision,
      archived: true,
    });
    ctx.merge();
    yield* ctx.service.requestSync(undefined);
    yield* ctx.service.drain;
    yield* ctx.service.refresh(item.id, true);
    assert.deepEqual(yield* ctx.work.get(item.id), archived);
    assert.isEmpty(ctx.merged);
  }).pipe(Effect.provide(SqlitePersistenceMemory), Effect.scoped),
);
