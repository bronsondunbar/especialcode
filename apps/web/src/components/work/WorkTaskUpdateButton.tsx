import { useRef, useState } from "react";
import * as Cause from "effect/Cause";
import { workTaskUpdateDraft } from "@t3tools/client-runtime/state/work-items";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId, WorkTaskUpdateInput } from "@t3tools/contracts";
import { useThreadDetail } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery, formatEnvironmentQueryError } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { workItems } from "../../state/workItems";
import { randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { Textarea } from "../ui/textarea";
import { composerFloatingLayerProps } from "../chat/composerEventScope";

export function WorkTaskUpdateButton(props: { environmentId: EnvironmentId; threadId: ThreadId }) {
  const [open, setOpen] = useState(false);
  const { environments } = useEnvironments();
  if (
    !environments.find((environment) => environment.environmentId === props.environmentId)
      ?.serverConfig?.environment.capabilities.workTaskUpdates
  )
    return null;
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="border-input"
        onClick={() => setOpen(true)}
      >
        Draft update
      </Button>
      {open && <UpdateDialog {...props} onClose={() => setOpen(false)} />}
    </>
  );
}
function UpdateDialog({
  environmentId,
  threadId,
  onClose,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  onClose: () => void;
}) {
  const thread = useThreadDetail(scopeThreadRef(environmentId, threadId));
  const [draft] = useState(() => workTaskUpdateDraft(thread?.messages ?? []));
  const [body, setBody] = useState(draft.body);
  const query = useEnvironmentQuery(
    workItems.updateTargets({ environmentId, input: { threadId } }),
  );
  const [selection, setSelection] = useState("");
  const targets = query.data ?? [];
  const target =
    targets.find((item) => `${item.taskId}:${item.source.key}` === selection) ?? targets[0];
  const post = useAtomCommand(workItems.postUpdate, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const attempt = useRef<WorkTaskUpdateInput | null>(null);
  async function submit() {
    if (pending || url || !target || !body.trim()) return;
    setPending(true);
    setError(null);
    attempt.current ??= {
      taskId: target.taskId,
      threadId,
      sourceKey: target.source.key,
      body,
      commandId: randomUUID(),
    };
    try {
      const result = await post({ environmentId, input: attempt.current });
      if (result._tag === "Success") {
        setUrl(result.value.url);
        setUncertain(false);
      } else {
        const failure = Cause.squash(result.cause);
        const isUncertain = !(
          typeof failure === "object" &&
          failure !== null &&
          "uncertain" in failure &&
          failure.uncertain === false
        );
        setUncertain(isUncertain);
        if (!isUncertain) attempt.current = null;
        setError(formatEnvironmentQueryError(result.cause));
      }
    } catch {
      setUncertain(true);
      setError(
        "Posting could not be confirmed. Check the original conversation before drafting another update.",
      );
    } finally {
      setPending(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogPopup {...composerFloatingLayerProps} className="max-w-2xl overflow-y-auto p-6">
        <DialogTitle>Review update</DialogTitle>
        <div className="mt-4 grid gap-3">
          <p className="text-sm text-muted-foreground">
            Drafted from the latest completed agent response. Review the destination and edit the
            text before posting.
          </p>
          {query.isPending && !query.data && <p>Loading linked tasks…</p>}
          {query.error && (
            <p role="alert" className="text-destructive">
              {query.error}
            </p>
          )}
          {query.data && !targets.length && (
            <p>
              Link this thread to a Work task with a GitHub issue or Slack message to post an
              update.
            </p>
          )}
          {target && (
            <>
              <label className="grid gap-1 text-sm">
                Post to
                <select
                  className="h-9 rounded-lg border border-input bg-background px-2"
                  value={`${target.taskId}:${target.source.key}`}
                  disabled={pending || uncertain || !!url}
                  onChange={(event) => setSelection(event.target.value)}
                >
                  {targets.map((item) => (
                    <option
                      key={`${item.taskId}:${item.source.key}`}
                      value={`${item.taskId}:${item.source.key}`}
                    >
                      {item.source.label} — {item.taskTitle}
                    </option>
                  ))}
                </select>
              </label>
              <a
                href={target.source.url}
                target="_blank"
                rel="noreferrer"
                className="break-all text-sm underline"
              >
                {target.source.url}
              </a>
              {draft.truncated && (
                <p className="text-sm text-muted-foreground">
                  The response was shortened to 4,000 characters. Review it for completeness.
                </p>
              )}
              <label className="grid gap-1 text-sm">
                Update
                <Textarea
                  className="min-h-64"
                  value={body}
                  maxLength={4000}
                  disabled={pending || uncertain || !!url}
                  placeholder="Describe what changed and any checks or remaining work."
                  onChange={(event) => setBody(event.target.value)}
                />
              </label>
              <p className="text-xs text-muted-foreground">
                {body.length}/4,000 ·{" "}
                {target.source.kind === "github"
                  ? "Posts a comment on this issue using this environment’s GitHub connection."
                  : "Replies in the original Slack thread using your connected account."}
              </p>
            </>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          {uncertain && (
            <p className="text-sm text-muted-foreground">
              Check the source before starting another draft. Checking status will not resend this
              update.
            </p>
          )}
          {url && (
            <p role="status">
              Update posted.{" "}
              <a href={url} target="_blank" rel="noreferrer" className="underline">
                View posted update
              </a>
            </p>
          )}
          <div className="flex gap-2">
            {!url && (
              <Button
                disabled={pending || !target || !body.trim() || body.length > 4000}
                onClick={() => void submit()}
              >
                {pending
                  ? "Posting…"
                  : uncertain
                    ? "Check posting status"
                    : target?.source.kind === "slack"
                      ? "Post Slack reply"
                      : "Post GitHub comment"}
              </Button>
            )}
            <Button variant="outline" disabled={pending} onClick={onClose}>
              {url ? "Done" : "Cancel"}
            </Button>
          </div>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
