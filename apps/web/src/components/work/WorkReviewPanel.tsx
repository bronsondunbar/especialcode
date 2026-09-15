import { useRef, useState } from "react";
import { createWorkReviewAtoms } from "@t3tools/client-runtime/state/work-items";
import type { EnvironmentId, WorkItemId, WorkReviewMutation } from "@t3tools/contracts";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useEnvironmentQuery, formatEnvironmentQueryError } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
const atoms = createWorkReviewAtoms(connectionAtomRuntime);
export function WorkReviewPanel({
  environmentId,
  id,
}: {
  environmentId: EnvironmentId;
  id: WorkItemId;
}) {
  const query = useEnvironmentQuery(atoms.get({ environmentId, input: { id } }));
  const mutate = useAtomCommand(atoms.mutate, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<{
    workRevision: number;
    reviewRevision: number;
    guidance: string;
    commands: string;
  } | null>(null);
  const retry = useRef<{ key: string; commandId: string } | null>(null);
  const data = query.data;
  const snapshot = data?.snapshot;
  const active =
    data?.execution && !["succeeded", "failed", "stopped"].includes(data.execution.status);
  async function send(input: WorkReviewMutation) {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await mutate({ environmentId, input });
      if (result._tag === "Failure") setError(formatEnvironmentQueryError(result.cause));
      else {
        setDraft(null);
        retry.current = null;
        query.refresh();
      }
    } finally {
      setPending(false);
    }
  }
  function start() {
    if (!draft) return;
    const key = JSON.stringify(draft);
    const commandId = retry.current?.key === key ? retry.current.commandId : randomUUID();
    retry.current = { key, commandId };
    void send({
      kind: "send",
      id,
      commandId,
      expectedWorkItemRevision: draft.workRevision,
      expectedReviewRevision: draft.reviewRevision,
      guidance: draft.guidance,
      validationCommands: draft.commands
        .split("\n")
        .map((command) => command.trim())
        .filter(Boolean),
    });
  }
  if (
    data &&
    !snapshot &&
    !data.history.length &&
    !["review", "blocked"].includes(data.item.status)
  )
    return null;
  return (
    <section className="grid gap-3 rounded-xl border p-4">
      <h3 className="font-medium">Review feedback</h3>
      {(error || query.error || data?.syncError) && (
        <p role="alert" className="text-sm text-destructive">
          {error ?? query.error ?? data?.syncError}
        </p>
      )}
      <Button
        variant="outline"
        disabled={pending}
        onClick={() => void send({ kind: "refresh", id })}
      >
        Refresh review feedback
      </Button>
      {snapshot && (
        <p className="text-sm">
          PR {snapshot.state} · {snapshot.reviewDecision ?? "No review decision"} · Synced{" "}
          {new Date(snapshot.syncedAt).toLocaleString()}
        </p>
      )}
      {data?.execution?.review && (
        <p role="status" className="text-sm">
          Review cycle: {data.execution.status} · {data.execution.activity}
        </p>
      )}
      {data?.item.status === "done" && data.item.completedAt && (
        <p>Completed {new Date(data.item.completedAt).toLocaleString()}</p>
      )}
      {snapshot?.state === "open" &&
        data &&
        ["review", "blocked"].includes(data.item.status) &&
        !active && (
          <>
            {draft ? (
              <>
                <p className="text-sm text-muted-foreground">
                  This resumes the original agent thread with the saved review comments and failed
                  checks, validates its fixes, then commits and pushes to the same PR. Review the PR
                  comments above before confirming.
                </p>
                <label className="grid gap-1 text-sm">
                  Additional guidance
                  <Textarea
                    disabled={pending}
                    maxLength={5000}
                    value={draft.guidance}
                    onChange={(event) => setDraft({ ...draft, guidance: event.target.value })}
                  />
                </label>
                <label className="grid gap-1 text-sm">
                  Required validation commands
                  <Textarea
                    disabled={pending}
                    value={draft.commands}
                    onChange={(event) => setDraft({ ...draft, commands: event.target.value })}
                  />
                </label>
                <div className="flex flex-wrap gap-2">
                  <Button disabled={pending || !draft.commands.trim()} onClick={start}>
                    Resume Agent, Validate &amp; Push
                  </Button>
                  <Button variant="outline" disabled={pending} onClick={() => setDraft(null)}>
                    Cancel
                  </Button>
                </div>
              </>
            ) : (
              <Button
                disabled={pending || snapshot.commentsTruncated}
                onClick={() =>
                  setDraft({
                    workRevision: data.item.revision,
                    reviewRevision: snapshot.revision,
                    guidance: "",
                    commands: data.execution?.validationCommands.join("\n") ?? "",
                  })
                }
              >
                Send Changes to Agent
              </Button>
            )}
            {snapshot.commentsTruncated && (
              <p className="text-sm text-muted-foreground">
                The host returned incomplete comments. Open the PR before starting a review cycle.
              </p>
            )}
          </>
        )}
      {data && data.history.length > 0 && (
        <details open>
          <summary className="text-sm">WorkItem activity</summary>
          <ol className="mt-3 grid gap-3 text-sm">
            {data.history.map((event) => (
              <li key={event.id}>
                <p className="text-xs text-muted-foreground">
                  {new Date(event.occurredAt).toLocaleString()}
                </p>
                <p className="whitespace-pre-wrap break-words">{event.message}</p>
              </li>
            ))}
          </ol>
        </details>
      )}
    </section>
  );
}
