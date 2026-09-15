import * as Schema from "effect/Schema";
import { PositiveInt, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { GitHubRepositoryKey } from "./githubIssues.ts";
const Text = TrimmedNonEmptyString.check(Schema.isMaxLength(500));
export const AutomationPermissionMode = Schema.Literals(["approval-required", "auto-accept-edits"]);
export const AutomationExecutionPolicy = Schema.Struct({
  trusted: Schema.Boolean,
  allowedRepositories: Schema.Array(GitHubRepositoryKey).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(50),
  ),
  allowedLabels: Schema.Array(Text).check(Schema.isMinLength(1), Schema.isMaxLength(50)),
  allowedProviders: Schema.Array(ProviderInstanceId).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(50),
  ),
  maxConcurrentRuns: PositiveInt.check(Schema.isLessThanOrEqualTo(10)),
  permissionMode: AutomationPermissionMode,
  requireTests: Schema.Boolean,
  requirePullRequest: Schema.Boolean,
});
export type AutomationExecutionPolicy = typeof AutomationExecutionPolicy.Type;
export const AutomationExecutionOwner = Schema.Struct({
  ruleId: Text,
  runId: Text,
  ruleRevision: PositiveInt,
  repository: GitHubRepositoryKey,
  permissionMode: AutomationPermissionMode,
  requireTests: Schema.Boolean,
  requirePullRequest: Schema.Boolean,
});
export type AutomationExecutionOwner = typeof AutomationExecutionOwner.Type;
export const AutomationControl = Schema.Struct({
  paused: Schema.Boolean,
  revision: NonNegativeInt,
});
export const AutomationControlMutation = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("stop_all") }),
  Schema.Struct({ kind: Schema.Literal("resume"), expectedRevision: NonNegativeInt }),
]);
export type AutomationControlMutation = typeof AutomationControlMutation.Type;
