import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, PullRequestRef, ScopedThreadRef } from "@t3tools/contracts";
import { MessageSquareIcon, PlusIcon } from "lucide-react";
import { usePullRequestLinking } from "~/hooks/usePullRequestLinking";
import { useThreadShells } from "~/state/entities";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";
import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogTitle, DialogDescription } from "../ui/dialog";

export function PullRequestAddressCommentsDialog({
  environmentId,
  reference,
  url,
  count,
  loading,
  error,
  canCreateThread,
  pending,
  onOpenChange,
  onThread,
  onNewThread,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  url: string;
  count: number;
  loading: boolean;
  error: boolean;
  canCreateThread: boolean;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onThread: (thread: ScopedThreadRef) => void;
  onNewThread: () => void;
}) {
  const linking = usePullRequestLinking(environmentId);
  const shells = useThreadShells();
  const relations = useEnvironmentQuery(
    linking.mode === "multiple"
      ? pullRequestEnvironment.linkedThreads({ environmentId, input: reference })
      : null,
  );
  const threads = (
    linking.mode === "multiple"
      ? (relations.data?.threads ?? [])
      : shells.filter(
          (thread) => thread.environmentId === environmentId && linking.isLinked(thread, url),
        )
  ).filter((thread) => thread.archivedAt === null);
  const disabled = pending || loading || error || count === 0;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!pending) onOpenChange(open);
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogTitle>Address review comments</DialogTitle>
        <DialogDescription>
          {loading
            ? "Loading the latest review comments…"
            : error
              ? "Review comments could not be loaded. Close this dialog and try again."
              : count === 0
                ? "There are no unresolved review comments."
                : `${count} unresolved ${count === 1 ? "discussion" : "discussions"}. Choose a thread, then review and send the prepared prompt.`}
        </DialogDescription>
        <div className="mt-4 flex max-h-64 flex-col gap-2 overflow-y-auto">
          {linking.mode === "multiple" && relations.isPending ? (
            <p className="text-sm text-muted-foreground">Loading linked threads…</p>
          ) : relations.error ? (
            <p className="text-sm text-destructive">Could not load linked threads.</p>
          ) : threads.length === 0 ? (
            <p className="text-sm text-muted-foreground">No active linked threads.</p>
          ) : (
            threads.map((thread) => (
              <Button
                key={thread.id}
                variant="outline"
                className="justify-start"
                disabled={disabled}
                onClick={() => onThread(scopeThreadRef(environmentId, thread.id))}
              >
                <MessageSquareIcon className="size-4 shrink-0" />
                <span className="truncate">{thread.title || "Untitled thread"}</span>
              </Button>
            ))
          )}
        </div>
        <Button
          className="mt-4 w-full"
          variant="outline"
          disabled={disabled || !canCreateThread}
          onClick={onNewThread}
        >
          <PlusIcon className="size-4" />
          New thread on PR branch
        </Button>
        {!canCreateThread ? (
          <p className="mt-2 text-sm text-muted-foreground">
            Add this repository as a project on this server to create a thread on its PR branch.
          </p>
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}
