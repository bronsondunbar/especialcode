import * as Schema from "effect/Schema";
import { NonNegativeInt, PositiveInt, ProjectId, ThreadId } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { WorkItemId, WorkItemSource, WorkItemStatus, WorkItemPriority } from "./workItems.ts";
import { WorkActivityEvent } from "./workActivity.ts";
export const WORK_DASHBOARD_SECTIONS = [
  { id: "attention", title: "Needs Attention" },
  { id: "running", title: "Running" },
  { id: "ready", title: "Ready" },
  { id: "review", title: "Review" },
  { id: "blocked", title: "Blocked" },
  { id: "inbox", title: "Inbox" },
] as const;
export const WorkDashboardSection = Schema.Literals([
  "attention",
  "running",
  "ready",
  "review",
  "blocked",
  "inbox",
]);
export type WorkDashboardSection = typeof WorkDashboardSection.Type;
export const WorkDashboardInput = Schema.Struct({
  projectId: Schema.optionalKey(ProjectId),
  repository: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(500))),
  source: Schema.optionalKey(WorkItemSource),
  agent: Schema.optionalKey(ProviderInstanceId),
  status: Schema.optionalKey(WorkItemStatus),
  priority: Schema.optionalKey(WorkItemPriority),
  section: Schema.optionalKey(WorkDashboardSection),
  offset: Schema.optionalKey(NonNegativeInt),
  limit: Schema.optionalKey(PositiveInt.check(Schema.isLessThanOrEqualTo(25))),
});
export type WorkDashboardInput = typeof WorkDashboardInput.Type;
export const WorkDashboardItem = Schema.Struct({
  id: WorkItemId,
  title: Schema.String,
  projectId: Schema.NullOr(ProjectId),
  project: Schema.NullOr(Schema.String),
  repository: Schema.NullOr(Schema.String),
  source: WorkItemSource,
  status: WorkItemStatus,
  priority: WorkItemPriority,
  agent: Schema.NullOr(ProviderInstanceId),
  agentName: Schema.NullOr(Schema.String),
  threadId: Schema.NullOr(ThreadId),
  activity: Schema.NullOr(Schema.String),
  reasons: Schema.Array(Schema.String),
  updatedAt: Schema.String,
});
export type WorkDashboardItem = typeof WorkDashboardItem.Type;
export const WorkDashboardPage = Schema.Struct({
  sections: Schema.Array(
    Schema.Struct({
      id: WorkDashboardSection,
      total: NonNegativeInt,
      items: Schema.Array(WorkDashboardItem),
    }),
  ),
  activity: Schema.Array(
    Schema.Struct({ ...WorkActivityEvent.fields, workItemTitle: Schema.String }),
  ),
});
export class WorkDashboardError extends Schema.TaggedError<WorkDashboardError>()(
  "WorkDashboardError",
  { message: Schema.String },
) {}
