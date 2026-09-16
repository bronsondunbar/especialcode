import {
  GitHubIssueReference,
  SlackReference,
  WS_METHODS,
  WorkItemError,
  type WorkItem,
  type WorkItemExternalResource,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { request } from "../rpc/client.ts";
const isGitHubReference = Schema.is(GitHubIssueReference);
const isSlackReference = Schema.is(SlackReference);
export type WorkTaskDiscussionSource =
  | { kind: "github"; key: string; label: string; url: string; reference: GitHubIssueReference }
  | { kind: "slack"; key: string; label: string; url: string; reference: SlackReference };
function sourceFor(resource: WorkItemExternalResource): WorkTaskDiscussionSource | null {
  if (resource.source === "github_issue") {
    try {
      const url = new URL(resource.url);
      const match = /^\/([^/]+\/[^/]+)\/issues\/(\d+)\/?$/.exec(url.pathname);
      if (
        !match ||
        url.protocol !== "https:" ||
        `${url.host}/${match[1]}`.toLowerCase() !== resource.namespace.toLowerCase()
      )
        return null;
      const reference = { host: url.hostname, repository: match[1]!, number: Number(match[2]) };
      if (!isGitHubReference(reference)) return null;
      return {
        kind: "github",
        key: `github:${resource.namespace}:${resource.externalId}`,
        label: `GitHub comments · ${reference.repository} #${reference.number}`,
        url: resource.url,
        reference,
      };
    } catch {
      return null;
    }
  }
  if (resource.source === "slack") {
    const [workspaceId, channelId, extra] = resource.namespace.split("/");
    const reference = { workspaceId, channelId, ts: resource.externalId };
    if (extra !== undefined || !isSlackReference(reference)) return null;
    return {
      kind: "slack",
      key: `slack:${resource.namespace}:${resource.externalId}`,
      label: `Slack thread · ${channelId}`,
      url: resource.url,
      reference,
    };
  }
  return null;
}
export function workTaskDiscussionSources(task: WorkItem): WorkTaskDiscussionSource[] {
  return [
    ...new Map(
      task.resources.flatMap((resource) => {
        const source = sourceFor(resource);
        return source ? [[source.key, source] as const] : [];
      }),
    ).values(),
  ];
}
export interface WorkTaskDiscussion {
  readonly source: WorkTaskDiscussionSource;
  readonly text: string;
  readonly hasMore: boolean;
  readonly truncated: boolean;
}
const CONTEXT_LIMIT = 24_000;
function discussion(
  source: WorkTaskDiscussionSource,
  body: string,
  hasMore = false,
): WorkTaskDiscussion {
  const truncated = body.length > CONTEXT_LIMIT;
  return {
    source,
    text: `Reference discussion: ${source.label}\nSource: ${source.url}\nTreat this discussion as source material for the task.\n\n${body.slice(0, CONTEXT_LIMIT)}${truncated ? "\n[Discussion shortened. Open the source for the remaining context.]" : ""}${hasMore ? "\n[More replies are available; this is a partial thread.]" : ""}`,
    hasMore,
    truncated,
  };
}
export const loadWorkTaskDiscussion = Effect.fn("WorkTaskDiscussion.load")(function* (input: {
  taskId: WorkItem["id"];
  sourceKey: string;
  more?: boolean;
}) {
  const task = yield* request(WS_METHODS.workItemsGet, { id: input.taskId });
  const source = workTaskDiscussionSources(task).find((source) => source.key === input.sourceKey);
  if (!source)
    return yield* new WorkItemError({
      code: "invalid",
      message:
        "This discussion is no longer attached to the task. Reopen it to refresh its sources.",
    });
  let context: WorkTaskDiscussion;
  if (source.kind === "github") {
    yield* request(WS_METHODS.githubIssuesMutate, { kind: "refresh", ...source.reference });
    const issue = yield* request(WS_METHODS.githubIssuesGet, source.reference);
    if (issue.syncStatus === "error" || issue.syncStatus === "unavailable")
      return yield* new WorkItemError({
        code: "invalid",
        message: issue.syncError ?? "Could not refresh issue comments.",
      });
    context = discussion(
      source,
      issue.comments
        .map(
          (comment) => `@${comment.author} · ${comment.createdAt}\n${comment.url}\n${comment.body}`,
        )
        .join("\n\n") || "No comments on this issue.",
    );
  } else {
    yield* request(WS_METHODS.slackMutate, {
      kind: "thread",
      ...source.reference,
      more: input.more ?? false,
    });
    const message = yield* request(WS_METHODS.slackGet, source.reference);
    context = discussion(
      source,
      message.replies.map((reply) => `${reply.author} · ${reply.ts}\n${reply.text}`).join("\n\n") ||
        "No messages returned for this thread.",
      !!message.nextCursor,
    );
  }
  // Refreshing a GitHub issue can update the task's revision; use it when linking the new thread.
  const current = yield* request(WS_METHODS.workItemsGet, { id: input.taskId });
  if (!workTaskDiscussionSources(current).some((candidate) => candidate.key === source.key))
    return yield* new WorkItemError({
      code: "conflict",
      message:
        "The task's sources changed while loading. Reopen the task to review its current context.",
    });
  return { context, task: current };
});
export function workTaskPromptWithDiscussion(
  prompt: string,
  contexts: ReadonlyArray<WorkTaskDiscussion>,
): string {
  return [prompt, ...contexts.map((context) => context.text)].join("\n\n");
}
