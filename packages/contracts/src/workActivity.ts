import * as Schema from "effect/Schema";
import { IsoDateTime, NonNegativeInt, PositiveInt, ThreadId } from "./baseSchemas.ts";
import { WorkItemId } from "./workItems.ts";
const Text = Schema.String.check(Schema.isMaxLength(500));
export const WorkActivityEvent = Schema.Struct({
  id: Text,
  workItemId: WorkItemId,
  kind: Text,
  source: Schema.Literals(["work", "github", "slack", "agents", "ci", "system"]),
  occurredAt: IsoDateTime,
  title: Text,
  summary: Schema.String.check(Schema.isMaxLength(1000)),
  threadId: Schema.NullOr(ThreadId),
  url: Schema.NullOr(
    Schema.String.check(Schema.isMaxLength(2048), Schema.isPattern(/^https?:\/\//)),
  ),
  details: Schema.Array(Schema.Struct({ label: Text, value: Text })).check(Schema.isMaxLength(8)),
});
export type WorkActivityEvent = typeof WorkActivityEvent.Type;
export const WorkActivityCursor = Schema.Struct({ occurredAt: IsoDateTime, sequence: PositiveInt });
export const WorkActivityInput = Schema.Struct({
  id: WorkItemId,
  before: Schema.optionalKey(WorkActivityCursor),
  throughSequence: Schema.optionalKey(NonNegativeInt),
  limit: Schema.optionalKey(PositiveInt.check(Schema.isLessThanOrEqualTo(100))),
});
export type WorkActivityInput = typeof WorkActivityInput.Type;
export const WorkActivityPage = Schema.Struct({
  items: Schema.Array(Schema.Struct({ ...WorkActivityEvent.fields, sequence: PositiveInt })),
  nextCursor: Schema.NullOr(WorkActivityCursor),
  throughSequence: NonNegativeInt,
  total: NonNegativeInt,
});
export class WorkActivityError extends Schema.TaggedError<WorkActivityError>()(
  "WorkActivityError",
  { message: Schema.String },
) {}
