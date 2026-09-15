import {
  createWorkItemAtoms,
  createWorkPlanAtoms,
  createGitHubIssueAtoms,
} from "@t3tools/client-runtime/state/work-items";
import { connectionAtomRuntime } from "../connection/runtime";

export const workItems = createWorkItemAtoms(connectionAtomRuntime);

export const githubIssues = createGitHubIssueAtoms(connectionAtomRuntime);

export const workPlans = createWorkPlanAtoms(connectionAtomRuntime);
