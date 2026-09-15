import * as Schema from "effect/Schema";
import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { EnvironmentId, ProjectId, ThreadId } from "./baseSchemas.ts";
import { WorkItemId } from "./workItems.ts";

export const ApplicationEventSource = Schema.Literals([
  "work",
  "agents",
  "github",
  "slack",
  "automation",
  "ci",
  "system",
]);
export const NotificationPriority = Schema.Literals(["info", "attention", "urgent"]);
export const NotificationAction = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("work_item"), workItemId: WorkItemId }),
  Schema.Struct({ kind: Schema.Literals(["agent", "changes"]), threadId: ThreadId }),
]);
/** Environment-local events use stable source IDs so replay never creates duplicates. */
export const ApplicationEvent = Schema.Struct({
  id: TrimmedNonEmptyString.check(Schema.isMaxLength(500)),
  source: ApplicationEventSource,
  type: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  userId: Schema.NullOr(Schema.String),
  projectId: Schema.NullOr(ProjectId),
  workItemId: Schema.NullOr(WorkItemId),
  title: Schema.String.check(Schema.isMaxLength(500)),
  message: Schema.String.check(Schema.isMaxLength(5000)),
  action: Schema.NullOr(NotificationAction),
  createdAt: IsoDateTime,
});
export type ApplicationEvent = typeof ApplicationEvent.Type;
export const AppNotification = Schema.Struct({
  ...ApplicationEvent.fields,
  sequence: NonNegativeInt,
  priority: NotificationPriority,
  readAt: Schema.NullOr(IsoDateTime),
});
export type AppNotification = typeof AppNotification.Type;
export const NOTIFICATION_FILTERS = [
  { id: "all", label: "All" },
  { id: "attention", label: "Needs attention" },
  { id: "agents", label: "Agents" },
  { id: "github", label: "GitHub" },
  { id: "slack", label: "Slack" },
  { id: "system", label: "System" },
] as const;
export const NotificationFilter = Schema.Literals(NOTIFICATION_FILTERS.map((entry) => entry.id));
export const NotificationListInput = Schema.Struct({
  filter: Schema.optionalKey(NotificationFilter),
  channel: Schema.optionalKey(Schema.Literals(["inApp", "desktop"])),
  afterSequence: Schema.optionalKey(NonNegativeInt),
  offset: Schema.optionalKey(NonNegativeInt),
  limit: Schema.optionalKey(NonNegativeInt.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
});
export type NotificationListInput = typeof NotificationListInput.Type;
export const NOTIFICATION_PREFERENCE_GROUPS = [
  {
    title: "Agent activity",
    entries: [
      { key: "agentInput", label: "Needs input" },
      { key: "agentCompleted", label: "Completed" },
      { key: "agentFailed", label: "Failed" },
      { key: "agentStatus", label: "All status changes" },
    ],
  },
  {
    title: "GitHub",
    entries: [
      { key: "reviewRequested", label: "Review requested" },
      { key: "changesRequested", label: "Changes requested" },
      { key: "checkFailed", label: "Check failures" },
      { key: "prMerged", label: "PR merged" },
      { key: "issueImported", label: "New imported issues" },
    ],
  },
  {
    title: "Slack",
    entries: [
      { key: "slackDirect", label: "Direct mentions" },
      { key: "slackProject", label: "Tracked project mentions" },
      { key: "slackImported", label: "Imported messages" },
    ],
  },
] as const;
export const NotificationPreferences = Schema.Struct({
  events: Schema.Struct({
    agentInput: Schema.Boolean,
    agentCompleted: Schema.Boolean,
    agentFailed: Schema.Boolean,
    agentStatus: Schema.Boolean,
    reviewRequested: Schema.Boolean,
    changesRequested: Schema.Boolean,
    checkFailed: Schema.Boolean,
    prMerged: Schema.Boolean,
    issueImported: Schema.Boolean,
    slackDirect: Schema.Boolean,
    slackProject: Schema.Boolean,
    slackImported: Schema.Boolean,
  }),
  // Add channels here when their delivery implementations exist.
  delivery: Schema.Struct({ inApp: Schema.Boolean, desktop: Schema.Boolean }),
});
export type NotificationPreferences = typeof NotificationPreferences.Type;
export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  events: {
    agentInput: true,
    agentCompleted: true,
    agentFailed: true,
    agentStatus: false,
    reviewRequested: true,
    changesRequested: true,
    checkFailed: true,
    prMerged: true,
    issueImported: false,
    slackDirect: true,
    slackProject: false,
    slackImported: false,
  },
  delivery: { inApp: true, desktop: true },
};
export const NotificationPreferencesState = Schema.Struct({
  revision: NonNegativeInt,
  value: NotificationPreferences,
});
export type NotificationPreferencesState = typeof NotificationPreferencesState.Type;
export const NotificationPage = Schema.Struct({
  items: Schema.Array(AppNotification),
  total: NonNegativeInt,
  unreadCount: NonNegativeInt,
  latestSequence: NonNegativeInt,
  preferences: Schema.optionalKey(NotificationPreferencesState),
});
export const NotificationMutation = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("preferences"),
    expectedRevision: NonNegativeInt,
    value: NotificationPreferences,
  }),
  Schema.Struct({
    kind: Schema.Literal("read"),
    id: ApplicationEvent.fields.id,
    read: Schema.Boolean,
  }),
  // Captured server sequence prevents marking notifications arriving after the click as read.
  Schema.Struct({ kind: Schema.Literal("read_all"), throughSequence: NonNegativeInt }),
]);
export type NotificationMutation = typeof NotificationMutation.Type;
export class NotificationError extends Schema.TaggedError<NotificationError>()(
  "NotificationError",
  { message: Schema.String },
) {}

export const DesktopAppNotification = Schema.Struct({
  id: ApplicationEvent.fields.id,
  environmentId: EnvironmentId,
  title: ApplicationEvent.fields.title,
  message: ApplicationEvent.fields.message,
  action: ApplicationEvent.fields.action,
});
export type DesktopAppNotification = typeof DesktopAppNotification.Type;
