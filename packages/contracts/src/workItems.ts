import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProjectId, ThreadId } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

const ShortText = TrimmedNonEmptyString.check(Schema.isMaxLength(500));
export const WorkItemId = ShortText.pipe(Schema.brand("WorkItemId"));
export type WorkItemId = typeof WorkItemId.Type;
export const WorkItemSource = Schema.Literals([
  "github_issue",
  "github_pr",
  "slack",
  "manual",
  "automation",
]);
export type WorkItemSource = typeof WorkItemSource.Type;
export const WorkItemStatus = Schema.Literals([
  "inbox",
  "backlog",
  "ready",
  "planning",
  "awaiting_approval",
  "running",
  "blocked",
  "review",
  "done",
  "cancelled",
]);
export type WorkItemStatus = typeof WorkItemStatus.Type;
export const WorkItemPriority = Schema.Literals(["low", "medium", "high", "urgent"]);
export type WorkItemPriority = typeof WorkItemPriority.Type;
export const WORK_ITEM_MANUAL_STATUSES = [
  "inbox",
  "backlog",
  "ready",
  "blocked",
  "review",
  "done",
  "cancelled",
] as const;
export const WORK_ITEM_VIEWS = [
  { id: "inbox", label: "Inbox", statuses: ["inbox", "backlog", "ready"] },
  {
    id: "running",
    label: "In Progress",
    statuses: ["planning", "awaiting_approval", "running", "blocked"],
  },
  { id: "review", label: "Review", statuses: ["review"] },
  { id: "done", label: "Done", statuses: ["done", "cancelled"] },
] as const satisfies ReadonlyArray<{
  id: string;
  label: string;
  statuses: ReadonlyArray<WorkItemStatus>;
}>;

export const WorkItemExternalResource = Schema.Struct({
  source: WorkItemSource,
  namespace: ShortText,
  externalId: ShortText,
  url: Schema.String.check(Schema.isMaxLength(2048), Schema.isPattern(/^https?:\/\//)),
});
export type WorkItemExternalResource = typeof WorkItemExternalResource.Type;

const editableFields = {
  title: ShortText,
  body: Schema.String.check(Schema.isMaxLength(100_000)),
  projectId: Schema.NullOr(ProjectId),
  priority: WorkItemPriority,
  repository: Schema.NullOr(ShortText),
  branch: Schema.NullOr(ShortText),
  assignedAgent: Schema.NullOr(ProviderInstanceId),
  agentThreadId: Schema.NullOr(ThreadId),
  parentWorkItemId: Schema.NullOr(WorkItemId),
  failureReason: Schema.NullOr(ShortText),
};
export const WorkItem = Schema.Struct({
  id: WorkItemId,
  ...editableFields,
  source: WorkItemSource,
  externalId: Schema.NullOr(ShortText),
  externalUrl: Schema.NullOr(Schema.String),
  resources: Schema.Array(WorkItemExternalResource),
  status: WorkItemStatus,
  revision: PositiveInt,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  completedAt: Schema.NullOr(Schema.String),
  archivedAt: Schema.NullOr(Schema.String),
});
export type WorkItem = typeof WorkItem.Type;
export const WorkItemPatch = Schema.Struct({
  title: Schema.optionalKey(editableFields.title),
  body: Schema.optionalKey(editableFields.body),
  projectId: Schema.optionalKey(editableFields.projectId),
  priority: Schema.optionalKey(editableFields.priority),
  repository: Schema.optionalKey(editableFields.repository),
  branch: Schema.optionalKey(editableFields.branch),
  assignedAgent: Schema.optionalKey(editableFields.assignedAgent),
  agentThreadId: Schema.optionalKey(editableFields.agentThreadId),
  parentWorkItemId: Schema.optionalKey(editableFields.parentWorkItemId),
  failureReason: Schema.optionalKey(editableFields.failureReason),
});
export type WorkItemPatch = typeof WorkItemPatch.Type;
const mutationBase = { commandId: ShortText, id: WorkItemId };
const revisionBase = { ...mutationBase, expectedRevision: PositiveInt };
export const WorkItemDeleteInput = Schema.Struct(revisionBase);
export type WorkItemDeleteInput = typeof WorkItemDeleteInput.Type;
export const WorkItemMutation = Schema.Union([
  Schema.Struct({
    ...mutationBase,
    kind: Schema.Literal("create"),
    title: ShortText,
    fields: WorkItemPatch,
    source: WorkItemSource,
    resource: Schema.optionalKey(WorkItemExternalResource),
  }),
  Schema.Struct({ ...revisionBase, kind: Schema.Literal("update"), patch: WorkItemPatch }),
  Schema.Struct({
    ...revisionBase,
    kind: Schema.Literal("status"),
    status: WorkItemStatus,
    reason: Schema.optionalKey(ShortText),
  }),
  Schema.Struct({ ...revisionBase, kind: Schema.Literal("archive"), archived: Schema.Boolean }),
  Schema.Struct({
    ...revisionBase,
    kind: Schema.Literal("attachResource"),
    resource: WorkItemExternalResource,
  }),
  Schema.Struct({
    ...revisionBase,
    kind: Schema.Literal("detachResource"),
    resource: WorkItemExternalResource,
  }),
]);
export type WorkItemMutation = typeof WorkItemMutation.Type;
export const WorkItemListInput = Schema.Struct({
  agentThreadId: Schema.optionalKey(ThreadId),
  projectId: Schema.optionalKey(Schema.NullOr(ProjectId)),
  parentWorkItemId: Schema.optionalKey(Schema.NullOr(WorkItemId)),
  assignedAgent: Schema.optionalKey(Schema.NullOr(ProviderInstanceId)),
  statuses: Schema.optionalKey(Schema.Array(WorkItemStatus).check(Schema.isMaxLength(10))),
  source: Schema.optionalKey(WorkItemSource),
  priority: Schema.optionalKey(WorkItemPriority),
  query: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(500))),
  archived: Schema.optionalKey(Schema.Boolean),
  offset: Schema.optionalKey(NonNegativeInt),
  limit: Schema.optionalKey(PositiveInt.check(Schema.isLessThanOrEqualTo(100))),
});
export type WorkItemListInput = typeof WorkItemListInput.Type;
export const WorkItemSummary = Schema.Struct({
  ...Struct.omit(WorkItem.fields, ["body"]),
  bodyPreview: Schema.String.check(Schema.isMaxLength(1000)),
});
export type WorkItemSummary = typeof WorkItemSummary.Type;
export const WorkItemListResult = Schema.Struct({
  items: Schema.Array(WorkItemSummary),
  total: NonNegativeInt,
});
export type WorkItemListResult = typeof WorkItemListResult.Type;
export class WorkItemError extends Schema.TaggedError<WorkItemError>()("WorkItemError", {
  code: Schema.Literals(["not_found", "conflict", "invalid", "storage"]),
  message: Schema.String,
}) {}
