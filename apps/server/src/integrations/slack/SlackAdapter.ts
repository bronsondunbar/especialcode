import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import {
  SlackError,
  SlackId,
  SlackTimestamp,
  type SlackChannelConfig,
  type SlackMessage,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const fail = (code: SlackError["code"], message: string) =>
  new SlackError({ code, message });
const RawMessage = Schema.Struct({
  ts: SlackTimestamp,
  text: Schema.optionalKey(Schema.String),
  user: Schema.optionalKey(Schema.String),
  username: Schema.optionalKey(Schema.String),
  thread_ts: Schema.optionalKey(SlackTimestamp),
  permalink: Schema.optionalKey(Schema.String),
});
const Response = Schema.Struct({ ok: Schema.Boolean, error: Schema.optionalKey(Schema.String) });
const decodeResponse = Schema.decodeUnknownEffect(Response);
const decodeSearch = Schema.decodeUnknownEffect(
  Schema.Struct({
    messages: Schema.Struct({
      matches: Schema.Array(
        Schema.Struct({
          ...RawMessage.fields,
          channel: Schema.Struct({ id: SlackId, name: Schema.optionalKey(Schema.String) }),
        }),
      ),
      paging: Schema.Struct({ page: Schema.Number, pages: Schema.Number }),
    }),
  }),
);
const decodeThread = Schema.decodeUnknownEffect(
  Schema.Struct({
    messages: Schema.Array(RawMessage),
    response_metadata: Schema.optionalKey(
      Schema.Struct({ next_cursor: Schema.optionalKey(Schema.String) }),
    ),
  }),
);
const decodeChannels = Schema.decodeUnknownEffect(
  Schema.Struct({
    channels: Schema.Array(Schema.Struct({ id: SlackId, name: Schema.String })),
    response_metadata: Schema.optionalKey(
      Schema.Struct({ next_cursor: Schema.optionalKey(Schema.String) }),
    ),
  }),
);
const decodeInfo = Schema.decodeUnknownEffect(
  Schema.Struct({ channel: Schema.Struct({ id: SlackId, name: Schema.String }) }),
);
const decodePostedMessage = Schema.decodeUnknownEffect(Schema.Struct({ ts: SlackTimestamp }));
const decodeLink = Schema.decodeUnknownEffect(Schema.Struct({ permalink: Schema.String }));
export const OAuthToken = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optionalKey(Schema.String),
  expires_in: Schema.optionalKey(Schema.Number),
  scope: Schema.String,
});
const decodeOAuth = Schema.decodeUnknownEffect(
  Schema.Struct({
    team: Schema.Struct({ id: SlackId, name: Schema.String }),
    authed_user: Schema.Struct({ ...OAuthToken.fields, id: SlackId }),
  }),
);
const decodeRotation = Schema.decodeUnknownEffect(OAuthToken);
const isSlackError = Schema.is(SlackError);
const apiError = (error: unknown) =>
  isSlackError(error)
    ? error
    : fail("remote", "Slack returned an unexpected response. Please retry.");
export const make = Effect.gen(function* () {
  const http = yield* HttpClient.HttpClient;
  const limits = new Map<string, number>();
  const request = Effect.fn("SlackAdapter.request")(function* (
    method: string,
    token: string | null,
    workspaceId: string,
    params: Record<string, string>,
    clientAuth?: { id: string; secret: string },
  ) {
    const key = `${workspaceId}:${method}`;
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    if ((limits.get(key) ?? 0) > now)
      return yield* fail(
        "rate_limit",
        "Slack is rate limiting this method. Retry after the cooldown.",
      );
    const raw = yield* Effect.gen(function* () {
      const base = HttpClientRequest.post(`https://slack.com/api/${method}`).pipe(
        HttpClientRequest.bodyUrlParams(params),
      );
      const request = clientAuth
        ? base.pipe(HttpClientRequest.basicAuth(clientAuth.id, clientAuth.secret))
        : token
          ? base.pipe(HttpClientRequest.bearerToken(token))
          : base;
      const response = yield* http.execute(request).pipe(
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
        Effect.retry({
          times:
            method === "oauth.v2.access" ||
            method === "auth.revoke" ||
            method === "chat.postMessage"
              ? 0
              : 1,
        }),
        Effect.mapError(() => fail("unavailable", "Could not reach Slack. Please retry.")),
      );
      if (response.status === 429) {
        const seconds = Number(response.headers["retry-after"]);
        const wait = Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 86400) : 60;
        limits.set(key, now + wait * 1000);
        return yield* fail(
          "rate_limit",
          `Slack is rate limiting this method. Retry in ${Math.ceil(wait)} seconds.`,
        );
      }
      if (response.status === 401 || response.status === 403)
        return yield* fail("authentication", "Reconnect Slack and grant the required permissions.");
      if (response.status < 200 || response.status >= 300)
        return yield* fail("remote", "Slack is temporarily unavailable.");
      return yield* response.json.pipe(Effect.mapError(apiError));
    }).pipe(Effect.timeout("30 seconds"), Effect.mapError(apiError));
    const status = yield* decodeResponse(raw).pipe(Effect.mapError(apiError));
    if (!status.ok) {
      if (
        [
          "invalid_auth",
          "token_revoked",
          "token_expired",
          "missing_scope",
          "not_authed",
          "invalid_refresh_token",
        ].includes(status.error ?? "")
      )
        return yield* fail("authentication", "Reconnect Slack and grant the required permissions.");
      if (
        ["channel_not_found", "thread_not_found", "message_not_found", "not_in_channel"].includes(
          status.error ?? "",
        )
      )
        return yield* fail(
          "not_found",
          "This Slack conversation is unavailable to the connected account.",
        );
      if (status.error === "ratelimited") {
        limits.set(key, now + 60_000);
        return yield* fail(
          "rate_limit",
          "Slack is rate limiting this method. Retry in 60 seconds.",
        );
      }
      return yield* fail("remote", "Slack could not complete this request.");
    }
    return raw;
  });
  const oauth = Effect.fn("SlackAdapter.oauth")(function* (
    clientId: string,
    clientSecret: string,
    redirectUri: string,
    code: string,
  ) {
    return yield* request(
      "oauth.v2.access",
      null,
      "oauth",
      {
        redirect_uri: redirectUri,
        code,
      },
      { id: clientId, secret: clientSecret },
    ).pipe(Effect.flatMap(decodeOAuth), Effect.mapError(apiError));
  });
  const refresh = Effect.fn("SlackAdapter.refresh")(function* (
    clientId: string,
    clientSecret: string,
    refreshToken: string,
  ) {
    return yield* request(
      "oauth.v2.access",
      null,
      "oauth",
      {
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      },
      { id: clientId, secret: clientSecret },
    ).pipe(Effect.flatMap(decodeRotation), Effect.mapError(apiError));
  });
  const channels = Effect.fn("SlackAdapter.channels")(function* (
    token: string,
    workspaceId: string,
    cursor = "",
  ) {
    const result = yield* request("conversations.list", token, workspaceId, {
      types: "public_channel,private_channel",
      exclude_archived: "true",
      limit: "100",
      cursor,
    }).pipe(Effect.flatMap(decodeChannels), Effect.mapError(apiError));
    return { channels: result.channels, nextCursor: result.response_metadata?.next_cursor ?? "" };
  });
  const channel = Effect.fn("SlackAdapter.channel")(function* (
    token: string,
    workspaceId: string,
    id: string,
  ) {
    return (yield* request("conversations.info", token, workspaceId, { channel: id }).pipe(
      Effect.flatMap(decodeInfo),
      Effect.mapError(apiError),
    )).channel;
  });
  const search = Effect.fn("SlackAdapter.search")(function* (
    token: string,
    config: SlackChannelConfig,
    page: number,
  ) {
    // Slack search includes thread replies. Search only one allowlisted channel and a bounded recent window.
    const after = DateTime.formatIsoDate(DateTime.subtract(yield* DateTime.now, { days: 7 }));
    const result = yield* request("search.messages", token, config.workspaceId, {
      query: `in:${config.channelId} after:${after}`,
      sort: "timestamp",
      sort_dir: "desc",
      count: "100",
      page: String(page),
      highlight: "false",
    }).pipe(Effect.flatMap(decodeSearch), Effect.mapError(apiError));
    return {
      messages: result.messages.matches.filter((m) => m.channel.id === config.channelId),
      hasMore: result.messages.paging.page < result.messages.paging.pages,
    };
  });
  const mentions = Effect.fn("SlackAdapter.mentions")(function* (
    token: string,
    workspaceId: string,
    userId: string,
    since: string | null,
  ) {
    const now = yield* DateTime.now;
    const recent = DateTime.subtract(now, { days: 7 });
    const start = since
      ? DateTime.makeUnsafe(
          Math.min(
            DateTime.toEpochMillis(recent),
            DateTime.toEpochMillis(DateTime.subtract(DateTime.makeUnsafe(since), { days: 1 })),
          ),
        )
      : recent;
    const after = DateTime.formatIsoDate(start);
    const snapshots: Array<typeof RawMessage.Type & { channel: { id: string; name?: string } }> =
      [];
    let bytes = 0;
    const seen = new Set<string>();
    for (let page = 1; page <= 100; page++) {
      const result = yield* request("search.messages", token, workspaceId, {
        query: `<@${userId}> after:${after}`,
        team_id: workspaceId,
        sort: "timestamp",
        sort_dir: "asc",
        count: "100",
        page: String(page),
        highlight: "false",
      }).pipe(Effect.flatMap(decodeSearch), Effect.mapError(apiError));
      if (result.messages.paging.page !== page)
        return yield* fail(
          "remote",
          "Slack repeated a search page. The saved sync cursor was retained.",
        );
      for (const message of result.messages.matches) {
        bytes += (message.text ?? "").length * 4;
        if (bytes > 32 * 1024 * 1024)
          return yield* fail("remote", "Slack mentions exceed the 32 MB sync limit.");
        const key = `${message.channel.id}/${message.ts}`;
        if (seen.has(key) || !(message.text ?? "").includes(`<@${userId}>`)) continue;
        seen.add(key);
        snapshots.push(message);
      }
      if (page >= result.messages.paging.pages) return snapshots;
    }
    return yield* fail(
      "remote",
      "Slack mentions exceed 10,000 results. The saved sync cursor was retained.",
    );
  });
  const thread = Effect.fn("SlackAdapter.thread")(function* (
    token: string,
    workspaceId: string,
    channelId: string,
    ts: string,
    cursor = "",
  ) {
    const result = yield* request("conversations.replies", token, workspaceId, {
      channel: channelId,
      ts,
      cursor,
      limit: "15",
    }).pipe(Effect.flatMap(decodeThread), Effect.mapError(apiError));
    return { messages: result.messages, nextCursor: result.response_metadata?.next_cursor ?? "" };
  });
  const selected = Effect.fn("SlackAdapter.selected")(function* (
    token: string,
    workspaceId: string,
    channelId: string,
    ts: string,
  ) {
    const result = yield* request("conversations.replies", token, workspaceId, {
      channel: channelId,
      ts,
      oldest: ts,
      latest: ts,
      inclusive: "true",
      limit: "15",
    }).pipe(Effect.flatMap(decodeThread), Effect.mapError(apiError));
    const message = result.messages.find((m) => m.ts === ts);
    if (!message) return yield* fail("not_found", "This Slack message is unavailable.");
    return message;
  });
  const permalink = Effect.fn("SlackAdapter.permalink")(function* (
    token: string,
    workspaceId: string,
    channelId: string,
    ts: string,
  ) {
    return (yield* request("chat.getPermalink", token, workspaceId, {
      channel: channelId,
      message_ts: ts,
    }).pipe(Effect.flatMap(decodeLink), Effect.mapError(apiError))).permalink;
  });
  const reply = Effect.fn("SlackAdapter.reply")(function* (
    token: string,
    workspaceId: string,
    channelId: string,
    threadTs: string,
    text: string,
    commandId: string,
  ) {
    const result = yield* request("chat.postMessage", token, workspaceId, {
      channel: channelId,
      thread_ts: threadTs,
      text,
      client_msg_id: commandId,
      reply_broadcast: "false",
      unfurl_links: "false",
      unfurl_media: "false",
      parse: "none",
    }).pipe(Effect.flatMap(decodePostedMessage), Effect.mapError(apiError));
    return {
      url: `https://app.slack.com/client/${workspaceId}/${channelId}/thread/${channelId}-${threadTs}?message_ts=${result.ts}`,
    };
  });
  const revoke = (token: string, workspaceId: string) =>
    request("auth.revoke", token, workspaceId, {}).pipe(Effect.asVoid);
  return {
    oauth,
    refresh,
    channels,
    channel,
    search,
    mentions,
    thread,
    selected,
    permalink,
    revoke,
    reply,
  };
});
export type RawSlackMessage = typeof RawMessage.Type;
export function messageSnapshot(config: SlackChannelConfig, raw: RawSlackMessage): SlackMessage {
  const link =
    raw.permalink && /^https:\/\/[^/]+\.slack\.com\//.test(raw.permalink) ? raw.permalink : null;
  return {
    workspaceId: config.workspaceId,
    channelId: config.channelId,
    ts: raw.ts,
    threadTs: raw.thread_ts ?? raw.ts,
    author: raw.username ?? raw.user ?? "Slack app",
    text: (raw.text ?? "").slice(0, 100_000),
    url: link,
    replies: [],
    nextCursor: "",
    ignored: false,
  };
}
export class SlackAdapter extends Context.Service<SlackAdapter, Effect.Success<typeof make>>()(
  "t3/integrations/slack/SlackAdapter",
) {}
