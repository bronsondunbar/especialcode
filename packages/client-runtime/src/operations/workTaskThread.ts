import {
  CommandId,
  ORCHESTRATION_WS_METHODS,
  WS_METHODS,
  WorkItemError,
  type ModelSelection,
  type ProjectId,
  type ThreadId,
  type WorkItem,
  type RepositoryIdentity,
  type VcsRef,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { request } from "../rpc/client.ts";

export function workTaskPrompt(task: WorkItem): string {
  const description = task.body.slice(0, 30_000);
  return [
    "Help me work on this task.",
    `Task: ${task.title}\nWork task ID: ${task.id}`,
    description +
      (description.length < task.body.length
        ? "\n[Description shortened; see the original task for the rest.]"
        : ""),
    task.branch ? `Requested branch: ${task.branch}` : "",
    ...task.resources.slice(0, 10).map((resource) => `Source: ${resource.url}`),
  ]
    .filter(Boolean)
    .join("\n\n");
}
/** Prefer an existing task selection, then an exact GitHub repository identity match. */
export function workTaskProjectId(
  task: WorkItem,
  projects: ReadonlyArray<{
    id: ProjectId;
    repositoryIdentity?: RepositoryIdentity | null | undefined;
  }>,
): string {
  if (projects.some((project) => project.id === task.projectId)) return task.projectId!;
  const keys = new Set(
    task.resources
      .filter((resource) => resource.source === "github_issue")
      .flatMap((resource) => {
        try {
          const url = new URL(resource.url);
          const match = /^\/([^/]+)\/([^/]+)\/issues\/\d+\/?$/.exec(url.pathname);
          return match ? [`${url.hostname}/${match[1]}/${match[2]}`.toLowerCase()] : [];
        } catch {
          return [];
        }
      }),
  );
  const matches = projects.filter((project) =>
    keys.has(project.repositoryIdentity?.canonicalKey.toLowerCase() ?? ""),
  );
  return matches.length === 1 ? matches[0]!.id : projects.length === 1 ? projects[0]!.id : "";
}

export function workTaskBranchName(task: WorkItem): string {
  const words =
    task.title
      .replace(/<[^>]+>|https?:\/\S+/g, " ")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .match(/[a-z0-9]+/g) ?? [];
  let slug = "";
  for (const word of words.slice(0, 8)) {
    if (slug.length + word.length + 1 > 55) break;
    slug += (slug ? "-" : "") + word;
  }
  return `codex/${slug || "work-task"}`;
}

export function workTaskBranchError(name: string): string | null {
  if (
    !name ||
    name.length > 200 ||
    name.startsWith("-") ||
    name === "@" ||
    /[\s\p{Cc}~^:?*[\\]/u.test(name) ||
    name.includes("..") ||
    name.includes("@{") ||
    name
      .split("/")
      .some((part) => !part || part.startsWith(".") || part.endsWith(".") || part.endsWith(".lock"))
  )
    return "Enter a valid branch name without spaces or Git special characters.";
  return null;
}

export const workTaskBranches = Effect.fn("WorkTaskThread.branches")(function* (input: {
  cwd: string | null;
}) {
  const refs: VcsRef[] = [];
  if (!input.cwd) return refs;
  let cursor: number | undefined;
  do {
    const page = yield* request(WS_METHODS.vcsListRefs, {
      cwd: input.cwd,
      refKind: "all",
      includeMatchingRemoteRefs: true,
      limit: 200,
      ...(cursor === undefined ? {} : { cursor }),
    });
    refs.push(...page.refs);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return refs;
});

export const prepareWorkTaskBranch = Effect.fn("WorkTaskThread.prepareBranch")(function* (input: {
  task: WorkItem;
  cwd: string;
  baseBranch: string;
  branch: string;
}) {
  const current = yield* request(WS_METHODS.workItemsGet, { id: input.task.id });
  if (current.revision !== input.task.revision || current.archivedAt)
    return yield* new WorkItemError({
      code: "conflict",
      message: "This task changed. Close this dialog and reopen it to use the latest version.",
    });
  const error = workTaskBranchError(input.branch);
  if (error) return yield* new WorkItemError({ code: "conflict", message: error });
  return yield* request(WS_METHODS.vcsCreateWorktree, {
    cwd: input.cwd,
    refName: input.baseBranch,
    newRefName: input.branch,
    baseRefName: input.baseBranch,
    path: null,
  });
});

export interface WorkTaskThreadInput {
  readonly task: WorkItem;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly modelSelection: ModelSelection;
  readonly createdAt: string;
  readonly worktree?: { readonly path: string; readonly refName: string };
}
/** Creates an idle thread. Sending the editable prompt stays an explicit composer action. */
export const startWorkTaskThread = Effect.fn("WorkTaskThread.start")(function* (
  input: WorkTaskThreadInput,
) {
  const current = yield* request(WS_METHODS.workItemsGet, { id: input.task.id });
  if (current.agentThreadId === input.threadId) return { threadId: input.threadId, warning: null };
  if (current.revision !== input.task.revision || current.archivedAt)
    return yield* new WorkItemError({
      code: "conflict",
      message: "This task changed. Close this dialog and reopen it to use the latest version.",
    });
  yield* request(ORCHESTRATION_WS_METHODS.dispatchCommand, {
    type: "thread.create",
    commandId: CommandId.make(`work-thread:${input.threadId}`),
    threadId: input.threadId,
    projectId: input.projectId,
    title: input.task.title,
    modelSelection: input.modelSelection,
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: input.worktree?.refName ?? null,
    worktreePath: input.worktree?.path ?? null,
    createdAt: input.createdAt,
  });
  const linked = yield* request(WS_METHODS.workItemsMutate, {
    kind: "update",
    id: input.task.id,
    commandId: `work-thread-link:${input.threadId}`,
    expectedRevision: input.task.revision,
    patch: {
      projectId: input.projectId,
      agentThreadId: input.threadId,
      ...(input.worktree ? { branch: input.worktree.refName } : {}),
    },
  }).pipe(Effect.result);
  // Creation already succeeded. Keep that thread usable if a concurrent task edit prevents linking.
  return {
    threadId: input.threadId,
    warning:
      linked._tag === "Failure"
        ? "Thread created, but the task could not be linked. You can link it using Edit task."
        : null,
  };
});
