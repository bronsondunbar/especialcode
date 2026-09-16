import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
export const accountSecretName = "github-issues-account";
import {
  GitHubIssuesError,
  type GitHubIssue,
  type GitHubIssueReference,
  GitHubRepositoryKey,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { GitHubCli } from "../../sourceControl/GitHubCli.ts";
import { SourceControlRateLimit } from "../../sourceControl/SourceControlRateLimit.ts";

const User = Schema.Struct({ login: Schema.String });
const RawIssue = Schema.Struct({
  id: Schema.Int.check(Schema.isGreaterThan(0)),
  number: Schema.Int.check(Schema.isGreaterThan(0)),
  title: Schema.String,
  body: Schema.NullOr(Schema.String),
  html_url: Schema.String,
  state: Schema.Literals(["open", "closed"]),
  updated_at: Schema.String,
  labels: Schema.Array(Schema.Union([Schema.String, Schema.Struct({ name: Schema.String })])),
  assignees: Schema.Array(User),
  milestone: Schema.NullOr(Schema.Struct({ title: Schema.String })),
  pull_request: Schema.optionalKey(Schema.Unknown),
});
const AccountIssue = Schema.Struct({
  ...RawIssue.fields,
  repository: Schema.Struct({ full_name: GitHubRepositoryKey.fields.repository }),
});
const decodeAccountIssues = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(AccountIssue)),
);
const decodeViewer = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({ id: Schema.Int.check(Schema.isGreaterThan(0)), login: Schema.String }),
  ),
);
const RawComment = Schema.Struct({
  id: Schema.Int.check(Schema.isGreaterThan(0)),
  user: Schema.NullOr(User),
  body: Schema.String,
  html_url: Schema.String,
  created_at: Schema.String,
  updated_at: Schema.String,
});
const decodeIssues = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(RawIssue)));
const decodeIssue = Schema.decodeUnknownEffect(Schema.fromJsonString(RawIssue));
const decodeComments = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(RawComment)));
const invalidResponse = () =>
  new GitHubIssuesError({ code: "remote", message: "GitHub returned an invalid issue response." });
const normalize = (repo: GitHubRepositoryKey, issue: typeof RawIssue.Type): GitHubIssue => ({
  ...repo,
  externalId: String(issue.id),
  number: issue.number,
  title: issue.title,
  body: issue.body ?? "",
  url: issue.html_url,
  state: issue.state,
  updatedAt: issue.updated_at,
  labels: issue.labels.map((label) => (typeof label === "string" ? label : label.name)),
  assignees: issue.assignees.map((user) => user.login),
  milestone: issue.milestone?.title ?? null,
  comments: [],
  commentsFetchedAt: null,
});

export const make = Effect.gen(function* () {
  const cli = yield* GitHubCli;
  const http = yield* HttpClient.HttpClient;
  const secrets = yield* ServerSecretStore;
  const rateLimit = yield* SourceControlRateLimit;
  const requestRaw = Effect.fn("GitHubIssuesAdapter.request")(
    function* (repo: { host: string; repository?: string }, path: string, explicitToken?: string) {
      const key = { provider: "github" as const, host: repo.host };
      const lease = yield* rateLimit.check(key).pipe(
        Effect.mapError(
          () =>
            new GitHubIssuesError({
              code: "rate_limit",
              message: "GitHub requests are paused by a rate limit. Retry later.",
            }),
        ),
      );
      const endpoint = repo.repository ? `repos/${repo.repository}/${path}` : path;
      let token = explicitToken;
      if (!token && repo.host === "github.com") {
        const saved = yield* secrets.get(accountSecretName).pipe(
          Effect.mapError(
            () =>
              new GitHubIssuesError({
                code: "storage",
                message: "Could not read the GitHub connection.",
              }),
          ),
        );
        if (Option.isSome(saved)) token = new TextDecoder().decode(saved.value);
      }
      if (token) {
        // Account credentials only ever go to GitHub's API, with redirects disabled.
        if (repo.host !== "github.com") return yield* invalidResponse();
        const response = yield* http
          .execute(
            HttpClientRequest.get(`https://api.github.com/${endpoint}`).pipe(
              HttpClientRequest.bearerToken(token),
              HttpClientRequest.setHeader("Accept", "application/vnd.github+json"),
              HttpClientRequest.setHeader("X-GitHub-Api-Version", "2022-11-28"),
            ),
          )
          .pipe(
            Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
            Effect.mapError(
              () =>
                new GitHubIssuesError({
                  code: "unavailable",
                  message: "Could not reach GitHub. Retry later.",
                }),
            ),
          );
        if (
          response.status === 429 ||
          (response.status === 403 && response.headers["x-ratelimit-remaining"] === "0")
        ) {
          yield* rateLimit.recordRateLimit({ ...key, lease });
          return yield* new GitHubIssuesError({
            code: "rate_limit",
            message: "GitHub rate limit reached. Retry later.",
          });
        }
        if (response.status === 401 || response.status === 403)
          return yield* new GitHubIssuesError({
            code: "authentication",
            message:
              "Reconnect GitHub with a valid token and authorize organization access, including SSO if required.",
          });
        if (response.status === 404)
          return yield* new GitHubIssuesError({
            code: "not_found",
            message: "GitHub issue not found or access was removed.",
          });
        if (response.status !== 200)
          return yield* new GitHubIssuesError({
            code: "remote",
            message: "GitHub could not complete this request.",
          });
        let size = 0;
        const decoder = new TextDecoder();
        const chunks = yield* response.stream.pipe(
          Stream.mapEffect((chunk) => {
            size += chunk.byteLength;
            return size > 16 * 1024 * 1024
              ? Effect.fail(
                  new GitHubIssuesError({
                    code: "remote",
                    message: "GitHub response exceeds the snapshot limit.",
                  }),
                )
              : Effect.succeed(decoder.decode(chunk, { stream: true }));
          }),
          Stream.runCollect,
          Effect.mapError((error) =>
            error._tag === "GitHubIssuesError" ? error : invalidResponse(),
          ),
        );
        yield* rateLimit.recordSuccess({ ...key, lease });
        return {
          body: chunks.join("") + decoder.decode(),
          partialAccess: response.headers["x-github-sso"]?.includes("partial-results") === true,
        };
      }
      const result = yield* cli
        .execute({
          cwd: process.cwd(),
          args: [
            "api",
            "--hostname",
            repo.host,
            "--method",
            "GET",
            endpoint,
            "-H",
            "Accept: application/vnd.github+json",
            "-H",
            "X-GitHub-Api-Version: 2022-11-28",
          ],
          maxOutputBytes: 16 * 1024 * 1024,
        })
        .pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              if (error._tag === "GitHubCliRateLimitError") {
                yield* rateLimit.recordRateLimit({ ...key, lease });
                return yield* new GitHubIssuesError({
                  code: "rate_limit",
                  message: "GitHub rate limit reached. Retry later.",
                });
              }
              if (error._tag === "GitHubCliAuthenticationError")
                return yield* new GitHubIssuesError({
                  code: "authentication",
                  message: "Sign in with gh auth login on this environment, then retry.",
                });
              if (error._tag === "GitHubPullRequestNotFoundError")
                return yield* new GitHubIssuesError({
                  code: "not_found",
                  message:
                    "GitHub repository or issue not found, or this account no longer has access.",
                });
              if (error._tag === "GitHubCliUnavailableError")
                return yield* new GitHubIssuesError({
                  code: "unavailable",
                  message: "Install the GitHub CLI on this environment to sync issues.",
                });
              return yield* new GitHubIssuesError({
                code: "remote",
                message:
                  "Could not read GitHub issues. Check the repository, issue number, and account access.",
              });
            }),
          ),
        );
      if (result.stdoutTruncated)
        return yield* new GitHubIssuesError({
          code: "remote",
          message: "GitHub response was truncated. The saved snapshot was not replaced.",
        });
      yield* rateLimit.recordSuccess({ ...key, lease });
      return { body: result.stdout, partialAccess: false };
    },
    Effect.timeout("30 seconds"),
    Effect.catchTag("TimeoutError", () =>
      Effect.fail(
        new GitHubIssuesError({ code: "unavailable", message: "GitHub timed out. Retry later." }),
      ),
    ),
  );
  const request = (repo: { host: string; repository?: string }, path: string, token?: string) =>
    requestRaw(repo, path, token).pipe(Effect.map((result) => result.body));
  const list = Effect.fn("GitHubIssuesAdapter.list")(function* (
    repo: GitHubRepositoryKey,
    since: string | null,
  ) {
    const issues: GitHubIssue[] = [];
    let issueBytes = 0;
    // Start with open issues; incremental sync includes all states to observe closure and reopening.
    for (let page = 1; page <= 100; page++) {
      const raw = yield* request(
        repo,
        `issues?state=${since ? "all" : "open"}&sort=updated&direction=asc&per_page=100&page=${page}${since ? `&since=${encodeURIComponent(since)}` : ""}`,
      );
      issueBytes += Buffer.byteLength(raw);
      if (issueBytes > 32 * 1024 * 1024)
        return yield* new GitHubIssuesError({
          code: "remote",
          message:
            "Repository sync exceeds the 32 MB snapshot limit. Import individual issues by number instead.",
        });
      const batch = yield* decodeIssues(raw).pipe(Effect.mapError(invalidResponse));
      issues.push(
        ...batch
          .filter((issue) => issue.pull_request === undefined)
          .map((issue) => normalize(repo, issue)),
      );
      if (batch.length < 100) return issues;
    }
    return yield* new GitHubIssuesError({
      code: "remote",
      message: "Repository sync exceeded 10,000 records. No sync cursor was advanced.",
    });
  });
  const detail = Effect.fn("GitHubIssuesAdapter.detail")(function* (ref: GitHubIssueReference) {
    const issue = yield* request(ref, `issues/${ref.number}`).pipe(
      Effect.flatMap(decodeIssue),
      Effect.mapError((error) => (error._tag === "GitHubIssuesError" ? error : invalidResponse())),
    );
    if (issue.pull_request !== undefined)
      return yield* new GitHubIssuesError({
        code: "invalid",
        message: "This number identifies a pull request, not an issue.",
      });
    const comments: GitHubIssue["comments"][number][] = [];
    let commentBytes = 0;
    for (let page = 1; page <= 10; page++) {
      const raw = yield* request(ref, `issues/${ref.number}/comments?per_page=100&page=${page}`);
      commentBytes += Buffer.byteLength(raw);
      if (commentBytes > 4 * 1024 * 1024)
        return yield* new GitHubIssuesError({
          code: "remote",
          message: "Issue comments exceed the 4 MB snapshot limit. Open the issue on GitHub.",
        });
      const batch = yield* decodeComments(raw).pipe(Effect.mapError(invalidResponse));
      comments.push(
        ...batch.map((comment) => ({
          id: String(comment.id),
          author: comment.user?.login ?? "Deleted user",
          body: comment.body,
          url: comment.html_url,
          createdAt: comment.created_at,
          updatedAt: comment.updated_at,
        })),
      );
      if (batch.length < 100) {
        const snapshot: GitHubIssue = {
          ...normalize(ref, issue),
          comments: [...new Map(comments.map((comment) => [comment.id, comment])).values()],
          commentsFetchedAt: DateTime.formatIso(yield* DateTime.now),
        };
        return snapshot;
      }
    }
    return yield* new GitHubIssuesError({
      code: "remote",
      message: "Issue has too many comments to refresh completely.",
    });
  });
  const viewer = (token: string) =>
    request({ host: "github.com" }, "user", token).pipe(
      Effect.flatMap(decodeViewer),
      Effect.mapError((error) => (error._tag === "GitHubIssuesError" ? error : invalidResponse())),
    );
  const assigned = Effect.fn("GitHubIssuesAdapter.assigned")(function* (token: string) {
    const issues = new Map<string, GitHubIssue>();
    let bytes = 0;
    let partialAccess = false;
    for (let page = 1; page <= 100; page++) {
      const response = yield* requestRaw(
        { host: "github.com" },
        `issues?filter=assigned&state=open&sort=updated&direction=asc&per_page=100&page=${page}`,
        token,
      );
      partialAccess ||= response.partialAccess;
      const raw = response.body;
      bytes += Buffer.byteLength(raw);
      if (bytes > 32 * 1024 * 1024)
        return yield* new GitHubIssuesError({
          code: "remote",
          message: "Assigned issues exceed the 32 MB snapshot limit.",
        });
      const batch = yield* decodeAccountIssues(raw).pipe(Effect.mapError(invalidResponse));
      for (const issue of batch)
        if (issue.pull_request === undefined) {
          issues.set(
            String(issue.id),
            normalize({ host: "github.com", repository: issue.repository.full_name }, issue),
          );
        }
      if (batch.length < 100) return { issues: [...issues.values()], partialAccess };
    }
    return yield* new GitHubIssuesError({
      code: "remote",
      message: "Assigned issues exceed 10,000 records. No tasks were imported.",
    });
  });
  return { list, detail, viewer, assigned };
});
export class GitHubIssuesAdapter extends Context.Service<
  GitHubIssuesAdapter,
  Effect.Success<typeof make>
>()("t3/integrations/github/GitHubIssuesAdapter") {}
