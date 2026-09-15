import * as NodeCrypto from "node:crypto";
import type { ApplicationEvent, AppNotification, WorkItem } from "@t3tools/contracts";

/** Quiet lifecycle events remain in the event log without adding inbox noise. */
export function notificationPriority(type: string): AppNotification["priority"] | null {
  switch (type) {
    case "agent_execution_failed":
    case "automation_failed":
    case "pr_check_failed":
      return "urgent";
    case "agent_input_required":
    case "agent_plan_completed":
    case "agent_plan_failed":
    case "pr_changes_requested":
    case "pr_review_requested":
    case "slack_mention_received":
      return "attention";
    case "automation_notification":
    case "agent_execution_completed":
    case "pr_created":
    case "pr_approved":
    case "pr_merged":
      return "info";
    default:
      return null;
  }
}
const workTypes: Record<string, string> = {
  "work_item.create": "work_item_created",
  "work_item.status": "work_item_status_changed",
  "work_item.plan_approve": "agent_plan_approved",
  "work_item.plan_reject": "agent_plan_rejected",
  "work_item.plan_cancel": "agent_plan_cancelled",
  "work_item.plan_edit": "agent_plan_updated",
  "work_item.execution_stopped": "agent_execution_stopped",
  "work_item.review_stopped": "agent_execution_stopped",
  "work_item.plan_start": "agent_plan_started",
  "work_item.plan_generated": "agent_plan_completed",
  "work_item.plan_failed": "agent_plan_failed",
  "work_item.execution_started": "agent_execution_started",
  "work_item.review_started": "agent_execution_started",
  "work_item.execution_succeeded": "agent_execution_completed",
  "work_item.review_succeeded": "agent_execution_completed",
  "work_item.execution_failed": "agent_execution_failed",
  "work_item.review_failed": "agent_execution_failed",
};
const titles: Record<string, string> = {
  agent_plan_completed: "Plan ready for approval",
  agent_plan_failed: "Planning failed",
  agent_execution_completed: "Changes ready for review",
  agent_execution_failed: "Agent execution failed",
  pr_created: "Pull request created",
  pr_approved: "Pull request approved",
  pr_changes_requested: "Changes requested",
  pr_review_requested: "Review requested",
  pr_check_failed: "PR check failed",
  pr_merged: "Pull request merged",
};
export function workApplicationEvent(input: {
  commandId: string;
  kind: string;
  item: WorkItem;
  message?: string | undefined;
  assigned?: boolean | undefined;
}): ApplicationEvent {
  const { item, kind } = input;
  const type =
    kind === "work_item.create" && item.source === "github_issue"
      ? "github_issue_imported"
      : input.assigned
        ? "work_item_assigned"
        : (workTypes[kind] ?? kind);
  return {
    id: `work:${NodeCrypto.createHash("sha256").update(input.commandId).digest("hex")}`,
    type,
    source:
      type.startsWith("pr_") || type === "github_issue_imported"
        ? "github"
        : type.startsWith("agent_")
          ? "agents"
          : "work",
    userId: null,
    projectId: item.projectId,
    workItemId: item.id,
    title: titles[type] ?? item.title,
    message:
      `${item.title}${input.message || item.failureReason ? `: ${input.message || item.failureReason}` : ""}`.slice(
        0,
        5000,
      ),
    action:
      type === "agent_execution_completed" && item.agentThreadId
        ? { kind: "changes", threadId: item.agentThreadId }
        : { kind: "work_item", workItemId: item.id },
    createdAt: item.updatedAt,
  };
}

export function notificationDelivery(
  type: string,
  preferences: import("@t3tools/contracts").NotificationPreferences,
) {
  const e = preferences.events;
  let enabled: boolean;
  switch (type) {
    case "agent_input_required":
    case "agent_plan_completed":
      enabled = e.agentInput;
      break;
    case "agent_execution_completed":
      enabled = e.agentCompleted;
      break;
    case "agent_execution_failed":
    case "agent_plan_failed":
      enabled = e.agentFailed;
      break;
    case "pr_review_requested":
      enabled = e.reviewRequested;
      break;
    case "pr_changes_requested":
      enabled = e.changesRequested;
      break;
    case "pr_check_failed":
      enabled = e.checkFailed;
      break;
    case "pr_merged":
      enabled = e.prMerged;
      break;
    case "github_issue_imported":
      enabled = e.issueImported;
      break;
    case "slack_mention_received":
      enabled = e.slackDirect;
      break;
    case "slack_project_mention_received":
      enabled = e.slackProject;
      break;
    case "slack_message_imported":
      enabled = e.slackImported;
      break;
    case "automation_notification":
    case "automation_failed":
    case "pr_created":
    case "pr_approved":
      enabled = true;
      break;
    default:
      enabled = type.startsWith("agent_") && e.agentStatus;
  }
  const highValue = [
    "agent_input_required",
    "agent_plan_completed",
    "agent_plan_failed",
    "agent_execution_failed",
    "agent_execution_completed",
    "pr_review_requested",
    "pr_changes_requested",
    "pr_check_failed",
    "pr_merged",
    "automation_notification",
    "automation_failed",
    "slack_mention_received",
  ].includes(type);
  return {
    inApp: enabled && preferences.delivery.inApp,
    desktop: enabled && highValue && preferences.delivery.desktop,
  };
}
