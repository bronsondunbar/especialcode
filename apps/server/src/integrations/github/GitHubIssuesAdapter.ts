import {
  GitHubIssuesError,
  type GitHubIssue,
  type GitHubIssueReference,
  type GitHubRepositoryKey,
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
  const rateLimit = yield* SourceControlRateLimit;
  const request = Effect.fn("GitHubIssuesAdapter.request")(function* (
    repo: GitHubRepositoryKey,
    path: string,
  ) {
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
    const result = yield* cli
      .execute({
        cwd: process.cwd(),
        args: [
          "api",
          "--hostname",
          repo.host,
          "--method",
          "GET",
          `repos/${repo.repository}/${path}`,
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
    return result.stdout;
  });
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
  return { list, detail };
});
export class GitHubIssuesAdapter extends Context.Service<
  GitHubIssuesAdapter,
  Effect.Success<typeof make>
>()("t3/integrations/github/GitHubIssuesAdapter") {}
