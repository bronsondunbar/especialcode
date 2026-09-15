import { ExternalSyncMetadata } from "./externalSync.ts";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import { NonNegativeInt, PositiveInt, ProjectId } from "./baseSchemas.ts";
import { WorkItemId, WorkItemPriority } from "./workItems.ts";
export const SlackId = Schema.String.check(Schema.isPattern(/^[A-Z][A-Z0-9]{1,80}$/));
export const SlackTimestamp = Schema.String.check(Schema.isPattern(/^\d{10,16}\.\d{6}$/));
const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500));
export const SlackWorkspace = Schema.Struct({
  id: SlackId,
  name: Text,
  userId: SlackId,
  scopes: Schema.Array(Schema.String),
});
export type SlackWorkspace = typeof SlackWorkspace.Type;
export const SlackChannel = Schema.Struct({ id: SlackId, name: Text });
export const SlackChannelConfig = Schema.Struct({
  ...ExternalSyncMetadata.fields,
  workspaceId: SlackId,
  channelId: SlackId,
  name: Text,
  projectId: Schema.NullOr(ProjectId),
  repository: Schema.NullOr(Text),
  channelMentions: Schema.Boolean,
});
export type SlackChannelConfig = typeof SlackChannelConfig.Type;
export const SlackReference = Schema.Struct({
  workspaceId: SlackId,
  channelId: SlackId,
  ts: SlackTimestamp,
});
export type SlackReference = typeof SlackReference.Type;
export const SlackReply = Schema.Struct({
  ts: SlackTimestamp,
  author: Schema.String,
  text: Schema.String.check(Schema.isMaxLength(100_000)),
});
export const SlackMessage = Schema.Struct({
  ...ExternalSyncMetadata.fields,
  ...SlackReference.fields,
  author: Schema.String,
  text: Schema.String.check(Schema.isMaxLength(100_000)),
  threadTs: SlackTimestamp,
  url: Schema.NullOr(
    Schema.String.check(
      Schema.isPattern(/^https:\/\/[^/]+\.slack\.com\//),
      Schema.isMaxLength(2048),
    ),
  ),
  replies: Schema.Array(SlackReply).check(Schema.isMaxLength(300)),
  nextCursor: Schema.String,
  ignored: Schema.Boolean,
});
export type SlackMessage = typeof SlackMessage.Type;
export const SlackListInput = Schema.Struct({
  workspaceId: Schema.optionalKey(SlackId),
  ignored: Schema.optionalKey(Schema.Boolean),
  offset: Schema.optionalKey(NonNegativeInt),
  limit: Schema.optionalKey(PositiveInt.check(Schema.isLessThanOrEqualTo(100))),
});
export type SlackListInput = typeof SlackListInput.Type;
export const SlackListResult = Schema.Struct({
  configured: Schema.Boolean,
  workspaces: Schema.Array(SlackWorkspace),
  channels: Schema.Array(SlackChannelConfig),
  items: Schema.Array(
    Schema.Struct({ ...SlackMessage.fields, workItemId: Schema.NullOr(WorkItemId) }),
  ),
  total: NonNegativeInt,
});
export const SlackAdminInput = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("connect") }),
  Schema.Struct({ kind: Schema.Literal("disconnect"), workspaceId: SlackId }),
  Schema.Struct({
    kind: Schema.Literal("configure"),
    ...Struct.omit(SlackChannelConfig.fields, [
      "lastSyncedAt",
      "lastAttemptAt",
      "syncStatus",
      "syncError",
    ]),
  }),
  Schema.Struct({ kind: Schema.Literal("untrack"), workspaceId: SlackId, channelId: SlackId }),
  Schema.Struct({
    kind: Schema.Literal("channels"),
    workspaceId: SlackId,
    cursor: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2000))),
  }),
]);
export type SlackAdminInput = typeof SlackAdminInput.Type;
export const SlackAdminResult = Schema.Struct({
  authorizeUrl: Schema.NullOr(Schema.String),
  channels: Schema.Array(SlackChannel),
  nextCursor: Schema.String,
});
export const SlackMutation = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("sync"),
    workspaceId: SlackId,
    channelId: SlackId,
    page: Schema.optionalKey(PositiveInt.check(Schema.isLessThanOrEqualTo(100))),
  }),
  Schema.Struct({
    kind: Schema.Literal("select"),
    workspaceId: SlackId,
    channelId: SlackId,
    ts: SlackTimestamp,
  }),
  Schema.Struct({
    kind: Schema.Literal("thread"),
    ...SlackReference.fields,
    more: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({
    kind: Schema.Literal("ignore"),
    ...SlackReference.fields,
    ignored: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("import"),
    ...SlackReference.fields,
    projectId: Schema.NullOr(ProjectId),
    repository: Schema.NullOr(Text),
    priority: WorkItemPriority,
  }),
  Schema.Struct({
    kind: Schema.Literal("attach"),
    ...SlackReference.fields,
    workItemId: WorkItemId,
    expectedRevision: NonNegativeInt,
  }),
]);
export type SlackMutation = typeof SlackMutation.Type;
export const SlackMutationResult = Schema.Struct({
  workItemId: Schema.NullOr(WorkItemId),
  hasMore: Schema.Boolean,
});
export class SlackError extends Schema.TaggedError<SlackError>()("SlackError", {
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
}) {}
