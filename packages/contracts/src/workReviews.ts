import * as Schema from "effect/Schema";
import { PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { WorkItem, WorkItemId } from "./workItems.ts";
import { WorkExecution, WorkValidationCommands } from "./workExecutions.ts";
import {
  PullRequestRef,
  PullRequestComment,
  PullRequestCheck,
  PullRequestState,
  PullRequestReviewDecision,
} from "./pullRequest.ts";
export const WorkReviewSnapshot = Schema.Struct({
  reference: PullRequestRef,
  revision: PositiveInt,
  fingerprint: Schema.String,
  state: PullRequestState,
  headBranch: Schema.String,
  reviewDecision: Schema.NullOr(PullRequestReviewDecision),
  reviewers: Schema.Array(Schema.String),
  checks: Schema.Array(PullRequestCheck),
  comments: Schema.Array(PullRequestComment),
  commentsTruncated: Schema.Boolean,
  mergedAt: Schema.NullOr(Schema.String),
  syncedAt: Schema.String,
});
export type WorkReviewSnapshot = typeof WorkReviewSnapshot.Type;
export const WorkReviewState = Schema.Struct({
  item: WorkItem,
  snapshot: Schema.NullOr(WorkReviewSnapshot),
  syncError: Schema.NullOr(Schema.String),
  execution: Schema.NullOr(WorkExecution),
  history: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      kind: Schema.String,
      message: Schema.String,
      occurredAt: Schema.String,
    }),
  ),
});
export const WorkReviewMutation = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("refresh"), id: WorkItemId }),
  Schema.Struct({
    kind: Schema.Literal("send"),
    id: WorkItemId,
    commandId: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
    expectedWorkItemRevision: PositiveInt,
    expectedReviewRevision: PositiveInt,
    guidance: Schema.String.check(Schema.isMaxLength(5000)),
    validationCommands: WorkValidationCommands,
  }),
]);
export type WorkReviewMutation = typeof WorkReviewMutation.Type;
