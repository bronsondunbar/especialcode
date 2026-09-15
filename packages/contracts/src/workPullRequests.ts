import * as Schema from "effect/Schema";
import { PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { WorkItem, WorkItemId } from "./workItems.ts";
import {
  PullRequestRef,
  PullRequestDetail,
  PullRequestActivity,
  PullRequestSummary,
  PullRequestMergeMethod,
} from "./pullRequest.ts";
export const WorkPullRequestContent = Schema.Struct({
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  body: Schema.String.check(Schema.isMaxLength(65_536)),
});
export const WorkPullRequestRecord = Schema.Struct({
  workItemId: WorkItemId,
  executionId: Schema.String,
  commandId: Schema.String,
  status: Schema.Literals(["creating", "failed", "linked"]),
  content: WorkPullRequestContent,
  reference: Schema.NullOr(PullRequestRef),
  url: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
});
export type WorkPullRequestRecord = typeof WorkPullRequestRecord.Type;
export const WorkPullRequestState = Schema.Struct({
  item: WorkItem,
  draft: WorkPullRequestContent,
  unavailableReason: Schema.NullOr(Schema.String),
  record: Schema.NullOr(WorkPullRequestRecord),
  detail: Schema.NullOr(PullRequestDetail),
  activity: Schema.NullOr(PullRequestActivity),
  summary: Schema.NullOr(PullRequestSummary),
  refreshError: Schema.NullOr(Schema.String),
});
export type WorkPullRequestState = typeof WorkPullRequestState.Type;
export const WorkPullRequestMutation = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("create"),
    id: WorkItemId,
    commandId: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
    expectedRevision: PositiveInt,
    content: WorkPullRequestContent,
  }),
  Schema.Struct({ kind: Schema.Literal("refresh"), id: WorkItemId }),
  Schema.Struct({
    kind: Schema.Literal("merge"),
    id: WorkItemId,
    mergeMethod: PullRequestMergeMethod,
  }),
]);
export type WorkPullRequestMutation = typeof WorkPullRequestMutation.Type;
export class WorkPullRequestError extends Schema.TaggedError<WorkPullRequestError>()(
  "WorkPullRequestError",
  {
    code: Schema.Literals(["invalid", "conflict", "unavailable", "storage"]),
    message: Schema.String,
  },
) {}
