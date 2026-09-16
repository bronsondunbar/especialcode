import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse, type HttpClientRequest } from "effect/unstable/http";
import { make } from "./VercelAdapter.ts";
const credentials = { token: "private-token", teamId: "team_123" };
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
it.effect(
  "reads the exact project and branch with server credentials and tolerates pending URLs",
  () =>
    Effect.gen(function* () {
      const { requests, adapter } = harness(() =>
        Response.json({
          deployments: [
            { uid: "dpl_old", name: "app", created: 1, state: "BUILDING", url: null },
            {
              uid: "dpl_new",
              name: "app",
              created: 2,
              readyState: "READY",
              url: "app-abc.vercel.app",
              meta: { githubCommitSha: "abc123" },
            },
          ],
        }),
      );
      const result = yield* (yield* adapter).deployments(
        credentials,
        "prj_123",
        "codex/fix search",
      );
      assert.deepEqual(
        result.map((row) => [row.id, row.state, row.url]),
        [
          ["dpl_new", "READY", "https://app-abc.vercel.app"],
          ["dpl_old", "BUILDING", null],
        ],
      );
      const request = requests[0]!;
      const url = new URL(request.url);
      assert.strictEqual(url.origin + url.pathname, "https://api.vercel.com/v7/deployments");
      assert.strictEqual(url.searchParams.get("branch"), "codex/fix search");
      assert.strictEqual(url.searchParams.get("projectId"), "prj_123");
      assert.strictEqual(url.searchParams.get("teamId"), "team_123");
      assert.strictEqual(url.searchParams.get("limit"), "20");
      assert.strictEqual(request.headers.authorization, "Bearer private-token");
      assert.strictEqual(request.method, "GET");
      assert.isFalse(request.url.includes(credentials.token));
    }),
);
it.effect("validates projects and excludes unsafe deployment URLs", () =>
  Effect.gen(function* () {
    const { adapter } = harness((request) =>
      request.url.includes("/projects/")
        ? Response.json({ id: "prj_123", name: "app" })
        : Response.json({
            deployments: [{ uid: "dpl_1", name: "app", created: 1, url: "javascript:alert(1)" }],
          }),
    );
    const api = yield* adapter;
    assert.deepEqual(yield* api.project(credentials, "app"), { id: "prj_123", name: "app" });
    assert.isNull((yield* api.deployments(credentials, "prj_123", null))[0]!.url);
  }),
);
it.effect("loads chronological build logs without streaming and bounds output", () =>
  Effect.gen(function* () {
    const { requests, adapter } = harness(() =>
      Response.json([
        { created: 2, type: "stdout", payload: { text: "last" } },
        { created: 1, type: "stdout", payload: { text: "x".repeat(65_000) } },
      ]),
    );
    const logs = yield* (yield* adapter).logs(credentials, "dpl_1");
    assert.strictEqual(logs.text.length, 64_000);
    assert.isTrue(logs.text.endsWith("\nlast"));
    assert.isTrue(logs.truncated);
    const url = new URL(requests[0]!.url);
    assert.strictEqual(url.pathname, "/v3/deployments/dpl_1/events");
    assert.strictEqual(url.searchParams.get("builds"), "1");
    assert.strictEqual(url.searchParams.get("follow"), "0");
    assert.strictEqual(url.searchParams.get("direction"), "backward");
  }),
);
it.effect("accepts absent logs and rejects oversized responses", () =>
  Effect.gen(function* () {
    const empty = yield* harness(() => Response.json(null)).adapter;
    assert.deepEqual(yield* empty.logs(credentials, "dpl_1"), { text: "", truncated: false });
    const large = yield* harness(() => new Response("x".repeat(2_000_001))).adapter;
    assert.include(
      (yield* large.logs(credentials, "dpl_1").pipe(Effect.flip)).message,
      "preview limit",
    );
  }),
);
it.effect("sanitizes remote failures and respects Retry-After across automatic refreshes", () =>
  Effect.gen(function* () {
    const { requests, adapter } = harness(
      () =>
        new Response("private-token upstream debug", {
          status: 429,
          headers: { "Retry-After": "120" },
        }),
    );
    const api = yield* adapter;
    const error = yield* api.project(credentials, "app").pipe(Effect.flip);
    assert.notInclude(error.message, "private-token");
    yield* api.project(credentials, "app").pipe(Effect.flip);
    assert.strictEqual(requests.length, 1);
    yield* TestClock.adjust("120 seconds");
    yield* api.project(credentials, "app").pipe(Effect.flip);
    assert.strictEqual(requests.length, 2);
    const denied = yield* harness(() => new Response("private-token", { status: 403 })).adapter;
    assert.include(
      (yield* denied.project(credentials, "app").pipe(Effect.flip)).message,
      "access was denied",
    );
  }),
);

it.effect(
  "searches Vercel projects within the connected team and strips private project details",
  () =>
    Effect.gen(function* () {
      const { requests, adapter } = harness(() =>
        Response.json([{ id: "prj_app", name: "app", env: [{ value: "private-env" }] }]),
      );
      assert.deepEqual(yield* (yield* adapter).projects(credentials, "app"), [
        { id: "prj_app", name: "app" },
      ]);
      const url = new URL(requests[0]!.url);
      assert.strictEqual(url.pathname, "/v10/projects");
      assert.strictEqual(url.searchParams.get("teamId"), "team_123");
      assert.strictEqual(url.searchParams.get("search"), "app");
      assert.strictEqual(url.searchParams.get("limit"), "20");
    }),
);
