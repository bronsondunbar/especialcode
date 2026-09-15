import { AutomationExecutionPolicy, AutomationControl } from "./automationExecution.ts";
import * as Schema from "effect/Schema";
import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./orchestration.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import {
  WorkItemId,
  WorkItemStatus,
  WORK_ITEM_MANUAL_STATUSES,
  WORK_ITEM_VIEWS,
} from "./workItems.ts";
const Text = TrimmedNonEmptyString.check(Schema.isMaxLength(500));
export const AUTOMATION_TRIGGERS = [
  { id: "github_issue_synced", label: "GitHub issue first synced" },
  { id: "github_issue_imported", label: "GitHub issue imported" },
  { id: "github_label_changed", label: "GitHub labels changed" },
  { id: "work_item_status_changed", label: "WorkItem status changed" },
  { id: "plan_approved", label: "Plan approved" },
  { id: "pr_changes_requested", label: "PR changes requested" },
  { id: "pr_checks_failed", label: "PR checks failed" },
  { id: "slack_work_item_created", label: "Slack WorkItem created" },
] as const;
export const AutomationTrigger = Schema.Literals(AUTOMATION_TRIGGERS.map((t) => t.id));
export type AutomationTrigger = typeof AutomationTrigger.Type;
export const AUTOMATION_CONDITION_STATUSES = [
  ...new Set(WORK_ITEM_VIEWS.flatMap((view) => [...view.statuses])),
];
export const AutomationConditions = Schema.Struct({
  repository: Schema.optionalKey(Text),
  label: Schema.optionalKey(Text),
  status: Schema.optionalKey(WorkItemStatus),
  hasAgentThread: Schema.optionalKey(Schema.Boolean),
});
// Execution uses a separate trusted policy. No action can merge a PR.
export const AutomationAction = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("execute_approved"),
    modelSelection: ModelSelection,
    validationCommands: Schema.Array(
      Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4000)),
    ).check(Schema.isMaxLength(10)),
  }),
  Schema.Struct({ kind: Schema.Literal("import_work_item") }),
  Schema.Struct({
    kind: Schema.Literal("change_status"),
    status: Schema.Literals(WORK_ITEM_MANUAL_STATUSES),
  }),
  Schema.Struct({ kind: Schema.Literal("assign_provider"), instanceId: ProviderInstanceId }),
  Schema.Struct({ kind: Schema.Literal("generate_plan"), modelSelection: ModelSelection }),
  Schema.Struct({ kind: Schema.Literal("notify"), message: Text }),
]);
export type AutomationAction = typeof AutomationAction.Type;
export const AutomationConfig = Schema.Struct({
  execution: Schema.optionalKey(AutomationExecutionPolicy),
  name: Text,
  enabled: Schema.Boolean,
  trigger: AutomationTrigger,
  conditions: AutomationConditions,
  actions: Schema.Array(AutomationAction).check(Schema.isMinLength(1), Schema.isMaxLength(10)),
});
export type AutomationConfig = typeof AutomationConfig.Type;
export const AutomationRule = Schema.Struct({
  ...AutomationConfig.fields,
  id: Text,
  revision: PositiveInt,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type AutomationRule = typeof AutomationRule.Type;
export const AutomationRun = Schema.Struct({
  id: Text,
  ruleId: Text,
  ruleName: Text,
  ruleRevision: PositiveInt,
  trigger: AutomationTrigger,
  workItemId: Schema.NullOr(WorkItemId),
  executionId: Schema.optionalKey(Text),
  status: Schema.Literals(["pending", "running", "waiting", "succeeded", "failed", "cancelled"]),
  completedActions: NonNegativeInt,
  actionCount: PositiveInt,
  createdAt: Schema.String,
  completedAt: Schema.NullOr(Schema.String),
  message: Schema.String.check(Schema.isMaxLength(1000)),
});
export type AutomationRun = typeof AutomationRun.Type;
export const AutomationListInput = Schema.Struct({
  ruleId: Schema.optionalKey(Text),
  offset: Schema.optionalKey(NonNegativeInt),
  limit: Schema.optionalKey(PositiveInt.check(Schema.isLessThanOrEqualTo(100))),
});
export type AutomationListInput = typeof AutomationListInput.Type;
export const AutomationPage = Schema.Struct({
  control: Schema.optionalKey(AutomationControl),
  rules: Schema.Array(
    Schema.Struct({ ...AutomationRule.fields, lastRun: Schema.NullOr(AutomationRun) }),
  ),
  runs: Schema.Array(AutomationRun),
  total: NonNegativeInt,
});
export const AutomationMutation = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("save"),
    id: Text,
    expectedRevision: NonNegativeInt,
    value: AutomationConfig,
  }),
  Schema.Struct({ kind: Schema.Literal("delete"), id: Text, expectedRevision: PositiveInt }),
]);
export type AutomationMutation = typeof AutomationMutation.Type;
export class AutomationError extends Schema.TaggedError<AutomationError>()("AutomationError", {
  message: Schema.String,
}) {}
