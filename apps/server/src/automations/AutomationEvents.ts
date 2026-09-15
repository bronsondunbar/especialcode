import {
  AutomationTrigger,
  GitHubIssueReference,
  ProjectId,
  WorkItemId,
  WorkItemStatus,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
export const AutomationEvent = Schema.Struct({
  id: Schema.String,
  trigger: AutomationTrigger,
  occurredAt: Schema.String,
  workItemId: Schema.NullOr(WorkItemId),
  projectId: Schema.NullOr(ProjectId),
  title: Schema.String,
  repository: Schema.NullOr(Schema.String),
  labels: Schema.Array(Schema.String),
  status: Schema.NullOr(WorkItemStatus),
  hasAgentThread: Schema.Boolean,
  issue: Schema.NullOr(GitHubIssueReference),
});
export type AutomationEvent = typeof AutomationEvent.Type;
export const encodeEvent = Schema.encodeSync(Schema.fromJsonString(AutomationEvent));
export const decodeEvent = Schema.decodeUnknownEffect(Schema.fromJsonString(AutomationEvent));
export const makeEventRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return {
    append: (event: AutomationEvent) =>
      sql`INSERT INTO work_automation_events(id,record_json) VALUES (${event.id},${encodeEvent(event)}) ON CONFLICT(id) DO NOTHING`,
  };
});
export function matches(
  conditions: import("@t3tools/contracts").AutomationConfig["conditions"],
  event: AutomationEvent,
) {
  return (
    (conditions.repository === undefined ||
      conditions.repository.toLowerCase() === event.repository?.toLowerCase()) &&
    (conditions.label === undefined || event.labels.includes(conditions.label)) &&
    (conditions.status === undefined || conditions.status === event.status) &&
    (conditions.hasAgentThread === undefined || conditions.hasAgentThread === event.hasAgentThread)
  );
}
