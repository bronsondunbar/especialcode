import { assert, it } from "@effect/vitest";
import { GitHubIssuesError, ProjectId, type GitHubIssue } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as WorkItems from "../../workItems/WorkItemService.ts";
import { GitHubIssuesAdapter } from "./GitHubIssuesAdapter.ts";
import { make } from "./GitHubIssuesService.ts";

const repo = { host: "github.com", repository: "example/repo" };
const reference = { ...repo, number: 42 };
const issue: GitHubIssue = {
  ...reference,
  externalId: "9001",
  title: "Original title",
  body: "Original body",
  url: "https://github.com/example/repo/issues/42",
  state: "open",
  labels: ["ready"],
  assignees: ["alice"],
  milestone: "v1",
  updatedAt: "2026-01-01T00:00:00.000Z",
  comments: [],
  commentsFetchedAt: null,
};
const setup = Effect.gen(function* () {
  const work = yield* WorkItems.make;
  const issues = yield* Ref.make<ReadonlyArray<GitHubIssue>>([issue]);
  const listResults = yield* Ref.make<ReadonlyArray<GitHubIssue> | null>(null);
  const failure = yield* Ref.make<GitHubIssuesError | null>(null);
  const cursors = yield* Ref.make<ReadonlyArray<string | null>>([]);
  const detail = Effect.fn(function* (ref: typeof reference) {
    const error = yield* Ref.get(failure);
    if (error) return yield* error;
    const found = (yield* Ref.get(issues)).find((item) => item.number === ref.number);
    if (!found)
      return yield* new GitHubIssuesError({ code: "not_found", message: "Issue not found." });
    return { ...found, commentsFetchedAt: "2026-01-02T00:00:00.000Z" };
  });
  const adapter = GitHubIssuesAdapter.of({
    repositories: () =>
      Effect.succeed({
        repositories: [{ repository: "org-one/private", private: true }],
        partialAccess: false,
      }),
    comment: () => Effect.die("unused"),
    viewer: () => Effect.succeed({ id: 1, login: "alice" }),
    assigned: () =>
      Ref.get(issues).pipe(Effect.map((value) => ({ issues: [...value], partialAccess: false }))),
    list: Effect.fn(function* (_repo, since) {
      yield* Ref.update(cursors, (values) => [...values, since]);
      const error = yield* Ref.get(failure);
      if (error) return yield* error;
      return [...((yield* Ref.get(listResults)) ?? (yield* Ref.get(issues)))];
    }),
    detail,
  });
  const service = yield* make.pipe(
    Effect.provideService(WorkItems.WorkItemService, work),
    Effect.provideService(GitHubIssuesAdapter, adapter),
  );
  yield* service.mutate({ ...repo, kind: "configure", projectId: null, importLabels: [] });
  return { service, work, issues, failure, cursors, adapter, listResults };
});

it.effect(
  "imports by issue number, persists details, deduplicates concurrent retries and keeps local identity separate",
  () =>
    Effect.gen(function* () {
      const { service, work, adapter } = yield* setup;
      yield* Effect.all(
        [
          service.mutate({ ...reference, kind: "import" }),
          service.mutate({ ...reference, kind: "import" }),
        ],
        { concurrency: 2 },
      );
      const queue = yield* work.list({});
      assert.strictEqual(queue.total, 1);
      const item = queue.items[0]!;
      assert.strictEqual(item.source, "github_issue");
      assert.notEqual(item.id, "42");
      assert.strictEqual(item.externalId, "9001");
      assert.strictEqual(item.externalUrl, issue.url);
      const detail = yield* service.get(reference);
      assert.strictEqual(detail.number, 42);
      assert.strictEqual(detail.workItemId, item.id);
      assert.strictEqual(detail.milestone, "v1");
      const restarted = yield* make.pipe(
        Effect.provideService(WorkItems.WorkItemService, work),
        Effect.provideService(GitHubIssuesAdapter, adapter),
      );
      yield* restarted.mutate({ ...reference, kind: "import" });
      assert.strictEqual((yield* work.list({})).total, 1);
      const sql = yield* SqlClient.SqlClient;
      assert.strictEqual(
        (yield* sql<{ n: number }>`SELECT count(*) AS n FROM work_item_events`)[0]?.n,
        1,
      );
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect(
  "refreshes untouched content, preserves local edits and workflow, and observes external close/reopen",
  () =>
    Effect.gen(function* () {
      const { service, work, issues } = yield* setup;
      yield* service.mutate({ ...reference, kind: "import" });
      const id = (yield* service.get(reference)).workItemId!;
      yield* Ref.set(issues, [{ ...issue, title: "Upstream title", body: "Upstream body" }]);
      yield* service.mutate({ ...reference, kind: "refresh" });
      const refreshed = yield* work.get(id);
      assert.strictEqual(refreshed.title, "Upstream title");
      assert.strictEqual(refreshed.body, "Upstream body");
      const edited = yield* work.mutate({
        kind: "update",
        commandId: "edit",
        id,
        expectedRevision: refreshed.revision,
        patch: { title: "My local title", priority: "urgent", branch: "my-branch" },
      });
      yield* work.mutate({
        kind: "status",
        commandId: "review",
        id,
        expectedRevision: edited.revision,
        status: "review",
      });
      yield* Ref.set(issues, [
        {
          ...issue,
          title: "Closed upstream",
          body: "Body after close",
          state: "closed",
          labels: ["bug"],
          assignees: ["bob"],
        },
      ]);
      yield* service.mutate({ ...repo, kind: "sync" });
      const closed = yield* service.get(reference);
      assert.strictEqual(closed.state, "closed");
      assert.strictEqual(closed.localStatus, "review");
      const local = yield* work.get(id);
      assert.strictEqual(local.title, "My local title");
      assert.strictEqual(local.body, "Body after close");
      assert.strictEqual(local.priority, "urgent");
      assert.strictEqual(local.branch, "my-branch");
      assert.strictEqual((yield* service.list({})).total, 0);
      assert.strictEqual(
        (yield* service.list({
          state: "closed",
          label: "bug",
          assignee: "BOB",
          repository: "GITHUB.COM/EXAMPLE/REPO",
        })).total,
        1,
      );
      yield* Ref.set(issues, [{ ...issue, title: "Reopened upstream", body: "Reopened body" }]);
      yield* service.mutate({ ...repo, kind: "sync" });
      assert.strictEqual((yield* service.get(reference)).state, "open");
      assert.strictEqual((yield* work.get(id)).status, "review");
      assert.strictEqual((yield* work.get(id)).title, "My local title");
      assert.strictEqual((yield* work.list({})).total, 1);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect(
  "replaces edited and deleted comments even when the issue update timestamp is unchanged",
  () =>
    Effect.gen(function* () {
      const { service, issues } = yield* setup;
      const comment = {
        id: "1",
        author: "alice",
        body: "First comment",
        url: `${issue.url}#issuecomment-1`,
        createdAt: issue.updatedAt,
        updatedAt: issue.updatedAt,
      };
      yield* Ref.set(issues, [{ ...issue, comments: [comment] }]);
      yield* service.mutate({ ...reference, kind: "import" });
      assert.strictEqual((yield* service.get(reference)).comments[0]?.body, "First comment");
      yield* Ref.set(issues, [{ ...issue, comments: [{ ...comment, body: "Edited comment" }] }]);
      yield* service.mutate({ ...repo, kind: "sync" });
      assert.strictEqual((yield* service.get(reference)).comments[0]?.body, "Edited comment");
      yield* Ref.set(issues, [issue]);
      yield* service.mutate({ ...repo, kind: "sync" });
      assert.deepEqual((yield* service.get(reference)).comments, []);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect(
  "label rules import only matching open issues, apply to cached issues and never start agents",
  () =>
    Effect.gen(function* () {
      const { service, work, issues, listResults } = yield* setup;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES ('project','Project','/tmp/project','[]','2026','2026')`;
      yield* Ref.set(issues, [
        issue,
        { ...issue, externalId: "9002", number: 43, state: "closed" },
        { ...issue, externalId: "9003", number: 44, labels: ["other"] },
      ]);
      yield* service.mutate({ ...repo, kind: "sync" });
      assert.strictEqual((yield* work.list({})).total, 0);
      yield* service.mutate({
        ...repo,
        kind: "configure",
        projectId: ProjectId.make("project"),
        importLabels: ["ready"],
      });
      yield* Ref.set(listResults, []);
      yield* service.mutate({ ...repo, kind: "sync" });
      const queue = yield* work.list({});
      assert.strictEqual(queue.total, 1);
      assert.strictEqual(queue.items[0]?.status, "inbox");
      assert.strictEqual(queue.items[0]?.projectId, "project");
      assert.strictEqual(queue.items[0]?.agentThreadId, null);
      assert.strictEqual(
        (yield* service.list({
          projectId: ProjectId.make("project"),
          state: "all",
          limit: 1,
          offset: 1,
        })).items.length,
        1,
      );
      assert.strictEqual((yield* service.list({ label: "ready", state: "all" })).total, 2);
      yield* service.mutate({ ...repo, kind: "sync" });
      assert.strictEqual((yield* work.list({})).total, 1);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("failed sync keeps cached data, imported work and cursor; retry clears the error", () =>
  Effect.gen(function* () {
    const { service, work, issues, failure, cursors } = yield* setup;
    yield* service.mutate({ ...reference, kind: "import" });
    yield* service.mutate({ ...repo, kind: "sync" });
    const before = yield* service.list({});
    yield* Ref.set(issues, [{ ...issue, title: "Not committed" }]);
    yield* Ref.set(failure, new GitHubIssuesError({ code: "rate_limit", message: "Rate limited" }));
    assert.strictEqual(
      (yield* service.mutate({ ...repo, kind: "sync" }).pipe(Effect.flip)).code,
      "rate_limit",
    );
    const failed = yield* service.list({});
    assert.strictEqual(failed.repositories[0]?.lastSyncedAt, before.repositories[0]?.lastSyncedAt);
    assert.strictEqual(failed.repositories[0]?.syncError, "Rate limited");
    assert.strictEqual(failed.items[0]?.title, "Original title");
    assert.strictEqual((yield* work.list({})).items[0]?.title, "Original title");
    yield* Ref.set(failure, null);
    yield* service.mutate({ ...repo, kind: "sync" });
    assert.isNull((yield* service.list({})).repositories[0]?.syncError);
    const since = yield* Ref.get(cursors);
    assert.isNull(since[0]);
    assert.strictEqual(since[1], since[2]);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect(
  "untracking preserves imported work and re-tracking deduplicates; archive preserves local content",
  () =>
    Effect.gen(function* () {
      const { service, work, issues } = yield* setup;
      yield* service.mutate({ ...reference, kind: "import" });
      const id = (yield* service.get(reference)).workItemId!;
      yield* work.mutate({
        kind: "archive",
        commandId: "archive",
        id,
        expectedRevision: 1,
        archived: true,
      });
      yield* Ref.set(issues, [{ ...issue, body: "Updated externally" }]);
      yield* service.mutate({ ...repo, kind: "sync" });
      assert.strictEqual((yield* work.get(id)).body, "Original body");
      yield* service.mutate({ ...repo, kind: "untrack" });
      assert.strictEqual((yield* service.list({})).repositories.length, 0);
      assert.strictEqual((yield* work.list({ archived: true })).total, 1);
      yield* service.mutate({
        ...repo,
        kind: "configure",
        projectId: null,
        importLabels: ["ready"],
      });
      yield* service.mutate({ ...repo, kind: "sync" });
      assert.strictEqual((yield* work.list({ archived: true })).total, 1);
      assert.strictEqual((yield* service.get(reference)).workItemId, id);
      assert.strictEqual(
        (yield* service
          .mutate({
            ...repo,
            kind: "configure",
            projectId: ProjectId.make("missing"),
            importLabels: [],
          })
          .pipe(Effect.flip)).code,
        "invalid",
      );
      assert.strictEqual(
        (yield* service.mutate({ ...repo, host: "--hostname", kind: "sync" }).pipe(Effect.flip))
          .code,
        "invalid",
      );
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect(
  "reimport after detaching the source reuses the original work item and keeps local edits",
  () =>
    Effect.gen(function* () {
      const { service, work } = yield* setup;
      yield* service.mutate({ ...reference, kind: "import" });
      const id = (yield* service.get(reference)).workItemId!;
      const item = yield* work.get(id);
      const detached = yield* work.mutate({
        kind: "detachResource",
        commandId: "detach",
        id,
        expectedRevision: item.revision,
        resource: item.resources[0]!,
      });
      yield* work.mutate({
        kind: "update",
        commandId: "local",
        id,
        expectedRevision: detached.revision,
        patch: { title: "Local detached title" },
      });
      assert.isNull((yield* service.get(reference)).workItemId);
      yield* service.mutate({ ...reference, kind: "import" });
      assert.strictEqual((yield* service.get(reference)).workItemId, id);
      assert.strictEqual((yield* work.get(id)).title, "Local detached title");
      assert.strictEqual((yield* work.list({})).total, 1);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("records bounded GitHub comment history once across refreshes", () =>
  Effect.gen(function* () {
    const { service, issues } = yield* setup;
    yield* Ref.set(issues, [
      {
        ...issue,
        comments: [
          {
            id: "comment-1",
            author: "alice",
            body: "x".repeat(2500),
            url: "https://github.com/example/repo/issues/42#issuecomment-1",
            createdAt: "2026-09-15T08:00:00.000Z",
            updatedAt: "2026-09-15T08:00:00.000Z",
          },
        ],
      },
    ]);
    yield* service.mutate({ ...reference, kind: "import" });
    yield* service.mutate({ ...reference, kind: "refresh" });
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      summary: string;
      author: string;
    }>`SELECT json_extract(record_json,'$.summary') AS summary,json_extract(record_json,'$.details[0].value') AS author FROM work_item_activity WHERE json_extract(record_json,'$.kind')='github_comment_added'`;
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0]?.summary.length, 1000);
    assert.strictEqual(rows[0]?.author, "alice");
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("emits durable first-sync and label-change triggers once, including label removal", () =>
  Effect.gen(function* () {
    const { service, issues } = yield* setup;
    const sql = yield* SqlClient.SqlClient;
    yield* service.mutate({ ...repo, kind: "sync" });
    yield* service.mutate({ ...repo, kind: "sync" });
    yield* Ref.set(issues, [{ ...issue, labels: ["ready", "agent-ready"] }]);
    yield* service.mutate({ ...reference, kind: "refresh" });
    yield* Ref.set(issues, [{ ...issue, labels: ["agent-ready", "ready"] }]);
    yield* service.mutate({ ...reference, kind: "refresh" });
    yield* Ref.set(issues, [{ ...issue, labels: [] }]);
    yield* service.mutate({ ...repo, kind: "sync" });
    assert.deepEqual(
      yield* sql`SELECT json_extract(record_json,'$.trigger') AS trigger FROM work_automation_events ORDER BY sequence`,
      [
        { trigger: "github_issue_synced" },
        { trigger: "github_label_changed" },
        { trigger: "github_label_changed" },
      ],
    );
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("rolls back task edits, cache and receipts together if applying a sync fails", () =>
  Effect.gen(function* () {
    const ctx = yield* setup;
    yield* ctx.service.mutate({ ...reference, kind: "import" });
    const before = (yield* ctx.work.list({})).items[0]!;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TRIGGER fail_issue_update BEFORE UPDATE ON github_issues BEGIN SELECT RAISE(ABORT,'test write failure'); END`;
    yield* Ref.set(ctx.issues, [
      { ...issue, title: "Updated", body: "Updated body", updatedAt: "2026-02-01T00:00:00.000Z" },
    ]);
    const failed = yield* ctx.service.mutate({ ...repo, kind: "sync" }).pipe(Effect.result);
    assert.strictEqual(failed._tag, "Failure");
    const after = yield* ctx.work.get(before.id);
    assert.strictEqual(after.revision, before.revision);
    assert.strictEqual(after.title, issue.title);
    assert.strictEqual((yield* ctx.service.get(reference)).title, issue.title);
    assert.strictEqual((yield* ctx.service.list({})).repositories[0]?.lastSyncedAt, null);
    assert.strictEqual(
      (yield* sql<{ n: number }>`SELECT count(*) AS n FROM work_item_events`)[0]?.n,
      1,
    );
    yield* sql`DROP TRIGGER fail_issue_update`;
    yield* ctx.service.mutate({ ...repo, kind: "sync" });
    assert.strictEqual((yield* ctx.work.get(before.id)).title, "Updated");
    const revision = (yield* ctx.work.get(before.id)).revision;
    yield* ctx.service.mutate({ ...repo, kind: "sync" });
    assert.strictEqual((yield* ctx.work.get(before.id)).revision, revision);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
it.effect("isolates unavailable imported issues, retains their tasks, and recovers on retry", () =>
  Effect.gen(function* () {
    const ctx = yield* setup;
    yield* ctx.service.mutate({ ...reference, kind: "import" });
    const item = (yield* ctx.work.list({})).items[0]!;
    const second = {
      ...issue,
      externalId: "9002",
      number: 43,
      title: "Available issue",
      url: "https://github.com/example/repo/issues/43",
    };
    yield* Ref.set(ctx.issues, [second]);
    yield* ctx.service.mutate({
      ...repo,
      kind: "configure",
      projectId: null,
      importLabels: ["ready"],
    });
    yield* ctx.service.mutate({ ...repo, kind: "sync" });
    assert.strictEqual((yield* ctx.service.get(reference)).syncStatus, "unavailable");
    assert.strictEqual((yield* ctx.service.list({})).repositories[0]?.syncStatus, "partial");
    assert.strictEqual((yield* ctx.work.get(item.id)).revision, item.revision);
    assert.strictEqual((yield* ctx.work.list({})).total, 2);
    yield* Ref.set(ctx.issues, [issue, second]);
    yield* ctx.service.mutate({ ...repo, kind: "sync" });
    assert.strictEqual((yield* ctx.service.get(reference)).syncStatus, "ready");
    assert.strictEqual((yield* ctx.service.list({})).repositories[0]?.syncError, null);
    assert.strictEqual((yield* ctx.work.list({})).total, 2);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
it.effect("ignores out-of-order source snapshots", () =>
  Effect.gen(function* () {
    const ctx = yield* setup;
    yield* ctx.service.mutate({ ...reference, kind: "import" });
    yield* Ref.set(ctx.issues, [
      { ...issue, title: "Stale title", updatedAt: "2025-01-01T00:00:00.000Z" },
    ]);
    yield* ctx.service.mutate({ ...reference, kind: "refresh" });
    yield* ctx.service.mutate({ ...repo, kind: "sync" });
    assert.strictEqual((yield* ctx.service.get(reference)).title, issue.title);
    assert.strictEqual((yield* ctx.work.list({})).items[0]?.title, issue.title);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
