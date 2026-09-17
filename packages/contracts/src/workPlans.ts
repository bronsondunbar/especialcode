import * as Schema from "effect/Schema";
import { PositiveInt, ProjectId, ThreadId } from "./baseSchemas.ts";
import { ModelSelection } from "./orchestration.ts";
import { ServerProvider } from "./server.ts";
import { WorkItem, WorkItemId } from "./workItems.ts";
const Text = Schema.String.check(Schema.isMaxLength(20_000));
const Entries = Schema.Array(Schema.String.check(Schema.isMaxLength(2000))).check(
  Schema.isMaxLength(50),
);
export const WORK_PLAN_SECTIONS = [
  { key: "proposedChanges", label: "Proposed changes" },
  { key: "affectedFiles", label: "Files / modules" },
  { key: "steps", label: "Implementation steps" },
  { key: "tests", label: "Tests required" },
  { key: "risks", label: "Risks" },
  { key: "questions", label: "Questions / unknowns" },
] as const;
export const WorkPlanContent = Schema.Struct({
  summary: Text.check(Schema.isMinLength(1)),
  proposedChanges: Entries,
  affectedFiles: Entries,
  steps: Entries,
  tests: Entries,
  risks: Entries,
  questions: Entries,
  complexity: Schema.Literals(["low", "medium", "high"]),
});
export type WorkPlanContent = typeof WorkPlanContent.Type;
export const WorkPlan = Schema.Struct({
  workItemId: WorkItemId,
  revision: PositiveInt,
  generationId: Schema.String,
  status: Schema.Literals(["generating", "draft", "approved", "rejected", "failed"]),
  modelSelection: ModelSelection,
  agentName: Schema.String,
  threadId: ThreadId,
  createdAt: Schema.String,
  generatedAt: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
  sourceWorkItemRevision: PositiveInt,
  approvedWorkItemRevision: Schema.NullOr(PositiveInt),
  approvedAt: Schema.NullOr(Schema.String),
  content: Schema.NullOr(WorkPlanContent),
  error: Schema.NullOr(Schema.String),
  inspectedFiles: Schema.Array(Schema.String),
});
export type WorkPlan = typeof WorkPlan.Type;
const base = {
  commandId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  id: WorkItemId,
};
export const WorkPlanMutation = Schema.Union([
  Schema.Struct({
    ...base,
    kind: Schema.Literal("start"),
    expectedWorkItemRevision: PositiveInt,
    projectId: Schema.optionalKey(ProjectId),
    modelSelection: ModelSelection,
    feedback: Schema.optionalKey(Text),
  }),
  Schema.Struct({
    ...base,
    kind: Schema.Literal("edit"),
    expectedRevision: PositiveInt,
    content: WorkPlanContent,
  }),
  Schema.Struct({
    ...base,
    kind: Schema.Literals(["approve", "reject", "cancel"]),
    expectedRevision: PositiveInt,
  }),
]);
export type WorkPlanMutation = typeof WorkPlanMutation.Type;
export const WorkPlanState = Schema.Struct({
  item: WorkItem,
  plan: Schema.NullOr(WorkPlan),
  agents: Schema.Array(ServerProvider),
});
export class WorkPlanError extends Schema.TaggedError<WorkPlanError>()("WorkPlanError", {
  code: Schema.Literals(["invalid", "conflict", "unavailable", "storage"]),
  message: Schema.String,
}) {}
