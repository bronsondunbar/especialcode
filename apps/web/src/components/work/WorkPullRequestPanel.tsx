import { useRef, useState } from "react";
import { createWorkPullRequestAtoms } from "@t3tools/client-runtime/state/work-items";
import type {
  EnvironmentId,
  WorkItemId,
  WorkPullRequestMutation,
  WorkPullRequestContent,
  PullRequestMergeMethod,
} from "@t3tools/contracts";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useEnvironmentQuery, formatEnvironmentQueryError } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
const atoms = createWorkPullRequestAtoms(connectionAtomRuntime);
export function WorkPullRequestPanel({
  environmentId,
  id,
}: {
  environmentId: EnvironmentId;
  id: WorkItemId;
}) {
  const query = useEnvironmentQuery(atoms.get({ environmentId, input: { id } }));
  const mutate = useAtomCommand(atoms.mutate, { reportFailure: false });
  const [draft, setDraft] = useState<typeof WorkPullRequestContent.Type | null>(null);
  const [draftRevision, setDraftRevision] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [merge, setMerge] = useState<PullRequestMergeMethod | null>(null);
  const retry = useRef<{ key: string; commandId: string } | null>(null);
  const data = query.data;
  async function send(input: WorkPullRequestMutation) {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await mutate({ environmentId, input });
      if (result._tag === "Failure") setError(formatEnvironmentQueryError(result.cause));
      else {
        setDraft(null);
        setMerge(null);
        retry.current = null;
        query.refresh();
      }
    } finally {
      setPending(false);
    }
  }
  function create() {
    if (!data || !draft) return;
    const key = JSON.stringify({ draft, revision: draftRevision });
    const commandId = retry.current?.key === key ? retry.current.commandId : randomUUID();
    retry.current = { key, commandId };
    void send({
      kind: "create",
      id,
      commandId,
      expectedRevision: draftRevision,
      content: draft,
    });
  }
  const detail = data?.detail;
  const busy = pending || data?.record?.status === "creating";
  return (
    <section className="grid gap-3 rounded-xl border p-4">
      <h3 className="font-medium">Pull request</h3>
      {(error || query.error || data?.refreshError || data?.record?.error) && (
        <p role="alert" className="text-sm text-destructive">
          {error ?? query.error ?? data?.refreshError ?? data?.record?.error}
        </p>
      )}
      {!data ? (
        <p>Loading pull request…</p>
      ) : data.record?.reference ? (
        <>
          <a
            href={data.record.url ?? undefined}
            target="_blank"
            rel="noreferrer"
            className="underline"
          >
            Open PR #{data.record.reference.number}
          </a>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void send({ kind: "refresh", id })}
          >
            Refresh PR
          </Button>
          {detail && (
            <>
              <p>
                {detail.title} · {detail.state}
                {detail.isDraft ? " · Draft" : ""}
              </p>
              <p className="text-sm">
                Review: {data.summary?.reviewDecision ?? "No decision"} · Mergeability:{" "}
                {detail.mergeability}
              </p>
              <p className="text-sm">
                Reviewers:{" "}
                {(data.activity?.reviewers ?? detail.reviewers)
                  .map((actor) => actor.login)
                  .join(", ") || "None"}
              </p>
              <div className="text-sm">
                Checks:{" "}
                {detail.checks.length === 0
                  ? "None reported"
                  : detail.checks.map((check) => (
                      <p key={check.name}>
                        {check.name}: {check.status}
                      </p>
                    ))}
              </div>
              <details className="text-sm">
                <summary>Comments ({data.activity?.commentCount ?? 0})</summary>
                {data.activity?.comments.map((comment) => (
                  <div key={comment.id} className="my-3">
                    <p>
                      {comment.author?.login ?? "Unknown"}
                      {comment.reviewState ? ` · ${comment.reviewState}` : ""}
                    </p>
                    <p className="whitespace-pre-wrap break-words">{comment.body}</p>
                  </div>
                ))}
                {data.activity?.commentsTruncated && <p>Open PR to read the remaining comments.</p>}
              </details>
              {detail.state === "open" &&
                !detail.isDraft &&
                detail.viewerPermissions.actions.includes("merge") && (
                  <div className="flex flex-wrap gap-2">
                    {(["merge", "squash", "rebase"] as const)
                      .filter((method) => detail.mergeCapabilities[method])
                      .map((method) => (
                        <Button
                          key={method}
                          variant="outline"
                          disabled={busy}
                          onClick={() => setMerge(method)}
                        >
                          Merge ({method})
                        </Button>
                      ))}
                  </div>
                )}
              {merge && (
                <div className="grid gap-2">
                  <p>
                    Merge PR #{detail.number} into {detail.baseBranch} using {merge}?
                  </p>
                  <div className="flex gap-2">
                    <Button
                      disabled={busy}
                      onClick={() => void send({ kind: "merge", id, mergeMethod: merge })}
                    >
                      Confirm merge
                    </Button>
                    <Button variant="outline" disabled={busy} onClick={() => setMerge(null)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </>
      ) : (
        <>
          {data.record?.status === "creating" && (
            <p role="status">Committing, pushing and creating the pull request…</p>
          )}
          {data.unavailableReason ? (
            <p className="text-sm text-muted-foreground">{data.unavailableReason}</p>
          ) : draft ? (
            <>
              <label className="grid gap-1 text-sm">
                PR title
                <Input
                  value={draft.title}
                  maxLength={256}
                  disabled={busy}
                  onChange={(event) => setDraft({ ...draft, title: event.target.value })}
                />
              </label>
              <label className="grid gap-1 text-sm">
                PR body
                <Textarea
                  rows={14}
                  value={draft.body}
                  maxLength={65_536}
                  disabled={busy}
                  onChange={(event) => setDraft({ ...draft, body: event.target.value })}
                />
              </label>
              <p className="text-sm text-muted-foreground">
                Submission commits all current changes in the execution worktree, pushes its branch
                and creates the PR. Review the diff in View Changes first. Issue links do not close
                issues; add closing syntax only when intended.
              </p>
              <div className="flex gap-2">
                <Button disabled={busy || !draft.title.trim()} onClick={create}>
                  Commit, Push &amp; Create PR
                </Button>
                <Button variant="outline" disabled={busy} onClick={() => setDraft(null)}>
                  Cancel
                </Button>
              </div>
            </>
          ) : (
            <Button
              disabled={busy}
              onClick={() => {
                setDraftRevision(data.item.revision);
                setDraft(data.draft);
              }}
            >
              Create Pull Request
            </Button>
          )}
        </>
      )}
    </section>
  );
}
