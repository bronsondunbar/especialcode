import { AutomationExecutionOwner } from "./automationExecution.ts";
import { PullRequestRef } from "./pullRequest.ts";
import * as Schema from "effect/Schema";
import { PositiveInt, ProjectId, ThreadId, TurnId } from "./baseSchemas.ts";
import { ModelSelection } from "./orchestration.ts";
import { ServerProvider } from "./server.ts";
import { WorkItem, WorkItemId } from "./workItems.ts";
const Command = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4000));
export const WorkValidationCommands = Schema.Array(Command).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(10),
);
export const WorkValidationResult = Schema.Struct({
  command: Command,
  exitCode: Schema.NullOr(Schema.Int),
  output: Schema.String,
  startedAt: Schema.String,
  completedAt: Schema.String,
  timedOut: Schema.Boolean,
});
export const WorkExecution = Schema.Struct({
  automation: Schema.optionalKey(AutomationExecutionOwner),
  review: Schema.optional(
    Schema.Struct({
      reference: PullRequestRef,
      feedbackFingerprint: Schema.String,
      feedback: Schema.String,
      previousUserMessageIds: Schema.Array(Schema.String),
      previousTurnId: Schema.NullOr(TurnId),
    }),
  ),
  id: Schema.String,
  workItemId: WorkItemId,
  revision: PositiveInt,
  planRevision: Schema.NullOr(PositiveInt),
  guidance: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(20000))),
  threadId: ThreadId,
  turnId: Schema.NullOr(TurnId),
  modelSelection: ModelSelection,
  agentName: Schema.String,
  branch: Schema.String,
  baseRef: Schema.String,
  worktreePath: Schema.NullOr(Schema.String),
  threadReady: Schema.Boolean,
  status: Schema.Literals([
    "preparing",
    "running",
    "validating",
    "publishing",
    "stopping",
    "succeeded",
    "failed",
    "stopped",
  ]),
  activity: Schema.String,
  error: Schema.NullOr(Schema.String),
  startedAt: Schema.String,
  updatedAt: Schema.String,
  completedAt: Schema.NullOr(Schema.String),
  validationCommands: Schema.Array(Command).check(Schema.isMaxLength(10)),
  validationResults: Schema.Array(WorkValidationResult),
  changedFiles: Schema.Array(Schema.String),
});
export type WorkExecution = typeof WorkExecution.Type;
export const WorkExecutionMutation = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("start"),
    commandId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
    id: WorkItemId,
    expectedWorkItemRevision: PositiveInt,
    projectId: Schema.optionalKey(ProjectId),
    expectedPlanRevision: Schema.NullOr(PositiveInt),
    guidance: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(20000))),
    modelSelection: ModelSelection,
    validationCommands: Schema.Array(Command).check(Schema.isMaxLength(10)),
  }),
  Schema.Struct({
    kind: Schema.Literal("stop"),
    commandId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
    id: WorkItemId,
    expectedRevision: PositiveInt,
  }),
]);
export type WorkExecutionMutation = typeof WorkExecutionMutation.Type;
export const WorkExecutionState = Schema.Struct({
  item: WorkItem,
  execution: Schema.NullOr(WorkExecution),
  agents: Schema.Array(ServerProvider),
});
export class WorkExecutionError extends Schema.TaggedError<WorkExecutionError>()(
  "WorkExecutionError",
  {
    code: Schema.Literals(["invalid", "conflict", "unavailable", "storage", "capacity"]),
    message: Schema.String,
  },
) {}
