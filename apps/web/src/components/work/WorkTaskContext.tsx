import { WorkDetails } from "./WorkDetails";
import { workTaskDiscussionSources, type EnvironmentId, type WorkItem } from "@t3tools/contracts";
import { useEnvironmentQuery } from "../../state/query";
import { workItems } from "../../state/workItems";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";

export function WorkTaskContext({
  environmentId,
  item,
}: {
  environmentId: EnvironmentId;
  item: WorkItem;
}) {
  return (
    <section className="grid min-w-0 gap-4 rounded-xl border p-4" aria-label="Task context">
      <div className="min-w-0">
        <h3 className="mb-2 font-medium">Description</h3>
        {item.body.trim() ? (
          <ChatMarkdown text={item.body} cwd={undefined} environmentId={environmentId} />
        ) : (
          <p className="text-sm text-muted-foreground">No description provided.</p>
        )}
      </div>
    </section>
  );
}

export function WorkTaskDiscussions({
  environmentId,
  item,
}: {
  environmentId: EnvironmentId;
  item: WorkItem;
}) {
  const sources = workTaskDiscussionSources(item).filter((source) => source.kind === "github");
  if (!sources.length) return null;
  return (
    <WorkDetails title="GitHub comments">
      {sources.map((source) => (
        <IssueComments
          key={source.key}
          environmentId={environmentId}
          taskId={item.id}
          source={source}
        />
      ))}
    </WorkDetails>
  );
}

function IssueComments({
  environmentId,
  taskId,
  source,
}: {
  environmentId: EnvironmentId;
  taskId: WorkItem["id"];
  source: ReturnType<typeof workTaskDiscussionSources>[number];
}) {
  const query = useEnvironmentQuery(
    workItems.discussionDetails({
      environmentId,
      input: { taskId, sourceKey: source.key },
    }),
  );
  const issue = query.data?.githubIssue;
  return (
    <section className="grid min-w-0 gap-3 border-t pt-4" aria-label={source.label}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium">{source.label}</h3>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" disabled={query.isPending} onClick={query.refresh}>
            Refresh comments
          </Button>
          <a
            href={source.url}
            target="_blank"
            rel="noreferrer"
            className="text-sm text-primary hover:underline"
          >
            Open issue
          </a>
        </div>
      </div>
      {query.isPending && (
        <p role="status" className="text-sm text-muted-foreground">
          Loading comments…
        </p>
      )}
      {query.error && (
        <p role="alert" className="text-sm text-destructive">
          {query.error}
        </p>
      )}
      {issue && (
        <>
          {issue.comments.length === 0 && (
            <p className="text-sm text-muted-foreground">No comments on this issue.</p>
          )}
          <ol className="grid gap-4">
            {issue.comments.map((comment) => (
              <li key={comment.id} className="min-w-0 rounded-lg border p-3">
                <a
                  href={comment.url}
                  target="_blank"
                  rel="noreferrer"
                  className="mb-2 block text-xs text-muted-foreground hover:underline"
                >
                  @{comment.author} · {new Date(comment.createdAt).toLocaleString()}
                </a>
                <ChatMarkdown text={comment.body} cwd={undefined} environmentId={environmentId} />
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}
