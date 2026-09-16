import * as Schema from "effect/Schema";
import { ThreadId } from "./baseSchemas.ts";
import { WorkItemId, type WorkItem, type WorkItemExternalResource } from "./workItems.ts";
import { GitHubIssueReference } from "./githubIssues.ts";
import { SlackReference } from "./slack.ts";

export const WorkTaskUpdateInput = Schema.Struct({
  taskId: WorkItemId,
  threadId: ThreadId,
  sourceKey: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1500)),
  body: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4000)),
  commandId: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9-]{1,100}$/)),
});
export type WorkTaskUpdateInput = typeof WorkTaskUpdateInput.Type;
export const WorkTaskUpdateResult = Schema.Struct({ url: Schema.String });
export type WorkTaskUpdateResult = typeof WorkTaskUpdateResult.Type;
export class WorkTaskUpdateError extends Schema.TaggedError<WorkTaskUpdateError>()(
  "WorkTaskUpdateError",
  {
    message: Schema.String,
    uncertain: Schema.Boolean,
  },
) {}

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
export function workTaskDiscussionSources(
  task: Pick<WorkItem, "resources">,
): WorkTaskDiscussionSource[] {
  return [
    ...new Map(
      task.resources.flatMap((resource) => {
        const source = sourceFor(resource);
        return source ? [[source.key, source] as const] : [];
      }),
    ).values(),
  ];
}
