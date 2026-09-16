import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
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
    replies: [] as Array<{ threadTs: string; body: string }>,
    workspaceId: "T123",
    failWorkspace: null as string | null,
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
    reply: (_token, _workspace, _channel, threadTs, body) =>
      Effect.sync(() => {
        state.replies.push({ threadTs, body });
        return { url: "https://example.slack.com/archives/C123/p1760000000000002" };
      }),
    oauth: () =>
      Effect.sync(() => {
        state.exchanges++;
        return {
          team: { id: state.workspaceId, name: "Example" },
          authed_user: {
            id: "U123",
            access_token: "private-access-token",
            refresh_token: "private-refresh-token",
            expires_in: state.expires ? 1 : 3600,
            scope:
              "chat:write,search:read,channels:read,groups:read,channels:history,groups:history",
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
    mentions: (_token, id) =>
      Effect.gen(function* () {
        state.reads++;
        if (state.failRead && (!state.failWorkspace || state.failWorkspace === id))
          return yield* fail("rate_limit", "Retry later");
        return state.messages;
      }),
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
      assert.strictEqual(url.searchParams.get("user_scope")?.includes("chat:write"), true);
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

it.effect(
  "automatically creates Work tasks from direct mentions across unconfigured channels and preserves local work",
  () =>
    Effect.gen(function* () {
      const { service, work, state, build } = yield* setup;
      yield* service.admin({ kind: "untrack", workspaceId: "T123", channelId: "C123" });
      state.messages = [
        { ts: "1760000000.000001", channel: { id: "CONE" }, text: "<@U123> first request" },
        {
          ts: "1760000000.000002",
          channel: { id: "CTWO" },
          text: "<@U123> reply request",
          thread_ts: "1760000000.000000",
        },
        { ts: "1760000000.000003", channel: { id: "CONE" }, text: "<!channel> announcement" },
        { ts: "1760000000.000004", channel: { id: "CONE" }, text: "<@U999> someone else" },
      ];
      yield* service.syncWorkspace("T123");
      const queue = yield* work.list({});
      assert.strictEqual(queue.total, 2);
      assert.isTrue(
        queue.items.every((item) => item.status === "inbox" && item.agentThreadId === null),
      );
      assert.deepEqual((yield* service.list({})).channels, []);
      assert.strictEqual((yield* service.list({})).total, 0);
      const item = queue.items[0]!;
      yield* work.mutate({
        kind: "update",
        id: item.id,
        commandId: "local-slack-edit",
        expectedRevision: item.revision,
        patch: { title: "Local title", body: "Local instructions" },
      });
      state.messages = state.messages.map((message) => ({
        ...message,
        text: `${message.text} updated`,
      }));
      const restarted = yield* build;
      yield* restarted.syncWorkspace("T123");
      assert.strictEqual((yield* work.list({})).total, 2);
      assert.strictEqual((yield* work.get(item.id)).title, "Local title");
      assert.strictEqual((yield* work.get(item.id)).body, "Local instructions");
      const fresh = yield* work.get(item.id);
      yield* work.mutate({
        kind: "archive",
        id: item.id,
        commandId: "archive-slack-task",
        expectedRevision: fresh.revision,
        archived: true,
      });
      yield* restarted.syncWorkspace("T123");
      assert.isNotNull((yield* work.get(item.id)).archivedAt);
      const archived = yield* work.get(item.id);
      yield* work.deleteArchived({
        id: item.id,
        expectedRevision: archived.revision,
        commandId: "delete-slack-task",
      });
      yield* restarted.syncWorkspace("T123");
      assert.strictEqual((yield* work.list({})).total, 1);
      assert.strictEqual((yield* work.list({ archived: true })).total, 0);
      assert.strictEqual((yield* work.get(item.id).pipe(Effect.flip)).code, "not_found");
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect(
  "retains the last successful cursor and rolls back task batches when automatic sync fails",
  () =>
    Effect.gen(function* () {
      const { service, work, state } = yield* setup;
      yield* service.syncWorkspace("T123");
      const before = (yield* service.list({})).workspaces[0]!;
      state.failRead = true;
      assert.strictEqual(
        (yield* service.syncWorkspace("T123").pipe(Effect.flip)).code,
        "rate_limit",
      );
      assert.strictEqual(
        (yield* service.list({})).workspaces[0]?.lastSyncedAt,
        before.lastSyncedAt,
      );
      assert.strictEqual((yield* service.list({})).workspaces[0]?.syncStatus, "error");
      state.failRead = false;
      state.messages = [
        { ts: "1760000000.000002", channel: { id: "CNEW" }, text: "<@U123> valid" },
        { ts: "invalid", channel: { id: "CNEW" }, text: "<@U123> invalid" },
      ];
      yield* service.syncWorkspace("T123").pipe(Effect.flip);
      assert.strictEqual((yield* work.list({})).total, 1);
      assert.strictEqual(
        (yield* service.list({})).workspaces[0]?.lastSyncedAt,
        before.lastSyncedAt,
      );
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("keeps ignored messages out of automatic task imports", () =>
  Effect.gen(function* () {
    const { service, work } = yield* setup;
    yield* service.mutate({ kind: "sync", ...config });
    yield* service.mutate({ kind: "ignore", ...reference, ignored: true });
    yield* service.syncWorkspace("T123");
    assert.strictEqual((yield* work.list({})).total, 0);
    yield* service.mutate({ kind: "ignore", ...reference, ignored: false });
    yield* service.syncWorkspace("T123");
    assert.strictEqual((yield* work.list({})).total, 1);
    yield* service.mutate(importInput);
    assert.strictEqual((yield* work.list({})).total, 1);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect(
  "starts after connection, polls every five minutes and stops after disconnect without automation rules",
  () =>
    Effect.gen(function* () {
      const { service, work, state, connect } = yield* setup;
      yield* service.admin({ kind: "disconnect", workspaceId: "T123" });
      const worker = yield* service.start();
      const first = yield* work.changes.pipe(
        Stream.mapEffect(() => work.list({})),
        Stream.filter((queue) => queue.total === 1),
        Stream.runHead,
        Effect.forkScoped,
      );
      yield* connect;
      yield* Fiber.join(first);
      yield* worker.drain;
      assert.strictEqual((yield* service.list({})).workspaces[0]?.syncStatus, "ready");
      state.messages.push({
        ts: "1760000000.000005",
        text: "<@U123> next",
        channel: { id: "CNEW" },
      });
      const second = yield* work.changes.pipe(
        Stream.mapEffect(() => work.list({})),
        Stream.filter((queue) => queue.total === 2),
        Stream.runHead,
        Effect.forkScoped,
      );
      yield* TestClock.adjust("5 minutes");
      yield* Fiber.join(second);
      yield* worker.drain;
      yield* service.admin({ kind: "disconnect", workspaceId: "T123" });
      const reads = state.reads;
      state.messages.push({
        ts: "1760000000.000006",
        text: "<@U123> disconnected",
        channel: { id: "CNEW" },
      });
      yield* TestClock.adjust("5 minutes");
      yield* worker.drain;
      assert.strictEqual(state.reads, reads);
      assert.strictEqual((yield* work.list({})).total, 2);
    }).pipe(Effect.scoped, Effect.provide(SqlitePersistenceMemory)),
);

it.effect("continues automatic imports in other workspaces when one loses access", () =>
  Effect.gen(function* () {
    const { service, work, state, connect } = yield* setup;
    state.workspaceId = "T456";
    yield* connect;
    state.failRead = true;
    state.failWorkspace = "T123";
    const completed = yield* work.changes.pipe(
      Stream.mapEffect(() => work.list({})),
      Stream.filter((queue) => queue.total === 1),
      Stream.runHead,
      Effect.forkScoped,
    );
    const worker = yield* service.start();
    yield* Fiber.join(completed);
    yield* worker.drain;
    const workspaces = (yield* service.list({})).workspaces;
    assert.strictEqual(
      workspaces.find((workspace) => workspace.id === "T123")?.syncStatus,
      "error",
    );
    assert.strictEqual(
      workspaces.find((workspace) => workspace.id === "T456")?.syncStatus,
      "ready",
    );
  }).pipe(Effect.scoped, Effect.provide(SqlitePersistenceMemory)),
);

it.effect("prepares a reply to the original parent when a task came from a Slack reply", () =>
  Effect.gen(function* () {
    const { service, state } = yield* setup;
    yield* service.mutate({ kind: "select", ...reference });
    const send = yield* service.prepareReply(reference);
    assert.deepEqual(state.replies, []);
    yield* send("Reviewed fix summary", "post-reply");
    assert.deepEqual(state.replies, [
      { threadTs: "1760000000.000000", body: "Reviewed fix summary" },
    ]);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("asks older read-only Slack connections to reconnect before posting", () =>
  Effect.gen(function* () {
    const { service, state } = yield* setup;
    const sql = yield* SqlClient.SqlClient;
    yield* service.mutate({ kind: "select", ...reference });
    yield* sql`UPDATE slack_workspaces SET record_json=json_set(record_json, '$.scopes', json('["search:read"]')) WHERE id='T123'`;
    const error = yield* service.prepareReply(reference).pipe(Effect.flip);
    assert.strictEqual(error.code, "authentication");
    assert.include(error.message, "chat:write");
    assert.deepEqual(state.replies, []);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
