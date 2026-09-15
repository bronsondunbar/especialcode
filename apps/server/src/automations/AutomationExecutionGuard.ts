import {
  AutomationRule,
  GitHubIssue,
  WorkExecutionError,
  type AutomationExecutionOwner,
  type WorkItem,
  type WorkPlan,
  type ModelSelection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
const decodeRule = Schema.decodeUnknownEffect(Schema.fromJsonString(AutomationRule));
const decodeIssue = Schema.decodeUnknownEffect(Schema.fromJsonString(GitHubIssue));
const invalid = (message: string) => new WorkExecutionError({ code: "invalid", message });
export type AutomationAdmission = Pick<
  AutomationExecutionOwner,
  "ruleId" | "runId" | "ruleRevision"
>;
/** Called inside the execution admission transaction, so concurrent starts cannot exceed the rule limit. */
export const admitAutomation = Effect.fn("admitAutomation")(function* (
  owner: AutomationAdmission,
  item: WorkItem,
  plan: WorkPlan | null,
  selection: ModelSelection,
  commands: ReadonlyArray<string>,
) {
  const sql = yield* SqlClient.SqlClient;
  if (
    (yield* sql<{ paused: number }>`SELECT paused FROM work_automation_control WHERE id=1`)[0]
      ?.paused !== 0
  )
    return yield* invalid("Automations are stopped. Resume them in settings first.");
  const rows = yield* sql<{
    record_json: string;
  }>`SELECT record_json FROM work_automation_rules WHERE id=${owner.ruleId}`;
  const rule = rows[0] ? yield* decodeRule(rows[0].record_json) : null;
  const policy = rule?.execution;
  if (!rule?.enabled || rule.revision !== owner.ruleRevision || !policy?.trusted)
    return yield* invalid("This rule is no longer enabled and trusted for execution.");
  if (
    !plan?.content ||
    plan.status !== "approved" ||
    plan.approvedWorkItemRevision !== item.revision
  )
    return yield* invalid("Autonomous execution requires a current, explicitly approved plan.");
  if (!policy.allowedProviders.includes(selection.instanceId))
    return yield* invalid("The execution provider is outside this rule's allowlist.");
  if (policy.requireTests && !commands.length)
    return yield* invalid("This rule requires at least one validation command.");
  const resource = item.resources.find(
    (r) =>
      r.source === "github_issue" &&
      policy.allowedRepositories.some(
        (repo) => `${repo.host}/${repo.repository}`.toLowerCase() === r.namespace.toLowerCase(),
      ),
  );
  if (!resource) return yield* invalid("The WorkItem needs an issue from an allowed repository.");
  const cached = yield* sql<{
    record_json: string;
    project_id: string | null;
    repo_sync_status: string | null;
  }>`SELECT i.record_json,json_extract(r.record_json,'$.projectId') AS project_id,json_extract(r.record_json,'$.syncStatus') AS repo_sync_status FROM github_issues i JOIN github_tracked_repositories r ON r.namespace=i.namespace WHERE i.namespace=${resource.namespace} AND i.external_id=${resource.externalId}`;
  const issue = cached[0] ? yield* decodeIssue(cached[0].record_json) : null;
  if (
    !issue ||
    issue.syncStatus === "unavailable" ||
    issue.syncStatus === "error" ||
    cached[0]?.repo_sync_status === "error" ||
    !item.projectId ||
    cached[0]?.project_id !== item.projectId ||
    issue.state !== "open" ||
    !issue.labels.some((label) => policy.allowedLabels.includes(label))
  )
    return yield* invalid(
      "The issue must be open, have an allowed label, and belong to its tracked project. Sync and review it first.",
    );
  const count = (yield* sql<{
    n: number;
  }>`SELECT count(*) AS n FROM work_item_executions WHERE json_extract(record_json,'$.automation.ruleId')=${rule.id} AND status IN ('preparing','running','validating','publishing','stopping')`)[0]!
    .n;
  if (count >= policy.maxConcurrentRuns)
    return yield* new WorkExecutionError({
      code: "capacity",
      message: "Waiting for this rule's execution capacity.",
    });
  return {
    ...owner,
    repository: { host: issue.host, repository: issue.repository },
    permissionMode: policy.permissionMode,
    requireTests: policy.requireTests,
    requirePullRequest: policy.requirePullRequest,
  } satisfies AutomationExecutionOwner;
});
