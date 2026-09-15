import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { createWorkActivityAtoms } from "@t3tools/client-runtime/state/work-items";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentId,
  WorkItemId,
  WorkActivityInput,
  WorkActivityEvent,
} from "@t3tools/contracts";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironments } from "../../state/environments";
import { useRightPanelStore } from "../../rightPanelStore";
import { Button } from "../ui/button";
const atoms = createWorkActivityAtoms(connectionAtomRuntime);
export function WorkActivityPanel(props: { environmentId: EnvironmentId; id: WorkItemId }) {
  const { environments } = useEnvironments();
  return environments.find((e) => e.environmentId === props.environmentId)?.serverConfig
    ?.environment.capabilities.workActivity ? (
    <Timeline key={props.id} {...props} />
  ) : null;
}
function Timeline({ environmentId, id }: { environmentId: EnvironmentId; id: WorkItemId }) {
  const navigate = useNavigate();
  const [pages, setPages] = useState<ReadonlyArray<WorkActivityInput>>([]);
  const result = useEnvironmentQuery(
    atoms.list({ environmentId, input: pages.at(-1) ?? { id, limit: 25 } }),
  );
  function open(event: WorkActivityEvent) {
    if (!event.threadId) return;
    if (event.kind === "files_changed")
      useRightPanelStore.getState().open(scopeThreadRef(environmentId, event.threadId), "diff");
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId: event.threadId },
    });
  }
  return (
    <section className="grid gap-3 border-t pt-4" aria-label="WorkItem activity">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">Activity</h3>
        <span className="text-xs text-muted-foreground">
          Newest first · {result.data?.total ?? 0} events
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setPages([]);
            result.refresh();
          }}
        >
          Latest activity
        </Button>
      </div>
      {result.error && (
        <p role="alert" className="text-sm text-destructive">
          {result.error}
        </p>
      )}
      {!result.data && !result.error && (
        <p className="text-sm text-muted-foreground">Loading activity…</p>
      )}
      {result.data?.items.length === 0 && (
        <p className="text-sm text-muted-foreground">No recorded activity yet.</p>
      )}
      <ol className="grid gap-4 border-l pl-4">
        {result.data?.items.map((event) => (
          <li key={event.id} className="grid gap-1">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h4 className="text-sm font-medium">{event.title}</h4>
              <time className="text-xs text-muted-foreground" dateTime={event.occurredAt}>
                {new Date(event.occurredAt).toLocaleString()}
              </time>
            </div>
            <span className="text-xs capitalize text-muted-foreground">{event.source}</span>
            {event.summary && (
              <p className="whitespace-pre-wrap break-words text-sm">{event.summary}</p>
            )}
            {!!event.details.length && (
              <dl className="text-xs text-muted-foreground">
                {event.details.map((detail) => (
                  <div key={detail.label} className="flex gap-2">
                    <dt>{detail.label}:</dt>
                    <dd className="break-all">{detail.value}</dd>
                  </div>
                ))}
              </dl>
            )}
            <div className="flex flex-wrap gap-2">
              {event.threadId && (
                <Button size="sm" variant="outline" onClick={() => open(event)}>
                  {event.kind === "files_changed" ? "Open changes" : "Open agent thread"}
                </Button>
              )}
              {event.url && (
                <a
                  className="self-center text-sm text-primary underline"
                  href={event.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open source
                </a>
              )}
            </div>
          </li>
        ))}
      </ol>
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={!pages.length}
          onClick={() => setPages((previous) => previous.slice(0, -1))}
        >
          Newer
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!result.data?.nextCursor}
          onClick={() => {
            const data = result.data;
            if (data?.nextCursor)
              setPages((previous) => [
                ...previous,
                { id, limit: 25, before: data.nextCursor!, throughSequence: data.throughSequence },
              ]);
          }}
        >
          Older
        </Button>
      </div>
    </section>
  );
}
