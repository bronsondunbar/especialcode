import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import {
  CommandId,
  ORCHESTRATION_WS_METHODS,
  WS_METHODS,
  type ProjectId,
  type WorkItem,
  type RepositoryIdentity,
  type GitHubAccountRepository,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { request } from "../rpc/client.ts";

export function workTaskGitHubRepository(item: WorkItem | undefined): string | null {
  for (const source of item?.resources ?? []) {
    if (source.source !== "github_issue") continue;
    try {
      const url = new URL(source.url);
      const match = /^\/([^/]+\/[^/]+)\/issues\/\d+\/?$/.exec(url.pathname);
      if (url.hostname === "github.com" && match) return match[1]!;
    } catch {
      /* Ignore malformed source URLs. */
    }
  }
  return null;
}

/** Reuse or clone a checkout on the selected environment, then register it without starting an agent. */
export const cloneWorkRepository = Effect.fn("WorkRepository.clone")(function* (input: {
  repository: string;
  destinationPath: string;
  projectId: ProjectId;
  createdAt: string;
  clonedCwd?: string;
  useExisting?: boolean;
  projects?: ReadonlyArray<{ id: ProjectId; workspaceRoot: string }>;
}) {
  const cwd = input.useExisting
    ? (yield* request(WS_METHODS.sourceControlExistingRepository, {
        cwd: input.destinationPath,
        repository: input.repository,
      })).cwd
    : (input.clonedCwd ??
      (yield* request(WS_METHODS.sourceControlCloneRepository, {
        connectedGitHubRepository: input.repository,
        destinationPath: input.destinationPath,
      })).cwd);
  const existing = input.projects?.find(
    (project) =>
      normalizeProjectPathForComparison(project.workspaceRoot) ===
      normalizeProjectPathForComparison(cwd),
  );
  if (existing) return { cwd, projectId: existing.id, registered: true };
  const created = yield* request(ORCHESTRATION_WS_METHODS.dispatchCommand, {
    type: "project.create",
    commandId: CommandId.make(`work-repository:${input.projectId}`),
    projectId: input.projectId,
    title: input.repository.split("/").at(-1)!,
    workspaceRoot: cwd,
    createdAt: input.createdAt,
  }).pipe(Effect.result);
  // Keep the successful clone for a registration retry, without overwriting or cloning it again.
  return { cwd, projectId: input.projectId, registered: created._tag === "Success" };
});

export interface WorkRepositoryProject {
  id: ProjectId;
  title: string;
  workspaceRoot: string;
  repositoryIdentity?: RepositoryIdentity | null | undefined;
}

export function workRepositoryValue(project: WorkRepositoryProject): string {
  const key = project.repositoryIdentity?.canonicalKey.toLowerCase();
  return key?.startsWith("github.com/") ? `github:${key.slice(11)}` : project.id;
}

/** Saved projects are the clone registry, shared across devices connected to this server. */
export function workRepositoryProjectId(
  value: string,
  projects: readonly WorkRepositoryProject[],
  preferred?: ProjectId | null,
): ProjectId | null {
  const matches = projects.filter(
    (project) => project.id === value || workRepositoryValue(project) === value.toLowerCase(),
  );
  return (
    matches.find((project) => project.id === preferred)?.id ??
    matches.sort((a, b) => a.id.localeCompare(b.id))[0]?.id ??
    null
  );
}

export function workRepositoryChoices(
  projects: readonly WorkRepositoryProject[],
  repositories: readonly GitHubAccountRepository[],
  selected: string,
) {
  const choices = new Map<string, { value: string; label: string }>();
  for (const project of projects) {
    const value = workRepositoryValue(project);
    choices.set(value, {
      value,
      label: value.startsWith("github:")
        ? value.slice(7)
        : `${project.title} — ${project.workspaceRoot}`,
    });
  }
  for (const repo of repositories) {
    const value = `github:${repo.repository.toLowerCase()}`;
    choices.set(value, { value, label: repo.repository });
  }
  if (selected.startsWith("github:") && !choices.has(selected))
    choices.set(selected, { value: selected, label: selected.slice(7) });
  return [...choices.values()].sort((a, b) => a.label.localeCompare(b.label));
}
