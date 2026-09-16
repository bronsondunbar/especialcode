import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { forkParked } from "../../serverActivation.ts";
import * as NodeCrypto from "node:crypto";
import {
  SlackAdminInput,
  SlackChannelConfig,
  SlackError,
  SlackListInput,
  SlackMessage,
  SlackMutation,
  SlackWorkspace,
  WorkItemId,
  type SlackReference,
} from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import { ApplicationEventService } from "../../notifications/ApplicationEventService.ts";
import { WorkItemService } from "../../workItems/WorkItemService.ts";
import { SlackAdapter, fail, messageSnapshot } from "./SlackAdapter.ts";
const Credentials = Schema.Struct({
  accessToken: Schema.String,
  refreshToken: Schema.NullOr(Schema.String),
  expiresAt: Schema.NullOr(Schema.Number),
});
const decodeCredentials = Schema.decodeUnknownEffect(Schema.fromJsonString(Credentials));
const encodeCredentials = Schema.encodeSync(Schema.fromJsonString(Credentials));
const decodeWorkspace = Schema.decodeUnknownEffect(Schema.fromJsonString(SlackWorkspace));
const encodeWorkspace = Schema.encodeSync(Schema.fromJsonString(SlackWorkspace));
const decodeChannel = Schema.decodeUnknownEffect(Schema.fromJsonString(SlackChannelConfig));
const encodeChannel = Schema.encodeSync(Schema.fromJsonString(SlackChannelConfig));
const decodeMessage = Schema.decodeUnknownEffect(Schema.fromJsonString(SlackMessage));
const encodeMessage = Schema.encodeEffect(Schema.fromJsonString(SlackMessage));
const decodeAdmin = Schema.decodeUnknownEffect(SlackAdminInput);
const decodeMutation = Schema.decodeUnknownEffect(SlackMutation);
const decodeList = Schema.decodeUnknownEffect(SlackListInput);
const isSlackError = Schema.is(SlackError);
const storageError = (error: unknown) =>
  isSlackError(error)
    ? error
    : fail("storage", "Could not access Slack integration data. Please retry.");
const slackResource = (ref: SlackReference & { url: string | null }) => ({
  source: "slack" as const,
  namespace: `${ref.workspaceId}/${ref.channelId}`,
  externalId: ref.ts,
  url: ref.url ?? `https://app.slack.com/client/${ref.workspaceId}/${ref.channelId}`,
});
const secretName = (id: string) => `slack-${id}`;
const scopes = [
  "chat:write",
  "search:read",
  "channels:read",
  "groups:read",
  "channels:history",
  "groups:history",
];
const taskContent = (config: SlackChannelConfig, message: SlackMessage) => {
  const provenance = `Slack workspace: ${message.workspaceId}\nChannel: #${config.name} (${message.channelId})\nMessage: ${message.ts}\nThread: ${message.threadTs}\n${message.url ?? ""}`;
  const context = message.replies.map((r) => `${r.author} (${r.ts}): ${r.text}`).join("\n\n");
  return {
    title: message.text.replace(/\s+/g, " ").trim().slice(0, 450) || "Slack message",
    body: `${provenance}\n\n${message.text}\n\nThread context:\n${context}`.slice(0, 100_000),
  };
};
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const adapter = yield* SlackAdapter;
  const work = yield* WorkItemService;
  const events = yield* ApplicationEventService;
  const secrets = yield* ServerSecretStore;
  const clientId = yield* Config.string("T3CODE_SLACK_CLIENT_ID").pipe(Config.withDefault(""));
  const clientSecret = yield* Config.string("T3CODE_SLACK_CLIENT_SECRET").pipe(
    Config.withDefault(""),
  );
  const redirectUri = yield* Config.string("T3CODE_SLACK_REDIRECT_URI").pipe(
    Config.withDefault(""),
  );
  const configured =
    !!clientId &&
    !!clientSecret &&
    /^https:\/\/[^?#]+\/api\/integrations\/slack\/callback$/.test(redirectUri);
  const changes = yield* SubscriptionRef.make(0);
  const connections = yield* SubscriptionRef.make(0);
  const lock = yield* Semaphore.make(1);
  const pending = new Map<string, number>();
  const notify = SubscriptionRef.update(changes, (n) => n + 1);
  const workspaces = Effect.fn("SlackService.workspaces")(function* () {
    const rows = yield* sql<{
      record_json: string;
    }>`SELECT record_json FROM slack_workspaces ORDER BY id`;
    return yield* Effect.forEach(rows, (row) => decodeWorkspace(row.record_json));
  });
  const workspace = Effect.fn("SlackService.workspace")(function* (id: string) {
    const found = (yield* workspaces()).find((w) => w.id === id);
    if (!found) return yield* fail("not_found", "Connect this Slack workspace first.");
    return found;
  });
  const saveCredentials = (id: string, value: typeof Credentials.Type) =>
    secrets.set(secretName(id), new TextEncoder().encode(encodeCredentials(value)));
  const token = Effect.fn("SlackService.token")(function* (id: string) {
    yield* workspace(id);
    const stored = yield* secrets.get(secretName(id));
    if (Option.isNone(stored))
      return yield* fail("authentication", "Reconnect this Slack workspace.");
    const value = yield* decodeCredentials(new TextDecoder().decode(stored.value));
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    if (value.expiresAt !== null && value.expiresAt <= now + 60_000) {
      if (!configured || !value.refreshToken)
        return yield* fail("authentication", "Reconnect Slack to renew access.");
      const renewed = yield* adapter.refresh(clientId, clientSecret, value.refreshToken);
      yield* saveCredentials(id, {
        accessToken: renewed.access_token,
        refreshToken: renewed.refresh_token ?? value.refreshToken,
        expiresAt: renewed.expires_in ? now + renewed.expires_in * 1000 : null,
      });
      return renewed.access_token;
    }
    return value.accessToken;
  });
  const channels = Effect.fn("SlackService.channels")(function* () {
    const rows = yield* sql<{
      record_json: string;
    }>`SELECT record_json FROM slack_channels ORDER BY workspace_id,channel_id`;
    return yield* Effect.forEach(rows, (row) => decodeChannel(row.record_json));
  });
  const tracked = Effect.fn("SlackService.tracked")(function* (ref: {
    workspaceId: string;
    channelId: string;
  }) {
    const found = (yield* channels()).find(
      (c) => c.workspaceId === ref.workspaceId && c.channelId === ref.channelId,
    );
    if (!found)
      return yield* fail(
        "invalid",
        "Choose and configure this channel before reading its messages.",
      );
    return found;
  });
  const get = Effect.fn("SlackService.get")(function* (ref: SlackReference) {
    const rows = yield* sql<{
      record_json: string;
    }>`SELECT record_json FROM slack_messages WHERE workspace_id=${ref.workspaceId} AND channel_id=${ref.channelId} AND ts=${ref.ts}`;
    return rows[0] ? yield* decodeMessage(rows[0].record_json) : null;
  });
  const saveMessage = Effect.fn("SlackService.saveMessage")(function* (message: SlackMessage) {
    const record = yield* encodeMessage(message);
    yield* sql`INSERT INTO slack_messages(workspace_id,channel_id,ts,ignored,record_json) VALUES (${message.workspaceId},${message.channelId},${message.ts},${message.ignored ? 1 : 0},${record}) ON CONFLICT(workspace_id,channel_id,ts) DO UPDATE SET ignored=excluded.ignored,record_json=excluded.record_json`;
  });
  const publish = Effect.fn("SlackService.publish")(function* (
    message: SlackMessage,
    type: string,
    projectId: SlackChannelConfig["projectId"],
    itemId: WorkItemId | null = null,
  ) {
    yield* events.append({
      id: `slack:${type}:${message.workspaceId}:${message.channelId}:${message.ts}`,
      source: "slack",
      type,
      userId: null,
      projectId,
      workItemId: itemId,
      title: type === "slack_message_imported" ? "Slack task created" : "Slack mention received",
      message: message.text.slice(0, 5000),
      action: itemId ? { kind: "work_item", workItemId: itemId } : null,
      createdAt: DateTime.formatIso(yield* DateTime.now),
    });
  });
  const importMessage = Effect.fn("SlackService.importMessage")(function* (
    config: SlackChannelConfig,
    message: SlackMessage,
    input: Extract<SlackMutation, { kind: "import" }>,
  ) {
    if (yield* work.isResourceDeleted(slackResource(message))) return null;
    const existing = yield* work.findByResource(slackResource(message));
    if (existing) return existing.id;
    const id = WorkItemId.make(`slack:${input.workspaceId}:${input.channelId}:${input.ts}`);
    const detached = yield* work.get(id).pipe(
      Effect.catchIf(
        (e) => e.code === "not_found",
        () => Effect.succeed(null),
      ),
    );
    if (detached) {
      yield* work
        .mutate({
          kind: "attachResource",
          id,
          expectedRevision: detached.revision,
          commandId: `slack:reattach:${id}:${detached.revision}`,
          resource: slackResource(message),
        })
        .pipe(Effect.mapError((e) => fail("invalid", e.message)));
    } else {
      const content = taskContent(config, message);
      yield* work
        .mutate({
          kind: "create",
          id,
          commandId: `import:${id}`,
          source: "slack",
          title: content.title,
          fields: {
            body: content.body,
            projectId: input.projectId,
            repository: input.repository,
            priority: input.priority,
          },
          resource: slackResource(message),
        })
        .pipe(Effect.mapError((e) => fail("invalid", e.message)));
    }
    yield* publish(message, "slack_message_imported", input.projectId, id);
    yield* events.notifyChange;
    return id;
  });
  const completeOAuth = Effect.fn("SlackService.completeOAuth")(
    function* (state: string, code: string) {
      const expires = pending.get(state);
      pending.delete(state);
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      if (!configured || !expires || expires <= now || !code || code.length > 4096)
        return yield* fail(
          "authentication",
          "This Slack connection link expired or was already used. Start again in Work → Slack.",
        );
      const result = yield* adapter.oauth(clientId, clientSecret, redirectUri, code);
      const granted = result.authed_user.scope.split(",");
      if (!scopes.every((scope) => granted.includes(scope)))
        return yield* fail(
          "authentication",
          "Slack did not grant the required permissions. Reconnect with all requested scopes.",
        );
      const existing = yield* workspaces();
      if (existing.length >= 10 && !existing.some((w) => w.id === result.team.id))
        return yield* fail("invalid", "Disconnect a workspace before adding another (maximum 10).");
      // One shared account per workspace; changing that account requires disconnecting first.
      const previous = existing.find((w) => w.id === result.team.id);
      if (previous && previous.userId !== result.authed_user.id)
        return yield* fail(
          "invalid",
          "Disconnect this workspace before connecting a different Slack account.",
        );
      yield* saveCredentials(result.team.id, {
        accessToken: result.authed_user.access_token,
        refreshToken: result.authed_user.refresh_token ?? null,
        expiresAt: result.authed_user.expires_in
          ? now + result.authed_user.expires_in * 1000
          : null,
      });
      const record: SlackWorkspace = {
        ...previous,
        id: result.team.id,
        name: result.team.name,
        userId: result.authed_user.id,
        scopes: granted,
      };
      yield* sql`INSERT INTO slack_workspaces(id,record_json) VALUES (${record.id},${encodeWorkspace(record)}) ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json`;
      yield* SubscriptionRef.update(connections, (n) => n + 1);
    },
    lock.withPermits(1),
    Effect.mapError(storageError),
    Effect.ensuring(notify),
  );
  const admin = Effect.fn("SlackService.admin")(
    function* (raw: SlackAdminInput) {
      const input = yield* decodeAdmin(raw).pipe(
        Effect.mapError(() => fail("invalid", "Invalid Slack configuration.")),
      );
      const empty = { authorizeUrl: null, channels: [], nextCursor: "" };
      if (input.kind === "connect") {
        if (!configured)
          return yield* fail(
            "unavailable",
            "Set the Slack client ID, client secret and HTTPS callback URL on this environment first.",
          );
        const now = DateTime.toEpochMillis(yield* DateTime.now);
        for (const [key, expires] of pending) if (expires <= now) pending.delete(key);
        if (pending.size >= 10) pending.delete(pending.keys().next().value!);
        const state = NodeCrypto.randomBytes(32).toString("hex");
        pending.set(state, now + 10 * 60_000);
        const params = new URLSearchParams({
          client_id: clientId,
          user_scope: scopes.join(","),
          redirect_uri: redirectUri,
          state,
        });
        return { ...empty, authorizeUrl: `https://slack.com/oauth/v2/authorize?${params}` };
      }
      yield* workspace(input.workspaceId);
      if (input.kind === "disconnect") {
        // Delete locally even if access was revoked remotely; WorkItem provenance remains intact.
        const credential = yield* secrets.get(secretName(input.workspaceId));
        if (Option.isSome(credential)) {
          const value = yield* decodeCredentials(new TextDecoder().decode(credential.value));
          yield* adapter
            .revoke(value.accessToken, input.workspaceId)
            .pipe(Effect.catch(() => Effect.void));
        }
        yield* secrets.remove(secretName(input.workspaceId));
        yield* sql`DELETE FROM slack_workspaces WHERE id=${input.workspaceId}`;
        pending.clear();
        return empty;
      }
      if (input.kind === "untrack") {
        yield* sql`DELETE FROM slack_channels WHERE workspace_id=${input.workspaceId} AND channel_id=${input.channelId}`;
        return empty;
      }
      const access = yield* token(input.workspaceId);
      if (input.kind === "channels")
        return {
          authorizeUrl: null,
          ...(yield* adapter.channels(access, input.workspaceId, input.cursor)),
        };
      if (input.projectId) {
        const found =
          yield* sql`SELECT project_id FROM projection_projects WHERE project_id=${input.projectId} AND deleted_at IS NULL`;
        if (!found.length) return yield* fail("invalid", "Choose an available project.");
      }
      const trackedChannels = yield* channels();
      if (
        trackedChannels.filter((channel) => !channel.discoveredAutomatically).length >= 50 &&
        !trackedChannels.some(
          (c) =>
            c.workspaceId === input.workspaceId &&
            c.channelId === input.channelId &&
            !c.discoveredAutomatically,
        )
      )
        return yield* fail("invalid", "You can configure up to 50 Slack channels.");
      const channel = yield* adapter.channel(access, input.workspaceId, input.channelId);
      const previous = trackedChannels.find(
        (c) => c.workspaceId === input.workspaceId && c.channelId === input.channelId,
      );
      const record: SlackChannelConfig = {
        ...previous,
        ...input,
        discoveredAutomatically: false,
        name: channel.name,
      };
      yield* sql`INSERT INTO slack_channels(workspace_id,channel_id,record_json) VALUES (${input.workspaceId},${input.channelId},${encodeChannel(record)}) ON CONFLICT(workspace_id,channel_id) DO UPDATE SET record_json=excluded.record_json`;
      return empty;
    },
    lock.withPermits(1),
    Effect.mapError(storageError),
    Effect.ensuring(notify),
  );
  const mutate = Effect.fn("SlackService.mutate")(
    function* (raw: SlackMutation) {
      const input = yield* decodeMutation(raw).pipe(
        Effect.mapError(() => fail("invalid", "Invalid Slack message request.")),
      );
      const config = yield* tracked(input);
      let remote = input.kind === "sync" || input.kind === "select" || input.kind === "thread";
      const perform = Effect.gen(function* () {
        const empty = { workItemId: null, hasMore: false };
        if (input.kind === "sync") {
          const current = yield* workspace(input.workspaceId);
          const result = yield* adapter.search(
            yield* token(input.workspaceId),
            config,
            input.page ?? 1,
          );
          yield* sql.withTransaction(
            Effect.gen(function* () {
              for (const rawMessage of result.messages) {
                const direct = (rawMessage.text ?? "").includes(`<@${current.userId}>`);
                const channelMention = /<!(?:channel|here|everyone)(?:\|[^>]*)?>/.test(
                  rawMessage.text ?? "",
                );
                if (!direct && !(config.channelMentions && channelMention)) continue;
                const at = DateTime.formatIso(yield* DateTime.now);
                const message: SlackMessage = {
                  ...messageSnapshot(config, rawMessage),
                  lastSyncedAt: at,
                  lastAttemptAt: at,
                  syncStatus: "ready",
                  syncError: null,
                };
                const previous = yield* get(message);
                yield* saveMessage(
                  previous
                    ? {
                        ...previous,
                        lastSyncedAt: message.lastSyncedAt!,
                        lastAttemptAt: message.lastAttemptAt!,
                        syncStatus: "ready",
                        syncError: null,
                        text: message.text,
                        author: message.author,
                        url: message.url ?? previous.url,
                      }
                    : message,
                );
                if (!previous)
                  yield* publish(
                    message,
                    direct ? "slack_mention_received" : "slack_project_mention_received",
                    config.projectId,
                  );
              }
            }),
          );
          yield* events.notifyChange;
          return { ...empty, hasMore: result.hasMore };
        }
        let message = yield* get(input);
        if (input.kind === "select") {
          const access = yield* token(input.workspaceId);
          const selected = yield* adapter.selected(
            access,
            input.workspaceId,
            input.channelId,
            input.ts,
          );
          const url = yield* adapter.permalink(
            access,
            input.workspaceId,
            input.channelId,
            input.ts,
          );
          yield* saveMessage(
            message
              ? { ...message, text: selected.text ?? message.text, url }
              : { ...messageSnapshot(config, selected), url },
          );
          return empty;
        }
        if (input.kind === "thread") {
          const access = yield* token(input.workspaceId);
          if (!message)
            return yield* fail("not_found", "Import this message into the inbox first.");
          const cursor = input.kind === "thread" && input.more ? (message?.nextCursor ?? "") : "";
          if (input.more && !cursor) {
            remote = false;
            return empty;
          }
          const result = yield* adapter.thread(
            access,
            input.workspaceId,
            input.channelId,
            message?.threadTs ?? input.ts,
            cursor,
          );
          const replies = [
            ...new Map(
              [
                ...(cursor ? message.replies : []),
                ...result.messages.map((m) => ({
                  ts: m.ts,
                  author: m.username ?? m.user ?? "Slack app",
                  text: (m.text ?? "").slice(0, 100_000),
                })),
              ].map((reply) => [reply.ts, reply]),
            ).values(),
          ];
          if (cursor && result.nextCursor === cursor)
            return yield* fail(
              "remote",
              "Slack repeated a pagination cursor. Refresh the thread before loading more.",
            );
          if (
            replies.length > 300 ||
            replies.reduce((size, reply) => size + reply.text.length, 0) > 100_000
          )
            return yield* fail(
              "invalid",
              "Thread preview has reached its size limit. Open Slack for the rest.",
            );
          const url =
            message.url ??
            (yield* adapter.permalink(access, input.workspaceId, input.channelId, input.ts));
          const selected = result.messages.find((reply) => reply.ts === message!.ts);
          yield* saveMessage({
            ...message,
            ...(selected
              ? {
                  text: (selected.text ?? "").slice(0, 100_000),
                  author: selected.username ?? selected.user ?? "Slack app",
                }
              : {}),
            threadTs: cursor
              ? message.threadTs
              : (result.messages[0]?.thread_ts ?? result.messages[0]?.ts ?? message.threadTs),
            url,
            replies: [...new Map(replies.map((r) => [r.ts, r])).values()],
            nextCursor: result.nextCursor,
          });
          return { ...empty, hasMore: !!result.nextCursor };
        }
        if (!message) return yield* fail("not_found", "This message is not in the Slack inbox.");
        if (input.kind === "ignore") {
          yield* saveMessage({ ...message, ignored: input.ignored });
          return empty;
        }
        const existing = yield* work.findByResource(slackResource(message));
        if (existing) {
          if (input.kind === "attach" && existing.id !== input.workItemId)
            return yield* fail(
              "invalid",
              "This Slack message is already attached to another task.",
            );
          if (input.kind === "import") {
            yield* publish(message, "slack_message_imported", existing.projectId, existing.id);
            yield* events.notifyChange;
          }
          return { ...empty, workItemId: existing.id };
        }
        if (input.kind === "attach") {
          const item = yield* work
            .mutate({
              kind: "attachResource",
              id: input.workItemId,
              expectedRevision: input.expectedRevision,
              commandId: `slack:attach:${input.workItemId}:${input.expectedRevision}:${input.workspaceId}:${input.channelId}:${input.ts}`,
              resource: slackResource(message),
            })
            .pipe(Effect.mapError((e) => fail("invalid", e.message)));
          return { ...empty, workItemId: item.id };
        }
        const id = yield* importMessage(config, message, input);
        return { ...empty, workItemId: id };
      });
      const result = yield* perform.pipe(Effect.result);
      if (remote) {
        const at = DateTime.formatIso(yield* DateTime.now);
        const problem = result._tag === "Failure" ? storageError(result.failure) : null;
        const metadata = {
          lastAttemptAt: at,
          syncStatus: problem
            ? problem.code === "not_found"
              ? ("unavailable" as const)
              : ("error" as const)
            : ("ready" as const),
          syncError: problem?.message ?? null,
          ...(!problem ? { lastSyncedAt: at } : {}),
        };
        if (input.kind === "sync") {
          const record = {
            ...config,
            ...metadata,
            ...(result._tag === "Success" && result.success.hasMore
              ? { syncStatus: "partial" as const }
              : {}),
          };
          yield* sql`UPDATE slack_channels SET record_json=${encodeChannel(record)} WHERE workspace_id=${config.workspaceId} AND channel_id=${config.channelId}`;
        } else {
          const cached = yield* get(input);
          if (cached) yield* saveMessage({ ...cached, ...metadata });
        }
        if (problem)
          yield* Effect.logWarning("Slack refresh failed; cached content retained").pipe(
            Effect.annotateLogs({
              workspaceId: config.workspaceId,
              channelId: config.channelId,
              operation: input.kind,
              code: problem.code,
            }),
          );
      }
      if (result._tag === "Failure") return yield* result.failure;
      return result.success;
    },
    lock.withPermits(1),
    Effect.mapError(storageError),
    Effect.ensuring(notify),
  );
  const syncWorkspace = Effect.fn("SlackService.syncWorkspace")(
    function* (id: string) {
      const current = (yield* workspaces()).find((workspace) => workspace.id === id);
      if (!current) return;
      const at = DateTime.formatIso(yield* DateTime.now);
      const result = yield* Effect.gen(function* () {
        const access = yield* token(id);
        const messages = yield* adapter.mentions(
          access,
          id,
          current.userId,
          current.lastSyncedAt ?? null,
        );
        yield* sql.withTransaction(
          Effect.gen(function* () {
            const configuredChannels = new Map(
              (yield* channels())
                .filter((channel) => channel.workspaceId === id)
                .map((channel) => [channel.channelId, channel]),
            );
            for (const raw of messages) {
              if (!(raw.text ?? "").includes(`<@${current.userId}>`)) continue;
              let channel = configuredChannels.get(raw.channel.id);
              if (!channel) {
                channel = {
                  workspaceId: id,
                  channelId: raw.channel.id,
                  name: raw.channel.name?.slice(0, 500) || raw.channel.id,
                  projectId: null,
                  repository: null,
                  channelMentions: false,
                  discoveredAutomatically: true,
                };
                yield* sql`INSERT INTO slack_channels(workspace_id,channel_id,record_json) VALUES (${id},${channel.channelId},${encodeChannel(channel)})`;
                configuredChannels.set(channel.channelId, channel);
              }
              const snapshot = messageSnapshot(channel, raw);
              const previous = yield* get(snapshot);
              const message: SlackMessage = {
                ...snapshot,
                replies: previous?.replies ?? [],
                nextCursor: previous?.nextCursor ?? "",
                ignored: previous?.ignored ?? false,
                url: snapshot.url ?? previous?.url ?? null,
                lastSyncedAt: at,
                lastAttemptAt: at,
                syncStatus: "ready",
                syncError: null,
              };
              if (previous)
                yield* work.refreshExternal(
                  slackResource(message),
                  taskContent(channel, previous),
                  taskContent(channel, message),
                );
              yield* saveMessage(message);
              if (message.ignored) continue;
              yield* importMessage(channel, message, {
                kind: "import",
                ...message,
                projectId: channel.projectId,
                repository: channel.repository,
                priority: "medium",
              });
            }
            const next: SlackWorkspace = {
              ...current,
              lastSyncedAt: at,
              lastAttemptAt: at,
              syncStatus: "ready",
              syncError: null,
            };
            yield* sql`UPDATE slack_workspaces SET record_json=${encodeWorkspace(next)} WHERE id=${id}`;
          }),
        );
      }).pipe(
        Effect.timeout("2 minutes"),
        Effect.catchTag("TimeoutError", () =>
          Effect.fail(fail("unavailable", "Slack sync timed out. It will retry automatically.")),
        ),
        Effect.result,
      );
      if (result._tag === "Failure") {
        const problem = storageError(result.failure);
        const next: SlackWorkspace = {
          ...current,
          lastAttemptAt: at,
          syncStatus: "error",
          syncError: problem.message,
        };
        yield* sql`UPDATE slack_workspaces SET record_json=${encodeWorkspace(next)} WHERE id=${id}`;
        return yield* problem;
      }
    },
    lock.withPermits(1),
    Effect.mapError(storageError),
    Effect.ensuring(notify),
    Effect.ensuring(work.notifyChange),
    Effect.ensuring(events.notifyChange),
  );
  const syncAll = Effect.gen(function* () {
    for (const workspace of yield* workspaces())
      yield* syncWorkspace(workspace.id).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Automatic Slack task sync failed").pipe(
            Effect.annotateLogs({ workspaceId: workspace.id, code: error.code }),
          ),
        ),
      );
  }).pipe(Effect.catch(() => Effect.logWarning("Could not read connected Slack workspaces.")));
  const start = Effect.fn("SlackService.start")(function* () {
    const worker = yield* makeDrainableWorker(() => syncAll);
    // Connection receipts trigger the first sync; the timer continues without clients or automation rules.
    yield* forkParked(
      Stream.runForEach(SubscriptionRef.changes(connections), () => worker.enqueue(undefined)),
    );
    yield* forkParked(
      Effect.sleep("5 minutes").pipe(
        Effect.andThen(worker.enqueue(undefined)),
        Effect.andThen(worker.drain),
        Effect.forever,
      ),
    );
    return { drain: worker.drain };
  });
  const list = Effect.fn("SlackService.list")(
    function* (raw: SlackListInput) {
      const input = yield* decodeList(raw).pipe(
        Effect.mapError(() => fail("invalid", "Invalid Slack inbox filter.")),
      );
      const where = sql.and([
        sql`ignored=${input.ignored ? 1 : 0}`,
        sql`NOT EXISTS (SELECT 1 FROM slack_channels c WHERE c.workspace_id=slack_messages.workspace_id AND c.channel_id=slack_messages.channel_id AND json_extract(c.record_json, '$.discoveredAutomatically')=1)`,
        ...(input.workspaceId ? [sql`workspace_id=${input.workspaceId}`] : []),
      ]);
      const rows = yield* sql<{
        record_json: string;
      }>`SELECT json_set(record_json, '$.text', substr(json_extract(record_json, '$.text'), 1, 4000), '$.replies', json('[]')) AS record_json FROM slack_messages WHERE ${where} ORDER BY ts DESC,workspace_id,channel_id LIMIT ${input.limit ?? 50} OFFSET ${input.offset ?? 0}`;
      const count = yield* sql<{
        total: number;
      }>`SELECT count(*) AS total FROM slack_messages WHERE ${where}`;
      const items = yield* Effect.forEach(rows, (row) =>
        Effect.gen(function* () {
          const message = yield* decodeMessage(row.record_json);
          const item = yield* work.findByResource(slackResource(message));
          return {
            ...message,
            text: message.text.slice(0, 4000),
            replies: [],
            workItemId: item?.id ?? null,
          };
        }),
      );
      return {
        configured,
        workspaces: yield* workspaces(),
        channels: (yield* channels()).filter((channel) => !channel.discoveredAutomatically),
        items,
        total: count[0]?.total ?? 0,
      };
    },
    sql.withTransaction,
    Effect.mapError(storageError),
  );
  const read = Effect.fn("SlackService.read")(function* (ref: SlackReference) {
    yield* tracked(ref);
    const message = yield* get(ref);
    if (!message) return yield* fail("not_found", "This message is not in the Slack inbox.");
    return message;
  }, Effect.mapError(storageError));
  const prepareReply = Effect.fn("SlackService.prepareReply")(
    function* (ref: SlackReference) {
      const connected = yield* workspace(ref.workspaceId);
      if (!connected.scopes.includes("chat:write"))
        return yield* fail(
          "authentication",
          "Reconnect Slack with the chat:write user scope to post replies.",
        );
      const message = yield* read(ref);
      const accessToken = yield* token(ref.workspaceId);
      // Resolve the parent from the saved message, including when the task came from a reply.
      return (body: string, commandId: string) =>
        adapter.reply(
          accessToken,
          ref.workspaceId,
          ref.channelId,
          message.threadTs,
          body,
          commandId,
        );
    },
    lock.withPermits(1),
    Effect.mapError(storageError),
  );
  return {
    prepareReply,
    start,
    syncWorkspace,
    completeOAuth,
    read,
    admin,
    mutate,
    list,
    subscribe: (input: SlackListInput) =>
      Stream.merge(SubscriptionRef.changes(changes), work.changes).pipe(
        Stream.mapEffect(() => list(input)),
      ),
  };
});
export class SlackService extends Context.Service<SlackService, Effect.Success<typeof make>>()(
  "t3/integrations/slack/SlackService",
) {}
