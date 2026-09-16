import * as TestClock from "effect/testing/TestClock";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { SlackError } from "@t3tools/contracts";
const encodeError = Schema.encodeSync(Schema.fromJsonString(SlackError));
import {
  HttpClient,
  HttpClientResponse,
  HttpClientError,
  type HttpClientRequest,
} from "effect/unstable/http";
import { make } from "./SlackAdapter.ts";
const config = {
  workspaceId: "T123",
  channelId: "C123",
  name: "dev",
  projectId: null,
  repository: null,
  channelMentions: true,
};
function harness(respond: (request: HttpClientRequest.HttpClientRequest) => Response) {
  const requests: Array<HttpClientRequest.HttpClientRequest> = [];
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      requests.push(request);
      return HttpClientResponse.fromWeb(request, respond(request));
    }),
  );
  return { requests, adapter: make.pipe(Effect.provideService(HttpClient.HttpClient, http)) };
}
function form(request: HttpClientRequest.HttpClientRequest) {
  assert.strictEqual(request.body._tag, "Uint8Array");
  return new URLSearchParams(
    request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "",
  );
}
it.effect("searches one channel, preserves paging, and rejects messages outside that channel", () =>
  Effect.gen(function* () {
    const { requests, adapter } = harness(() =>
      Response.json({
        ok: true,
        messages: {
          matches: [
            {
              channel: { id: "C123" },
              ts: "1760000000.000001",
              text: "<@U123> help",
              user: "U456",
            },
            { channel: { id: "C999" }, ts: "1760000000.000002", text: "private", user: "U456" },
          ],
          paging: { page: 2, pages: 3 },
        },
      }),
    );
    const slack = yield* adapter;
    const result = yield* slack.search("private-token", config, 2);
    assert.strictEqual(result.messages.length, 1);
    assert.isTrue(result.hasMore);
    const request = requests[0]!;
    assert.strictEqual(request.url, "https://slack.com/api/search.messages");
    assert.strictEqual(request.headers.authorization, "Bearer private-token");
    const params = form(request);
    assert.match(params.get("query")!, /^in:C123 after:\d{4}-\d{2}-\d{2}$/);
    assert.strictEqual(params.get("page"), "2");
    assert.strictEqual(params.get("count"), "100");
    assert.isFalse(params.toString().includes("private-token"));
  }),
);
it.effect("honors Retry-After without retrying and scopes cooldowns to workspace and method", () =>
  Effect.gen(function* () {
    const { requests, adapter } = harness((request) =>
      request.url.endsWith("search.messages") && requests.length === 1
        ? new Response("", { status: 429, headers: { "Retry-After": "120" } })
        : Response.json({
            ok: true,
            channels: [],
            messages: { matches: [], paging: { page: 1, pages: 1 } },
          }),
    );
    const slack = yield* adapter;
    assert.strictEqual(
      (yield* slack.search("token", config, 1).pipe(Effect.flip)).code,
      "rate_limit",
    );
    assert.strictEqual(
      (yield* slack.search("token", config, 1).pipe(Effect.flip)).code,
      "rate_limit",
    );
    assert.strictEqual(requests.length, 1);
    yield* slack.channels("token", "T123");
    yield* slack.search("token", { ...config, workspaceId: "T999" }, 1);
    assert.strictEqual(requests.length, 3);
  }),
);
it.effect("uses HTTP Basic client authentication and redacts upstream failures", () =>
  Effect.gen(function* () {
    const { requests, adapter } = harness(() =>
      Response.json({ ok: false, error: "secret=private-client-secret" }),
    );
    const slack = yield* adapter;
    const error = yield* slack
      .oauth("client-id", "private-client-secret", "https://example.test/callback", "private-code")
      .pipe(Effect.flip);
    assert.isFalse(encodeError(error).includes("private-client-secret"));
    const request = requests[0]!;
    assert.strictEqual(request.url, "https://slack.com/api/oauth.v2.access");
    const params = form(request);
    assert.strictEqual(params.get("client_secret"), null);
    assert.strictEqual(params.get("client_id"), null);
    assert.strictEqual(
      request.headers.authorization,
      `Basic ${btoa("client-id:private-client-secret")}`,
    );
    assert.strictEqual(params.get("code"), "private-code");
    assert.strictEqual(params.get("redirect_uri"), "https://example.test/callback");
  }),
);
it.effect(
  "reports missing permissions as reconnectable auth errors and validates remote schemas",
  () =>
    Effect.gen(function* () {
      const denied = yield* harness(() => Response.json({ ok: false, error: "missing_scope" }))
        .adapter;
      assert.strictEqual(
        (yield* denied.channels("token", "T123").pipe(Effect.flip)).code,
        "authentication",
      );
      const malformed = yield* harness(() =>
        Response.json({ ok: true, channels: [{ id: "../../secrets", name: "bad" }] }),
      ).adapter;
      assert.strictEqual(
        (yield* malformed.channels("token", "T123").pipe(Effect.flip)).code,
        "remote",
      );
    }),
);
it.effect("loads selected messages and thread pages with bounded conversation requests", () =>
  Effect.gen(function* () {
    const { requests, adapter } = harness(() =>
      Response.json({
        ok: true,
        messages: [
          {
            ts: "1760000000.000001",
            thread_ts: "1760000000.000000",
            user: "U123",
            text: "Selected reply",
          },
        ],
        response_metadata: { next_cursor: "next" },
      }),
    );
    const slack = yield* adapter;
    const selected = yield* slack.selected("token", "T123", "C123", "1760000000.000001");
    assert.strictEqual(selected.thread_ts, "1760000000.000000");
    const params = form(requests[0]!);
    assert.strictEqual(params.get("oldest"), selected.ts);
    assert.strictEqual(params.get("latest"), selected.ts);
    assert.strictEqual(params.get("inclusive"), "true");
    const thread = yield* slack.thread("token", "T123", "C123", selected.thread_ts!, "cursor");
    assert.strictEqual(thread.nextCursor, "next");
    assert.strictEqual(form(requests[1]!).get("limit"), "15");
    assert.strictEqual(form(requests[1]!).get("cursor"), "cursor");
  }),
);

it.effect("classifies HTTP authentication failures without exposing the response body", () =>
  Effect.gen(function* () {
    for (const status of [401, 403]) {
      const ctx = harness(() => new Response("private-token", { status }));
      const adapter = yield* ctx.adapter;
      const error = yield* adapter.channels("private-token", "T123").pipe(Effect.flip);
      assert.strictEqual(error.code, "authentication");
      assert.notInclude(error.message, "private-token");
      assert.strictEqual(ctx.requests.length, 1);
    }
  }),
);
it.effect("retries read transport failures but never retries rotation or message posting", () =>
  Effect.gen(function* () {
    let attempts = 0;
    const http = HttpClient.make((request) =>
      Effect.suspend(() => {
        attempts++;
        if (attempts === 2)
          return Effect.succeed(
            HttpClientResponse.fromWeb(request, Response.json({ ok: true, channels: [] })),
          );
        return Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request, cause: new Error("offline") }),
          }),
        );
      }),
    );
    const adapter = yield* make.pipe(Effect.provideService(HttpClient.HttpClient, http));
    assert.deepEqual((yield* adapter.channels("token", "T123")).channels, []);
    assert.strictEqual(attempts, 2);
    yield* adapter.refresh("id", "secret", "refresh").pipe(Effect.flip);
    assert.strictEqual(attempts, 3);
    yield* adapter
      .reply("token", "T123", "C123", "1760000000.000000", "Reviewed update", "post")
      .pipe(Effect.flip);
    assert.strictEqual(attempts, 4);
  }),
);

it.effect(
  "discovers direct mentions across channels and thread replies with complete pagination",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-01-01T00:00:00Z"));
      const { requests, adapter } = harness((request) => {
        const page = Number(form(request).get("page"));
        return Response.json({
          ok: true,
          messages: {
            matches:
              page === 1
                ? [
                    {
                      channel: { id: "CONE", name: "one" },
                      ts: "1760000000.000001",
                      text: "<@U123> help",
                    },
                    {
                      channel: { id: "CTWO" },
                      ts: "1760000000.000002",
                      text: "<@U999> other user",
                    },
                  ]
                : [
                    {
                      channel: { id: "CTWO" },
                      ts: "1760000000.000003",
                      text: "<@U123> reply",
                      thread_ts: "1760000000.000000",
                    },
                  ],
            paging: { page, pages: 2 },
          },
        });
      });
      const slack = yield* adapter;
      const result = yield* slack.mentions("token", "T123", "U123", "2020-01-01T00:00:00Z");
      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[1]?.thread_ts, "1760000000.000000");
      assert.strictEqual(form(requests[0]!).get("query"), "<@U123> after:2019-12-31");
      assert.strictEqual(form(requests[0]!).get("team_id"), "T123");
      assert.strictEqual(form(requests[1]!).get("page"), "2");
    }),
);

it.effect("does not return partial mentions when a later page fails or repeats", () =>
  Effect.gen(function* () {
    let repeated = false;
    const { adapter } = harness((request) => {
      const page = Number(form(request).get("page"));
      return page === 2 && !repeated
        ? new Response("", { status: 500 })
        : Response.json({
            ok: true,
            messages: {
              matches: [{ channel: { id: "CONE" }, ts: "1760000000.000001", text: "<@U123> help" }],
              paging: { page: 1, pages: 2 },
            },
          });
    });
    const slack = yield* adapter;
    assert.strictEqual(
      (yield* slack.mentions("token", "T123", "U123", null).pipe(Effect.flip)).code,
      "remote",
    );
    repeated = true;
    assert.strictEqual(
      (yield* slack.mentions("token", "T123", "U123", null).pipe(Effect.flip)).code,
      "remote",
    );
  }),
);

it.effect("posts reviewed text as a reply without broadcasting or unfurling", () =>
  Effect.gen(function* () {
    const { requests, adapter } = harness(() =>
      Response.json({ ok: true, ts: "1760000000.000002" }),
    );
    const slack = yield* adapter;
    yield* slack.reply(
      "private-token",
      "T123",
      "C123",
      "1760000000.000000",
      "Reviewed update",
      "request-id",
    );
    assert.strictEqual(requests.length, 1);
    assert.isTrue(requests[0]!.url.endsWith("chat.postMessage"));
    const params = form(requests[0]!);
    assert.strictEqual(params.get("thread_ts"), "1760000000.000000");
    assert.strictEqual(params.get("text"), "Reviewed update");
    assert.strictEqual(params.get("reply_broadcast"), "false");
    assert.strictEqual(params.get("unfurl_links"), "false");
  }),
);
