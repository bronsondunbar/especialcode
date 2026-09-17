import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { notificationActionLabel } from "@t3tools/client-runtime/state/work-items";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  NOTIFICATION_FILTERS,
  type AppNotification,
  type EnvironmentId,
  type NotificationListInput,
  type NotificationMutation,
  type WorkItemId,
} from "@t3tools/contracts";
import { useEnvironments } from "../../state/environments";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { useRightPanelStore } from "../../rightPanelStore";
import { Button } from "../ui/button";
import { WorkPlanPanel } from "../work/WorkPlanPanel";
import { notifications } from "../../state/notifications";

export function NotificationCenter({
  environmentId,
  initialWorkItemId = null,
  onCloseWorkItem,
}: {
  environmentId: EnvironmentId;
  initialWorkItemId?: WorkItemId | null;
  onCloseWorkItem?: () => void;
}) {
  const { environments } = useEnvironments();
  const capabilities = environments.find((env) => env.environmentId === environmentId)?.serverConfig
    ?.environment.capabilities;
  const [filter, setFilter] = useState<NonNullable<NotificationListInput["filter"]>>("all");
  const [offset, setOffset] = useState(0);
  const [workItemId, setWorkItemId] = useState<WorkItemId | null>(initialWorkItemId);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const navigate = useNavigate();
  const query = useEnvironmentQuery(
    notifications.list({ environmentId, input: { filter, offset, limit: 50 } }),
  );
  const mutate = useAtomCommand(notifications.mutate, { reportFailure: false });
  async function change(input: NotificationMutation) {
    setPending(true);
    setError(null);
    try {
      const result = await mutate({ environmentId, input });
      if (result._tag !== "Success") setError(formatEnvironmentQueryError(result.cause));
    } finally {
      setPending(false);
    }
  }
  function open(item: AppNotification) {
    const action = item.action;
    if (!action) return;
    if (action.kind === "work_item") setWorkItemId(action.workItemId);
    else {
      if (action.kind === "changes")
        useRightPanelStore.getState().open(scopeThreadRef(environmentId, action.threadId), "diff");
      void navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId, threadId: action.threadId },
      });
    }
  }
  const data = query.data;
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-4 sm:p-6">
      <p className="text-sm text-muted-foreground">
        Notifications and read state are shared across this environment.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {NOTIFICATION_FILTERS.map((entry) => (
          <Button
            key={entry.id}
            variant={filter === entry.id ? "secondary" : "ghost"}
            onClick={() => {
              setFilter(entry.id);
              setOffset(0);
            }}
          >
            {entry.label}
          </Button>
        ))}
        <Button
          className="ml-auto"
          variant="outline"
          disabled={pending || !data?.unreadCount}
          onClick={() =>
            data && void change({ kind: "read_all", throughSequence: data.latestSequence })
          }
        >
          Mark all read{data ? ` (${data.unreadCount})` : ""}
        </Button>
        <Button variant="ghost" onClick={() => query.refresh()}>
          Refresh
        </Button>
      </div>
      {(error || query.error) && (
        <p role="alert" className="text-destructive">
          {error ?? query.error}
        </p>
      )}
      {!data && !query.error && <p>Loading notifications…</p>}
      {data && !data.items.length && (
        <p className="py-12 text-center text-muted-foreground">No notifications in this view.</p>
      )}
      {data?.items.map((item) => (
        <article
          key={item.id}
          className={`rounded-xl border p-4 ${item.readAt ? "bg-background" : "border-primary/40 bg-muted/40"}`}
        >
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-medium">
              {!item.readAt && (
                <span
                  aria-label="Unread"
                  className="mr-2 inline-block size-2 rounded-full bg-primary"
                />
              )}
              {item.title}
            </h2>
            <span
              className={`text-xs ${item.priority === "urgent" ? "text-destructive" : "text-muted-foreground"}`}
            >
              {item.priority}
            </span>
            <time className="ml-auto text-xs text-muted-foreground" dateTime={item.createdAt}>
              {new Date(item.createdAt).toLocaleString()}
            </time>
          </div>
          <p className="my-3 whitespace-pre-wrap break-words text-sm text-muted-foreground">
            {item.message}
          </p>
          <div className="flex flex-wrap gap-2">
            {item.action && (
              <Button variant="outline" onClick={() => open(item)}>
                {notificationActionLabel(item.type)}
              </Button>
            )}
            <Button
              variant="ghost"
              disabled={pending}
              onClick={() => void change({ kind: "read", id: item.id, read: !item.readAt })}
            >
              Mark {item.readAt ? "unread" : "read"}
            </Button>
          </div>
        </article>
      ))}
      {data && data.total > 50 && (
        <div className="flex items-center justify-between">
          <Button
            variant="outline"
            disabled={!offset}
            onClick={() => setOffset(Math.max(0, offset - 50))}
          >
            Previous
          </Button>
          <span>
            {offset + 1}–{Math.min(offset + 50, data.total)} of {data.total}
          </span>
          <Button
            variant="outline"
            disabled={offset + 50 >= data.total}
            onClick={() => setOffset(offset + 50)}
          >
            Next
          </Button>
        </div>
      )}
      {workItemId && (
        <WorkPlanPanel
          environmentId={environmentId}
          id={workItemId}
          onClose={() => {
            setWorkItemId(null);
            onCloseWorkItem?.();
          }}
          executionSupported={capabilities?.workExecutions === true}
        />
      )}
    </div>
  );
}
