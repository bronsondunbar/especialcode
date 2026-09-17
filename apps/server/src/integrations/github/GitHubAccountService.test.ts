import { assert, it } from "@effect/vitest";
import { GitHubIssuesError, type GitHubIssue } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as WorkItems from "../../workItems/WorkItemService.ts";
import { GitHubIssuesAdapter } from "./GitHubIssuesAdapter.ts";
import * as Issues from "./GitHubIssuesService.ts";
import { make } from "./GitHubAccountService.ts";
const snapshot = (id: number, repository: string): GitHubIssue => ({
  host: "github.com",
  repository,
  externalId: String(id),
  number: id,
  title: `Issue ${id}`,
  body: "Original body",
  url: `https://github.com/${repository}/issues/${id}`,
  state: "open",
  labels: [],
  assignees: ["alice"],
  milestone: null,
  updatedAt: "2026-01-01T00:00:00Z",
  comments: [],
  commentsFetchedAt: null,
});
const setup = Effect.gen(function* () {
  const work = yield* WorkItems.make;
  const snapshots = yield* Ref.make([
    snapshot(1, "org-one/private"),
    snapshot(2, "org-two/private"),
  ]);
  const failure = yield* Ref.make<GitHubIssuesError | null>(null);
  const viewer = yield* Ref.make({ id: 123, login: "alice" });
  const called = yield* Ref.make(yield* Deferred.make<void>());
  const adapter = GitHubIssuesAdapter.of({
    repositories: () =>
      Effect.succeed({
        repositories: [{ repository: "org-one/private", private: true }],
        partialAccess: false,
      }),
    comment: () => Effect.die("unused"),
    viewer: () => Ref.get(viewer),
    assigned: () =>
      Effect.gen(function* () {
        yield* Deferred.succeed(yield* Ref.get(called), undefined);
        const error = yield* Ref.get(failure);
        if (error) return yield* error;
        return { issues: yield* Ref.get(snapshots), partialAccess: false };
      }),
    list: () => Ref.get(snapshots),
    detail: () => Effect.succeed(snapshot(1, "org-one/private")),
  });
  const issues = yield* Issues.make.pipe(
    Effect.provideService(WorkItems.WorkItemService, work),
    Effect.provideService(GitHubIssuesAdapter, adapter),
  );
  const values = new Map<string, Uint8Array>();
  const secrets = ServerSecretStore.of({
    get: (name) => Effect.sync(() => Option.fromUndefinedOr(values.get(name))),
    set: (name, value) =>
      Effect.sync(() => {
        values.set(name, value);
      }),
    remove: (name) =>
      Effect.sync(() => {
        values.delete(name);
      }),
    create: () => Effect.void,
    getOrCreateRandom: () => Effect.succeed(new Uint8Array()),
  });
  const build = make.pipe(
    Effect.provideService(Issues.GitHubIssuesService, issues),
    Effect.provideService(GitHubIssuesAdapter, adapter),
    Effect.provideService(ServerSecretStore, secrets),
  );
  const service = yield* build;
  return { service, work, issues, snapshots, failure, viewer, values, build, called };
});
it.effect(
  "connects once and creates deduplicated Work tasks across organizations, preserving edits and disconnect history",
  () =>
    Effect.gen(function* () {
      const { service, work, issues, snapshots, values, build } = yield* setup;
      yield* service.admin({ kind: "connect", token: "test-token" });
      const queue = yield* work.list({});
      assert.strictEqual(queue.total, 2);
      assert.isTrue(
        queue.items.every((item) => item.status === "inbox" && item.agentThreadId === null),
      );
      const item = queue.items[0]!;
      yield* work.mutate({
        kind: "update",
        id: item.id,
        commandId: "local-edit",
        expectedRevision: item.revision,
        patch: { title: "Local title" },
      });
      yield* Ref.update(snapshots, (items) =>
        items.map((issue) => ({ ...issue, title: "Changed remotely", body: "Updated body" })),
      );
      const restarted = yield* build;
      yield* restarted.admin({ kind: "sync" });
      assert.strictEqual((yield* work.list({})).total, 2);
      assert.strictEqual((yield* work.get(item.id)).title, "Local title");
      assert.strictEqual((yield* work.get(item.id)).body, "Updated body");
      // The account source is not a duplicate repository inbox.
      const list = yield* issues.list({});
      assert.deepEqual(list.repositories, []);
      assert.strictEqual(list.total, 0);
      assert.strictEqual(list.account?.login, "alice");
      const sql = yield* SqlClient.SqlClient;
      const stored = yield* sql<{ record_json: string }>`SELECT record_json FROM github_account`;
      assert.notInclude(stored[0]!.record_json, "test-token");
      yield* Ref.set(snapshots, []);
      yield* restarted.admin({ kind: "sync" });
      assert.strictEqual((yield* work.list({})).total, 2);
      yield* restarted.admin({ kind: "disconnect" });
      assert.strictEqual(values.size, 0);
      assert.isNull((yield* issues.list({})).account);
      assert.strictEqual((yield* work.list({})).total, 2);
    }).pipe(Effect.scoped, Effect.provide(SqlitePersistenceMemory)),
);

it.effect(
  "retains tasks and last successful sync on errors, rejects changed identity and rolls back failed connection imports",
  () =>
    Effect.gen(function* () {
      const { service, work, issues, failure, snapshots, viewer, values } = yield* setup;
      yield* service.admin({ kind: "connect", token: "test-token" });
      const previous = (yield* issues.list({})).account!;
      yield* Ref.set(
        failure,
        new GitHubIssuesError({ code: "rate_limit", message: "Retry later." }),
      );
      assert.strictEqual(
        (yield* service.admin({ kind: "sync" }).pipe(Effect.flip)).code,
        "rate_limit",
      );
      assert.strictEqual((yield* issues.list({})).account?.lastSyncedAt, previous.lastSyncedAt);
      assert.strictEqual((yield* issues.list({})).account?.syncStatus, "error");
      assert.strictEqual((yield* work.list({})).total, 2);
      yield* Ref.set(failure, null);
      yield* Ref.set(viewer, { id: 456, login: "bob" });
      assert.strictEqual(
        (yield* service.admin({ kind: "sync" }).pipe(Effect.flip)).code,
        "authentication",
      );
      yield* Ref.set(viewer, { id: 123, login: "alice" });
      yield* Ref.set(snapshots, [
        snapshot(3, "new/repo"),
        { ...snapshot(4, "new/repo"), title: "" },
      ]);
      yield* service.admin({ kind: "connect", token: "replacement-token" }).pipe(Effect.flip);
      assert.strictEqual((yield* work.list({})).total, 2);
      assert.deepEqual(
        [...values.values()].map((value) => new TextDecoder().decode(value)),
        ["test-token"],
      );
    }).pipe(Effect.scoped, Effect.provide(SqlitePersistenceMemory)),
);

it.effect(
  "refreshes assigned tasks on startup and every five minutes, then stops after disconnect",
  () =>
    Effect.gen(function* () {
      const { service, work, snapshots, called } = yield* setup;
      yield* service.admin({ kind: "connect", token: "test-token" });
      yield* Ref.set(called, yield* Deferred.make<void>());
      yield* Ref.update(snapshots, (items) => [...items, snapshot(3, "third/repo")]);
      yield* service.start();
      yield* Deferred.await(yield* Ref.get(called));
      yield* service.drain;
      assert.strictEqual((yield* work.list({})).total, 3);
      yield* Ref.set(called, yield* Deferred.make<void>());
      yield* Ref.update(snapshots, (items) => [...items, snapshot(4, "fourth/repo")]);
      yield* TestClock.adjust("5 minutes");
      yield* Deferred.await(yield* Ref.get(called));
      yield* service.drain;
      assert.strictEqual((yield* work.list({})).total, 4);
      yield* service.admin({ kind: "disconnect" });
      yield* Ref.update(snapshots, (items) => [...items, snapshot(5, "fifth/repo")]);
      yield* TestClock.adjust("5 minutes");
      yield* service.drain;
      assert.strictEqual((yield* work.list({})).total, 4);
    }).pipe(Effect.scoped, Effect.provide(SqlitePersistenceMemory)),
);

it.effect("does not recreate permanently deleted assigned issues after a new sync", () =>
  Effect.gen(function* () {
    const { service, work, build } = yield* setup;
    yield* service.admin({ kind: "connect", token: "test-token" });
    const item = (yield* work.list({})).items[0]!;
    const archived = yield* work.mutate({
      kind: "archive",
      id: item.id,
      expectedRevision: item.revision,
      commandId: "archive-before-delete",
      archived: true,
    });
    yield* work.deleteArchived({
      id: item.id,
      expectedRevision: archived.revision,
      commandId: "delete-github",
    });
    const restarted = yield* build;
    yield* restarted.admin({ kind: "sync" });
    assert.strictEqual((yield* work.list({})).total, 1);
    assert.strictEqual((yield* work.list({ archived: true })).total, 0);
    assert.strictEqual((yield* work.get(item.id).pipe(Effect.flip)).code, "not_found");
  }).pipe(Effect.scoped, Effect.provide(SqlitePersistenceMemory)),
);

it.effect(
  "loads repository choices only for the connected account and clears them after disconnect",
  () =>
    Effect.gen(function* () {
      const { service, values } = yield* setup;
      assert.deepEqual(yield* service.repositories(), {
        login: null,
        repositories: [],
        partialAccess: false,
      });
      yield* service.admin({ kind: "connect", token: "repo-token" });
      assert.deepEqual(yield* service.repositories(), {
        login: "alice",
        repositories: [{ repository: "org-one/private", private: true }],
        partialAccess: false,
      });
      values.clear();
      assert.strictEqual((yield* service.repositories().pipe(Effect.flip)).code, "authentication");
      yield* service.admin({ kind: "disconnect" });
      assert.deepEqual(yield* service.repositories(), {
        login: null,
        repositories: [],
        partialAccess: false,
      });
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
