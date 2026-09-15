import { assert, it } from "@effect/vitest";
import { SlackListResult, WorkItemId, type SlackChannelConfig } from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as TestClock from "effect/testing/TestClock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
const encodeList = Schema.encodeSync(Schema.fromJsonString(SlackListResult));
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as Events from "../../notifications/ApplicationEventService.ts";
import * as Work from "../../workItems/WorkItemService.ts";
import { SlackAdapter, fail, type RawSlackMessage } from "./SlackAdapter.ts";
import { make } from "./SlackService.ts";
const config: SlackChannelConfig = {
  workspaceId: "T123",
  channelId: "C123",
  name: "dev",
  projectId: null,
  repository: "owner/repo",
  channelMentions: false,
};
const reference = { ...config, ts: "1760000000.000001" };
const env = ConfigProvider.layer(
  ConfigProvider.fromEnv({
    env: {
      T3CODE_SLACK_CLIENT_ID: "client",
      T3CODE_SLACK_CLIENT_SECRET: "secret",
      T3CODE_SLACK_REDIRECT_URI: "https://example.test/api/integrations/slack/callback",
    },
  }),
);
const setup = Effect.gen(function* () {
  const work = yield* Work.make;
  const events = yield* Events.make;
  const secretValues = new Map<string, Uint8Array>();
  const secrets = ServerSecretStore.of({
    get: (name) => Effect.succeed(Option.fromUndefinedOr(secretValues.get(name))),
    set: (name, value) =>
      Effect.sync(() => {
        secretValues.set(name, value);
      }),
    remove: (name) =>
      Effect.sync(() => {
        secretValues.delete(name);
      }),
    create: () => Effect.die("unused"),
    getOrCreateRandom: () => Effect.die("unused"),
  });
  const state = {
    exchanges: 0,
    rotations: 0,
    reads: 0,
    hasMore: false,
    cursor: "",
    failRead: false,
    expires: false,
    missing: false,
    messages: [
      { ts: reference.ts, text: "Please fix <@U123>", user: "U456", channel: { id: "C123" } },
    ] as Array<RawSlackMessage & { channel: { id: string } }>,
  };
  const adapter = SlackAdapter.of({
    oauth: () =>
      Effect.sync(() => {
        state.exchanges++;
        return {
          team: { id: "T123", name: "Example" },
          authed_user: {
            id: "U123",
            access_token: "private-access-token",
            refresh_token: "private-refresh-token",
            expires_in: state.expires ? 1 : 3600,
            scope: "search:read,channels:read,groups:read,channels:history,groups:history",
          },
        };
      }),
    refresh: () =>
      Effect.sync(() => {
        state.rotations++;
        return {
          access_token: "rotated-token",
          refresh_token: "rotated-refresh",
          expires_in: 3600,
          scope: "search:read",
        };
      }),
    channels: () => Effect.succeed({ channels: [{ id: "C123", name: "dev" }], nextCursor: "" }),
    channel: (_token, _workspace, id) => Effect.succeed({ id, name: "dev" }),
    search: () =>
      Effect.gen(function* () {
        state.reads++;
        if (state.failRead) return yield* fail("rate_limit", "Retry later");
        return { messages: state.messages, hasMore: state.hasMore };
      }),
    selected: (_token, _workspace, _channel, ts) =>
      state.missing
        ? Effect.fail(fail("not_found", "Message unavailable"))
        : Effect.succeed({
            ts,
            text: "Selected reply",
            user: "U456",
            thread_ts: "1760000000.000000",
          }),
    thread: (_token, _workspace, _channel, ts, cursor) =>
      Effect.sync(() => {
        state.cursor = cursor ?? "";
        return {
          messages: [{ ts, text: "Thread context", user: "U456" }],
          nextCursor: cursor ? "" : "next-page",
        };
      }),
    permalink: (_token, _workspace, _channel, ts) =>
      Effect.succeed(`https://example.slack.com/archives/C123/p${ts.replace(".", "")}`),
    revoke: () => Effect.void,
  });
  const build = make.pipe(
    Effect.provideService(Work.WorkItemService, work),
    Effect.provideService(Events.ApplicationEventService, events),
    Effect.provideService(ServerSecretStore, secrets),
    Effect.provideService(SlackAdapter, adapter),
    Effect.provide(env),
  );
  const service = yield* build;
  const connect = Effect.gen(function* () {
    const result = yield* service.admin({ kind: "connect" });
    const url = new URL(result.authorizeUrl!);
    yield* service.completeOAuth(url.searchParams.get("state")!, "code");
  });
  yield* connect;
  yield* service.admin({ kind: "configure", ...config });
  return { service, work, events, secretValues, state, build, connect };
});
const importInput = {
  kind: "import" as const,
  ...reference,
  projectId: null,
  repository: "owner/repo",
  priority: "high" as const,
};
it.effect(
  "OAuth state is single-use, rejects forged callbacks, and never exposes credentials in reads",
  () =>
    Effect.gen(function* () {
      const { service, state, secretValues } = yield* setup;
      const before = state.exchanges;
      const first = yield* service.admin({ kind: "connect" });
      const url = new URL(first.authorizeUrl!);
      const token = url.searchParams.get("state")!;
      assert.strictEqual(url.origin, "https://slack.com");
      assert.strictEqual(url.searchParams.get("scope"), null);
      assert.strictEqual(url.searchParams.get("user_scope")?.includes("chat:write"), false);
      assert.strictEqual(
        (yield* service.completeOAuth("forged", "code").pipe(Effect.flip)).code,
        "authentication",
      );
      assert.strictEqual(state.exchanges, before);
      yield* service.completeOAuth(token, "code");
      assert.strictEqual(
        (yield* service.completeOAuth(token, "code").pipe(Effect.flip)).code,
        "authentication",
      );
      assert.strictEqual(state.exchanges, before + 1);
      assert.strictEqual(secretValues.size, 1);
      const json = encodeList(yield* service.list({}));
      assert.isFalse(json.includes("private-access-token"));
      assert.isFalse(json.includes("private-refresh-token"));
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
it.effect("OAuth attempts expire after ten minutes and cannot survive a restart", () =>
  Effect.gen(function* () {
    const { service, build } = yield* setup;
    const result = yield* service.admin({ kind: "connect" });
    const token = new URL(result.authorizeUrl!).searchParams.get("state")!;
    const restarted = yield* build;
    assert.strictEqual(
      (yield* restarted.completeOAuth(token, "code").pipe(Effect.flip)).code,
      "authentication",
    );
    yield* TestClock.adjust("11 minutes");
    assert.strictEqual(
      (yield* service.completeOAuth(token, "code").pipe(Effect.flip)).code,
      "authentication",
    );
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
it.effect(
  "reads only configured channels, filters mentions, preserves ignore and publishes each mention once",
  () =>
    Effect.gen(function* () {
      const { service, state } = yield* setup;
      assert.strictEqual(
        (yield* service
          .mutate({ kind: "sync", workspaceId: "T123", channelId: "C999" })
          .pipe(Effect.flip)).code,
        "invalid",
      );
      assert.strictEqual(state.reads, 0);
      state.messages.push(
        {
          ts: "1760000000.000002",
          text: "Ordinary discussion",
          user: "U456",
          channel: { id: "C123" },
        },
        { ts: "1760000000.000003", text: "Hi <!channel>", user: "U456", channel: { id: "C123" } },
      );
      yield* service.mutate({ kind: "sync", ...config });
      assert.strictEqual((yield* service.list({})).total, 1);
      yield* service.mutate({ kind: "ignore", ...reference, ignored: true });
      yield* service.admin({ kind: "configure", ...config, channelMentions: true });
      yield* service.mutate({ kind: "sync", ...config });
      assert.strictEqual((yield* service.list({})).total, 1);
      assert.strictEqual((yield* service.list({ ignored: true })).total, 1);
      const sql = yield* SqlClient.SqlClient;
      assert.strictEqual(
        (yield* sql<{ n: number }>`SELECT count(*) AS n FROM application_events`)[0]?.n,
        2,
      );
      yield* service.mutate({ kind: "ignore", ...reference, ignored: false });
      assert.strictEqual((yield* service.list({})).total, 2);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
it.effect(
  "imports once across retries and restart, retaining Slack provenance and task fields",
  () =>
    Effect.gen(function* () {
      const { service, work, build } = yield* setup;
      yield* service.mutate({ kind: "select", ...reference });
      yield* service.mutate({ kind: "thread", ...reference });
      const [a, b] = yield* Effect.all([service.mutate(importInput), service.mutate(importInput)], {
        concurrency: 2,
      });
      assert.strictEqual(a.workItemId, b.workItemId);
      const item = yield* work.get(a.workItemId!);
      assert.strictEqual(item.source, "slack");
      assert.strictEqual(item.priority, "high");
      assert.strictEqual(item.repository, "owner/repo");
      assert.strictEqual(item.status, "inbox");
      assert.include(item.body, "Thread: 1760000000.000000");
      assert.include(item.body, "Thread context");
      assert.strictEqual(item.resources[0]?.namespace, "T123/C123");
      const restarted = yield* build;
      yield* restarted.mutate(importInput);
      assert.strictEqual((yield* work.list({})).total, 1);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
it.effect("attaches to an existing task without overwriting it or creating duplicates", () =>
  Effect.gen(function* () {
    const { service, work } = yield* setup;
    yield* service.mutate({ kind: "sync", ...config });
    const task = yield* work.mutate({
      kind: "create",
      id: WorkItemId.make("manual-task"),
      commandId: "manual",
      source: "manual",
      title: "Existing task",
      fields: { body: "Keep local text" },
    });
    const result = yield* service.mutate({
      kind: "attach",
      ...reference,
      workItemId: task.id,
      expectedRevision: task.revision,
    });
    assert.strictEqual(result.workItemId, task.id);
    assert.strictEqual((yield* service.mutate(importInput)).workItemId, task.id);
    assert.strictEqual((yield* work.list({})).total, 1);
    assert.strictEqual((yield* work.get(task.id)).body, "Keep local text");
    assert.strictEqual(
      (yield* service
        .mutate({
          kind: "attach",
          ...reference,
          workItemId: WorkItemId.make("other"),
          expectedRevision: 1,
        })
        .pipe(Effect.flip)).code,
      "invalid",
    );
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
it.effect(
  "bounds inbox payloads, loads thread pages explicitly, and preserves data after failed sync",
  () =>
    Effect.gen(function* () {
      const { service, state, work } = yield* setup;
      state.messages[0] = { ...state.messages[0]!, text: "<@U123>" + "x".repeat(99993) };
      state.hasMore = true;
      assert.isTrue((yield* service.mutate({ kind: "sync", ...config })).hasMore);
      assert.strictEqual((yield* service.list({})).items[0]?.text.length, 4000);
      assert.isAbove((yield* service.read(reference)).text.length, 4000);
      const imported = yield* service.mutate(importInput);
      assert.include((yield* work.get(imported.workItemId!)).body, `Thread: ${reference.ts}`);
      yield* service.mutate({ kind: "thread", ...reference });
      yield* service.mutate({ kind: "thread", ...reference, more: true });
      assert.strictEqual(state.cursor, "next-page");
      assert.deepEqual((yield* service.list({})).items[0]?.replies, []);
      state.failRead = true;
      assert.strictEqual(
        (yield* service.mutate({ kind: "sync", ...config }).pipe(Effect.flip)).code,
        "rate_limit",
      );
      assert.strictEqual((yield* service.list({})).total, 1);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
it.effect(
  "rotates expiring credentials once and disconnect clears cached data while keeping imported tasks",
  () =>
    Effect.gen(function* () {
      const { service, state, connect, work, secretValues } = yield* setup;
      state.expires = true;
      yield* connect;
      yield* service.mutate({ kind: "sync", ...config });
      yield* service.mutate({ kind: "sync", ...config });
      assert.strictEqual(state.rotations, 1);
      yield* service.mutate(importInput);
      yield* service.admin({ kind: "disconnect", workspaceId: "T123" });
      const inbox = yield* service.list({});
      assert.strictEqual(inbox.workspaces.length, 0);
      assert.strictEqual(inbox.channels.length, 0);
      assert.strictEqual(inbox.total, 0);
      assert.strictEqual(secretValues.size, 0);
      assert.strictEqual((yield* work.list({})).total, 1);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
it.effect(
  "untracking prevents subsequent reads and retains the imported task's source reference",
  () =>
    Effect.gen(function* () {
      const { service, work } = yield* setup;
      yield* service.mutate({ kind: "sync", ...config });
      yield* service.mutate(importInput);
      yield* service.admin({ kind: "untrack", ...config });
      assert.strictEqual((yield* service.list({})).total, 0);
      assert.strictEqual((yield* service.read(reference).pipe(Effect.flip)).code, "invalid");
      assert.strictEqual((yield* work.list({})).items[0]?.resources[0]?.source, "slack");
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect(
  "persists failed sync state and recovers without duplicate notifications or task edits",
  () =>
    Effect.gen(function* () {
      const c = yield* setup;
      yield* c.service.mutate({ kind: "sync", ...config });
      yield* c.service.mutate(importInput);
      const item = (yield* c.work.list({})).items[0]!;
      const at = (yield* c.service.list({})).channels[0]!.lastSyncedAt;
      c.state.failRead = true;
      yield* c.service.mutate({ kind: "sync", ...config }).pipe(Effect.flip);
      const failed = yield* c.service.list({});
      assert.strictEqual(failed.channels[0]?.syncStatus, "error");
      assert.strictEqual(failed.channels[0]?.lastSyncedAt, at);
      assert.strictEqual((yield* c.work.get(item.id)).revision, item.revision);
      c.state.failRead = false;
      yield* c.service.mutate({ kind: "sync", ...config });
      assert.strictEqual((yield* c.service.list({})).channels[0]?.syncStatus, "ready");
      assert.strictEqual((yield* c.work.list({})).total, 1);
      const sql = yield* SqlClient.SqlClient;
      assert.strictEqual(
        (yield* sql<{ n: number }>`SELECT count(*) AS n FROM application_events`)[0]?.n,
        2,
      );
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
it.effect("retains unavailable Slack messages and their imported tasks until access returns", () =>
  Effect.gen(function* () {
    const c = yield* setup;
    yield* c.service.mutate({ kind: "select", ...reference });
    yield* c.service.mutate(importInput);
    const before = yield* c.service.read(reference);
    c.state.missing = true;
    yield* c.service.mutate({ kind: "select", ...reference }).pipe(Effect.flip);
    const failed = yield* c.service.read(reference);
    assert.strictEqual(failed.syncStatus, "unavailable");
    assert.strictEqual(failed.text, before.text);
    assert.strictEqual(failed.lastSyncedAt, before.lastSyncedAt);
    assert.strictEqual((yield* c.work.list({})).total, 1);
    yield* c.service.mutate({ kind: "thread", ...reference, more: true });
    assert.strictEqual((yield* c.service.read(reference)).syncStatus, "unavailable");
    c.state.missing = false;
    yield* c.service.mutate({ kind: "select", ...reference });
    assert.strictEqual((yield* c.service.read(reference)).syncError, null);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("rolls back a malformed sync batch and keeps the last successful snapshot", () =>
  Effect.gen(function* () {
    const c = yield* setup;
    yield* c.service.mutate({ kind: "sync", ...config });
    yield* c.service.mutate(importInput);
    const before = yield* c.service.read(reference);
    const task = (yield* c.work.list({})).items[0]!;
    c.state.messages = [
      { ...c.state.messages[0]!, text: "Updated <@U123>" },
      { ...c.state.messages[0]!, ts: "invalid-timestamp" },
    ];
    yield* c.service.mutate({ kind: "sync", ...config }).pipe(Effect.flip);
    assert.strictEqual((yield* c.service.read(reference)).text, before.text);
    const inbox = yield* c.service.list({});
    assert.strictEqual(inbox.total, 1);
    assert.strictEqual(inbox.channels[0]?.syncStatus, "error");
    assert.strictEqual(inbox.channels[0]?.lastSyncedAt, before.lastSyncedAt);
    assert.strictEqual((yield* c.work.get(task.id)).revision, task.revision);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
