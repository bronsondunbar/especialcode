import {
  CommandId,
  ORCHESTRATION_WS_METHODS,
  WS_METHODS,
  type ProjectId,
  type WorkItem,
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

/** Clone on the selected environment, then register a project without starting an agent. */
export const cloneWorkRepository = Effect.fn("WorkRepository.clone")(function* (input: {
  repository: string;
  destinationPath: string;
  projectId: ProjectId;
  createdAt: string;
  clonedCwd?: string;
}) {
  const cwd =
    input.clonedCwd ??
    (yield* request(WS_METHODS.sourceControlCloneRepository, {
      connectedGitHubRepository: input.repository,
      destinationPath: input.destinationPath,
    })).cwd;
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
