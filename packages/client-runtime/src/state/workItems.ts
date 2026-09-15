import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/unstable/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/** Shared environment-scoped transport, including reconnect/resubscribe behavior. */
export function createWorkItemAtoms<R, E>(runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>) {
  return {
    list: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "work-items:list",
      tag: WS_METHODS.workItemsSubscribe,
      idleTtlMs: 0,
    }),
    get: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "work-items:get",
      tag: WS_METHODS.workItemsGet,
      staleTimeMs: 0,
    }),
    mutate: createEnvironmentRpcCommand(runtime, {
      label: "work-items:mutate",
      tag: WS_METHODS.workItemsMutate,
    }),
    read: createEnvironmentRpcCommand(runtime, {
      label: "work-items:read",
      tag: WS_METHODS.workItemsGet,
    }),
  };
}

/** GitHub data is read and synchronized by the selected environment, never by the client. */
export function createGitHubIssueAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    list: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "github-issues:list",
      tag: WS_METHODS.githubIssuesSubscribe,
      idleTtlMs: 0,
    }),
    read: createEnvironmentRpcCommand(runtime, {
      label: "github-issues:read",
      tag: WS_METHODS.githubIssuesGet,
    }),
    mutate: createEnvironmentRpcCommand(runtime, {
      label: "github-issues:mutate",
      tag: WS_METHODS.githubIssuesMutate,
    }),
  };
}

export function createWorkPlanAtoms<R, E>(runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>) {
  return {
    get: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "work-plans:get",
      tag: WS_METHODS.workPlansSubscribe,
      idleTtlMs: 0,
    }),
    mutate: createEnvironmentRpcCommand(runtime, {
      label: "work-plans:mutate",
      tag: WS_METHODS.workPlansMutate,
    }),
  };
}

export function createWorkExecutionAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    get: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "work-executions:get",
      tag: WS_METHODS.workExecutionsSubscribe,
      idleTtlMs: 0,
    }),
    mutate: createEnvironmentRpcCommand(runtime, {
      label: "work-executions:mutate",
      tag: WS_METHODS.workExecutionsMutate,
    }),
  };
}

export function createWorkPullRequestAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    get: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "work-pr:get",
      tag: WS_METHODS.workPullRequestsSubscribe,
      idleTtlMs: 0,
    }),
    mutate: createEnvironmentRpcCommand(runtime, {
      label: "work-pr:mutate",
      tag: WS_METHODS.workPullRequestsMutate,
    }),
  };
}

export function createWorkReviewAtoms<R, E>(runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>) {
  return {
    get: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "work-review:get",
      tag: WS_METHODS.workReviewsSubscribe,
      idleTtlMs: 0,
    }),
    mutate: createEnvironmentRpcCommand(runtime, {
      label: "work-review:mutate",
      tag: WS_METHODS.workReviewsMutate,
    }),
  };
}

export function createNotificationAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    list: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "notifications:list",
      tag: WS_METHODS.notificationsSubscribe,
      idleTtlMs: 0,
    }),
    mutate: createEnvironmentRpcCommand(runtime, {
      label: "notifications:mutate",
      tag: WS_METHODS.notificationsMutate,
    }),
  };
}

export function notificationActionLabel(type: string): string {
  if (type === "agent_input_required") return "Open agent";
  if (type === "pr_check_failed") return "Review checks and send to agent";
  if (type === "pr_changes_requested") return "Review feedback and send to agent";
  if (type === "agent_execution_completed") return "Review changes";
  if (type === "agent_plan_completed") return "Review plan";
  return "Open details";
}

export { consumeNotificationPage, claimNotificationDelivery } from "./notificationDelivery.ts";

export function createSlackAtoms<R, E>(runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>) {
  return {
    read: createEnvironmentRpcCommand(runtime, { label: "slack:read", tag: WS_METHODS.slackGet }),
    list: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "slack:list",
      tag: WS_METHODS.slackSubscribe,
      idleTtlMs: 0,
    }),
    mutate: createEnvironmentRpcCommand(runtime, {
      label: "slack:mutate",
      tag: WS_METHODS.slackMutate,
    }),
    admin: createEnvironmentRpcCommand(runtime, {
      label: "slack:admin",
      tag: WS_METHODS.slackAdmin,
    }),
  };
}

export function createWorkActivityAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    list: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "work-activity:list",
      tag: WS_METHODS.workActivitySubscribe,
      idleTtlMs: 0,
    }),
  };
}

export function createWorkAutomationAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    control: createEnvironmentRpcCommand(runtime, {
      label: "work-automations:control",
      tag: WS_METHODS.workAutomationsControl,
    }),
    list: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "work-automations:list",
      tag: WS_METHODS.workAutomationsSubscribe,
      idleTtlMs: 0,
    }),
    mutate: createEnvironmentRpcCommand(runtime, {
      label: "work-automations:mutate",
      tag: WS_METHODS.workAutomationsMutate,
    }),
  };
}

export function createWorkDashboardAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    list: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "work-dashboard:list",
      tag: WS_METHODS.workDashboardSubscribe,
      idleTtlMs: 0,
    }),
  };
}
