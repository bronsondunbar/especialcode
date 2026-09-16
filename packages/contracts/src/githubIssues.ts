import { ExternalSyncMetadata } from "./externalSync.ts";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import { NonNegativeInt, PositiveInt, ProjectId } from "./baseSchemas.ts";
import { WorkItemId, WorkItemStatus } from "./workItems.ts";

const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500));
export const GitHubRepositoryKey = Schema.Struct({
  host: Schema.String.check(
    Schema.isMaxLength(253),
    Schema.isPattern(/^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/),
  ),
  repository: Schema.String.check(
    Schema.isMaxLength(201),
    Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9-]*\/[a-zA-Z0-9_.-]+$/),
  ),
});
export type GitHubRepositoryKey = typeof GitHubRepositoryKey.Type;
export const GitHubTrackedRepository = Schema.Struct({
  ...ExternalSyncMetadata.fields,
  ...GitHubRepositoryKey.fields,
  discoveredByAccount: Schema.optionalKey(Schema.Boolean),
  projectId: Schema.NullOr(ProjectId),
  importLabels: Schema.Array(Text).check(Schema.isMaxLength(50)),
  lastSyncedAt: Schema.NullOr(Schema.String),
  syncError: Schema.NullOr(Schema.String),
});
export type GitHubTrackedRepository = typeof GitHubTrackedRepository.Type;
export const GitHubIssueReference = Schema.Struct({
  ...GitHubRepositoryKey.fields,
  number: PositiveInt,
});
export type GitHubIssueReference = typeof GitHubIssueReference.Type;
export const GitHubIssueComment = Schema.Struct({
  id: Text,
  author: Schema.String,
  body: Schema.String,
  url: Schema.String.check(Schema.isPattern(/^https:\/\//), Schema.isMaxLength(2048)),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export const GitHubIssue = Schema.Struct({
  ...ExternalSyncMetadata.fields,
  ...GitHubIssueReference.fields,
  externalId: Text,
  title: Text,
  body: Schema.String.check(Schema.isMaxLength(100_000)),
  url: Schema.String.check(Schema.isPattern(/^https:\/\//), Schema.isMaxLength(2048)),
  state: Schema.Literals(["open", "closed"]),
  labels: Schema.Array(Schema.String),
  assignees: Schema.Array(Schema.String),
  milestone: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
  comments: Schema.Array(GitHubIssueComment),
  commentsFetchedAt: Schema.NullOr(Schema.String),
});
export type GitHubIssue = typeof GitHubIssue.Type;
export const GitHubIssueSummary = Schema.Struct({
  ...Struct.omit(GitHubIssue.fields, ["body", "comments"]),
  workItemId: Schema.NullOr(WorkItemId),
  localStatus: Schema.NullOr(WorkItemStatus),
});
export const GitHubIssueDetail = Schema.Struct({
  ...GitHubIssue.fields,
  workItemId: Schema.NullOr(WorkItemId),
  localStatus: Schema.NullOr(WorkItemStatus),
});
export type GitHubIssueDetail = typeof GitHubIssueDetail.Type;
export const GitHubIssuesListInput = Schema.Struct({
  repository: Schema.optionalKey(Text),
  projectId: Schema.optionalKey(ProjectId),
  label: Schema.optionalKey(Text),
  assignee: Schema.optionalKey(Text),
  state: Schema.optionalKey(Schema.Literals(["open", "closed", "all"])),
  offset: Schema.optionalKey(NonNegativeInt),
  limit: Schema.optionalKey(PositiveInt.check(Schema.isLessThanOrEqualTo(100))),
});
export type GitHubIssuesListInput = typeof GitHubIssuesListInput.Type;
export const GitHubAccount = Schema.Struct({
  ...ExternalSyncMetadata.fields,
  id: PositiveInt,
  login: Text,
});
export type GitHubAccount = typeof GitHubAccount.Type;
export const GitHubAccountInput = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("connect"),
    token: Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(1000),
      Schema.isPattern(/^\S+$/),
    ),
  }),
  Schema.Struct({ kind: Schema.Literal("disconnect") }),
  Schema.Struct({ kind: Schema.Literal("sync") }),
]);
export type GitHubAccountInput = typeof GitHubAccountInput.Type;
export const GitHubIssuesListResult = Schema.Struct({
  account: Schema.optionalKey(Schema.NullOr(GitHubAccount)),
  repositories: Schema.Array(GitHubTrackedRepository),
  items: Schema.Array(GitHubIssueSummary),
  total: NonNegativeInt,
});
export const GitHubIssuesMutation = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("configure"),
    ...GitHubRepositoryKey.fields,
    projectId: Schema.NullOr(ProjectId),
    importLabels: GitHubTrackedRepository.fields.importLabels,
  }),
  Schema.Struct({ kind: Schema.Literal("untrack"), ...GitHubRepositoryKey.fields }),
  Schema.Struct({ kind: Schema.Literal("sync"), ...GitHubRepositoryKey.fields }),
  Schema.Struct({ kind: Schema.Literal("import"), ...GitHubIssueReference.fields }),
  Schema.Struct({ kind: Schema.Literal("refresh"), ...GitHubIssueReference.fields }),
]);
export type GitHubIssuesMutation = typeof GitHubIssuesMutation.Type;
export class GitHubIssuesError extends Schema.TaggedError<GitHubIssuesError>()(
  "GitHubIssuesError",
  {
    code: Schema.Literals([
      "invalid",
      "not_found",
      "authentication",
      "rate_limit",
      "unavailable",
      "remote",
      "storage",
    ]),
    message: Schema.String,
  },
) {}
