import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/unstable/http";
import * as Option from "effect/Option";
import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import { assert, it, afterEach, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as GitHubCli from "../../sourceControl/GitHubCli.ts";
import * as RateLimit from "../../sourceControl/SourceControlRateLimit.ts";
import { make } from "./GitHubIssuesAdapter.ts";
const repo = { host: "github.com", repository: "owner/repo" };
const rawIssue = {
  id: 9001,
  number: 42,
  title: "Issue",
  body: null,
  html_url: "https://github.com/owner/repo/issues/42",
  state: "open",
  updated_at: "2026-01-01T00:00:00Z",
  labels: ["ready", { name: "bug" }],
  assignees: [{ login: "alice" }],
  milestone: { title: "v1" },
};
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const output = (value: unknown) => ({
  stdout: encodeJson(value),
  stderr: "",
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdoutTruncated: false,
  stderrTruncated: false,
});
const execute = vi.fn<GitHubCli.GitHubCli["Service"]["execute"]>();
const layer = Layer.mergeAll(
  Layer.mock(GitHubCli.GitHubCli)({ execute }),
  RateLimit.layer,
  FetchHttpClient.layer,
  Layer.mock(ServerSecretStore)({ get: () => Effect.succeed(Option.none()) }),
);
afterEach(() => execute.mockReset());

it.effect(
  "paginates open issues, excludes pull requests and uses all states for incremental sync",
  () =>
    Effect.gen(function* () {
      const page = Array.from({ length: 100 }, (_, index) => ({
        ...rawIssue,
        id: index + 1,
        number: index + 1,
        ...(index === 0 ? { pull_request: {} } : {}),
      }));
      execute
        .mockReturnValueOnce(Effect.succeed(output(page)))
        .mockReturnValueOnce(Effect.succeed(output([rawIssue])))
        .mockReturnValueOnce(Effect.succeed(output([])));
      const adapter = yield* make;
      const result = yield* adapter.list(repo, null);
      assert.strictEqual(result.length, 100);
      assert.strictEqual(result.at(-1)?.externalId, "9001");
      assert.deepEqual(result.at(-1)?.labels, ["ready", "bug"]);
      assert.strictEqual(result.at(-1)?.body, "");
      assert.include(execute.mock.calls[0]![0].args, "--hostname");
      assert.include(execute.mock.calls[0]![0].args, "github.com");
      assert.isTrue(execute.mock.calls[0]![0].args.some((arg) => arg.includes("state=open")));
      assert.isTrue(execute.mock.calls[1]![0].args.some((arg) => arg.includes("page=2")));
      yield* adapter.list(repo, "2026-01-01T00:00:00Z");
      assert.isTrue(
        execute.mock.calls[2]![0].args.some(
          (arg) => arg.includes("state=all") && arg.includes("since=2026-01-01T00%3A00%3A00Z"),
        ),
      );
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "reads complete paginated comments, including a deleted author, and rejects pull requests",
  () =>
    Effect.gen(function* () {
      const comment = {
        id: 1,
        user: null,
        body: "Comment",
        html_url: "https://github.com/owner/repo/issues/42#issuecomment-1",
        created_at: "2026",
        updated_at: "2026",
      };
      execute
        .mockReturnValueOnce(Effect.succeed(output(rawIssue)))
        .mockReturnValueOnce(
          Effect.succeed(
            output(Array.from({ length: 100 }, (_, index) => ({ ...comment, id: index + 1 }))),
          ),
        )
        .mockReturnValueOnce(Effect.succeed(output([{ ...comment, id: 101 }])));
      const adapter = yield* make;
      const result = yield* adapter.detail({ ...repo, number: 42 });
      assert.strictEqual(result.comments.length, 101);
      assert.strictEqual(result.comments[0]?.author, "Deleted user");
      assert.isNotNull(result.commentsFetchedAt);
      execute.mockReturnValueOnce(Effect.succeed(output({ ...rawIssue, pull_request: {} })));
      assert.strictEqual(
        (yield* adapter.detail({ ...repo, number: 42 }).pipe(Effect.flip)).code,
        "invalid",
      );
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "reports authentication and missing issues safely, and shares the rate-limit cooldown",
  () =>
    Effect.gen(function* () {
      const adapter = yield* make;
      const context = {
        command: "gh" as const,
        cwd: "/repo",
        cause: new Error("sensitive stderr"),
      };
      execute
        .mockReturnValueOnce(Effect.fail(new GitHubCli.GitHubCliAuthenticationError(context)))
        .mockReturnValueOnce(Effect.fail(new GitHubCli.GitHubPullRequestNotFoundError(context)))
        .mockReturnValueOnce(Effect.fail(new GitHubCli.GitHubCliRateLimitError(context)));
      const auth = yield* adapter.list(repo, null).pipe(Effect.flip);
      assert.strictEqual(auth.code, "authentication");
      assert.notInclude(auth.message, "sensitive");
      assert.strictEqual(
        (yield* adapter.detail({ ...repo, number: 42 }).pipe(Effect.flip)).code,
        "not_found",
      );
      assert.strictEqual((yield* adapter.list(repo, null).pipe(Effect.flip)).code, "rate_limit");
      assert.strictEqual((yield* adapter.list(repo, null).pipe(Effect.flip)).code, "rate_limit");
      assert.strictEqual(execute.mock.calls.length, 3);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "rejects malformed and truncated responses instead of returning incomplete snapshots",
  () =>
    Effect.gen(function* () {
      const adapter = yield* make;
      execute
        .mockReturnValueOnce(Effect.succeed({ ...output([]), stdout: "invalid JSON" }))
        .mockReturnValueOnce(Effect.succeed({ ...output([]), stdoutTruncated: true }));
      assert.strictEqual((yield* adapter.list(repo, null).pipe(Effect.flip)).code, "remote");
      assert.strictEqual((yield* adapter.list(repo, null).pipe(Effect.flip)).code, "remote");
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "discovers assigned issues across organizations, paginates and excludes PRs without gh",
  () =>
    Effect.gen(function* () {
      const requests: string[] = [];
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          requests.push(request.url);
          assert.strictEqual(request.headers.authorization, "Bearer test-token");
          const issue = { ...rawIssue, repository: { full_name: "other-org/private" } };
          const body = request.url.endsWith("/user")
            ? { id: 123, login: "alice" }
            : new URL(request.url).searchParams.get("page") === "1"
              ? Array.from({ length: 100 }, (_, i) => ({
                  ...issue,
                  id: i + 1,
                  number: i + 1,
                  ...(i === 0 ? { pull_request: {} } : {}),
                }))
              : [{ ...issue, id: 901 }];
          return HttpClientResponse.fromWeb(request, Response.json(body));
        }),
      );
      const adapter = yield* make.pipe(Effect.provideService(HttpClient.HttpClient, http));
      assert.deepEqual(yield* adapter.viewer("test-token"), { id: 123, login: "alice" });
      const { issues } = yield* adapter.assigned("test-token");
      assert.strictEqual(issues.length, 100);
      assert.strictEqual(issues[0]?.repository, "other-org/private");
      assert.include(requests[1], "/issues?filter=assigned&state=open");
      assert.include(requests[2], "page=2");
      assert.strictEqual(execute.mock.calls.length, 0);
    }).pipe(Effect.provide(layer)),
);

it.effect("rejects incomplete account discovery and keeps credentials out of API errors", () =>
  Effect.gen(function* () {
    let calls = 0;
    const http = HttpClient.make((request) =>
      Effect.sync(() => {
        calls++;
        return HttpClientResponse.fromWeb(
          request,
          calls === 1
            ? Response.json([{ ...rawIssue }])
            : new Response("test-token sensitive", { status: 401 }),
        );
      }),
    );
    const adapter = yield* make.pipe(Effect.provideService(HttpClient.HttpClient, http));
    assert.strictEqual((yield* adapter.assigned("test-token").pipe(Effect.flip)).code, "remote");
    const error = yield* adapter.viewer("test-token").pipe(Effect.flip);
    assert.strictEqual(error.code, "authentication");
    assert.notInclude(error.message, "test-token");
  }).pipe(Effect.provide(layer)),
);

it.effect("uses saved tokens for issue reads and reports organizations omitted by SSO", () =>
  Effect.gen(function* () {
    const http = HttpClient.make((request) =>
      Effect.sync(() => {
        assert.strictEqual(request.headers.authorization, "Bearer saved-token");
        return HttpClientResponse.fromWeb(
          request,
          Response.json([{ ...rawIssue, repository: { full_name: "owner/repo" } }], {
            headers: { "x-github-sso": "partial-results; organizations=123" },
          }),
        );
      }),
    );
    const adapter = yield* make.pipe(
      Effect.provideService(HttpClient.HttpClient, http),
      Effect.provide(
        Layer.mock(ServerSecretStore)({
          get: () => Effect.succeed(Option.some(new TextEncoder().encode("saved-token"))),
        }),
      ),
    );
    assert.strictEqual((yield* adapter.list(repo, null)).length, 1);
    assert.strictEqual((yield* adapter.assigned("saved-token")).partialAccess, true);
    assert.strictEqual(execute.mock.calls.length, 0);
  }).pipe(Effect.provide(layer)),
);
