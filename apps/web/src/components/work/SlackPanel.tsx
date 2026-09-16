import { useEnvironments } from "../../state/environments";
import { ExternalSyncStatus } from "./ExternalSyncStatus";
import { useDeferredValue, useState } from "react";
import { createSlackAtoms } from "@t3tools/client-runtime/state/work-items";
import {
  ProjectId,
  type EnvironmentId,
  type SlackAdminInput,
  type SlackChannel,
  type SlackChannelConfig,
  type SlackMessage,
  type SlackMutation,
  type WorkItemId,
  type WorkItemPriority,
} from "@t3tools/contracts";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useProjects } from "../../state/entities";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { workItems } from "../../state/workItems";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { WorkPlanPanel } from "./WorkPlanPanel";
const atoms = createSlackAtoms(connectionAtomRuntime);
const selectClass = "h-9 rounded-lg border border-input bg-background px-2 text-sm";
export function SlackPanel({
  environmentId,
  planningSupported = false,
  executionSupported = false,
  pullRequestsSupported = false,
  reviewsSupported = false,
}: {
  environmentId: EnvironmentId;
  planningSupported?: boolean;
  executionSupported?: boolean;
  pullRequestsSupported?: boolean;
  reviewsSupported?: boolean;
}) {
  const projects = useProjects().filter((p) => p.environmentId === environmentId);
  const { environments } = useEnvironments();
  const automaticTasks =
    environments.find((environment) => environment.environmentId === environmentId)?.serverConfig
      ?.environment.capabilities.slackAutoTasks === true;
  const [workspaceId, setWorkspaceId] = useState("");
  const [ignored, setIgnored] = useState(false);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [authorizeUrl, setAuthorizeUrl] = useState<string | null>(null);
  const [available, setAvailable] = useState<ReadonlyArray<typeof SlackChannel.Type>>([]);
  const [channelCursor, setChannelCursor] = useState("");
  const [channelId, setChannelId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [repository, setRepository] = useState("");
  const [channelMentions, setChannelMentions] = useState(false);
  const [priority, setPriority] = useState<WorkItemPriority>("medium");
  const [messageUrl, setMessageUrl] = useState("");
  const [planningId, setPlanningId] = useState<WorkItemId | null>(null);
  const [attachment, setAttachment] = useState<SlackMessage | null>(null);
  const [taskId, setTaskId] = useState("");
  const [taskSearch, setTaskSearch] = useState("");
  const deferredTaskSearch = useDeferredValue(taskSearch);
  const [detail, setDetail] = useState<SlackMessage | null>(null);
  const [pages, setPages] = useState<Record<string, number>>({});
  const result = useEnvironmentQuery(
    atoms.list({
      environmentId,
      input: { ...(workspaceId ? { workspaceId } : {}), ignored, offset, limit: 25 },
    }),
  );
  const tasks = useEnvironmentQuery(
    workItems.list({ environmentId, input: { limit: 100, query: deferredTaskSearch } }),
  );
  const read = useAtomCommand(atoms.read, { reportFailure: false });
  const mutate = useAtomCommand(atoms.mutate, { reportFailure: false });
  const admin = useAtomCommand(atoms.admin, { reportFailure: false });
  const data = result.data;
  const firstWorkspaceId = data?.workspaces[0]?.id ?? "";
  if (
    data &&
    workspaceId !== firstWorkspaceId &&
    !data.workspaces.some((w) => w.id === workspaceId)
  ) {
    setWorkspaceId(firstWorkspaceId);
    setOffset(0);
  }
  const workspace = data?.workspaces.find((w) => w.id === workspaceId) ?? data?.workspaces[0];
  async function configure(input: SlackAdminInput) {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const response = await admin({ environmentId, input });
      if (response._tag !== "Success") {
        setError(formatEnvironmentQueryError(response.cause));
        return;
      }
      if (response.value.authorizeUrl) setAuthorizeUrl(response.value.authorizeUrl);
      if (input.kind === "channels") {
        setAvailable((old) =>
          input.cursor ? [...old, ...response.value.channels] : response.value.channels,
        );
        setChannelCursor(response.value.nextCursor);
      }
      if (input.kind === "disconnect") {
        setWorkspaceId("");
        setAvailable([]);
        setAuthorizeUrl(null);
      }
      result.refresh();
    } finally {
      setPending(false);
    }
  }
  async function send(input: SlackMutation, ask = false) {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const response = await mutate({ environmentId, input });
      if (response._tag !== "Success") {
        setError(formatEnvironmentQueryError(response.cause));
        return;
      }
      if (input.kind === "sync")
        setPages((old) => ({
          ...old,
          [`${input.workspaceId}/${input.channelId}`]: response.value.hasMore
            ? (input.page ?? 1) + 1
            : 0,
        }));
      if (input.kind === "attach") setAttachment(null);
      if (input.kind === "thread" || input.kind === "select") {
        const loaded = await read({ environmentId, input });
        if (loaded._tag === "Success") setDetail(loaded.value);
        else setError(formatEnvironmentQueryError(loaded.cause));
      }
      if (ask && response.value.workItemId) setPlanningId(response.value.workItemId);
      result.refresh();
      tasks.refresh();
    } finally {
      setPending(false);
    }
  }
  function edit(channel: SlackChannelConfig) {
    setWorkspaceId(channel.workspaceId);
    setChannelId(channel.channelId);
    setProjectId(channel.projectId ?? "");
    setRepository(channel.repository ?? "");
    setChannelMentions(channel.channelMentions);
  }
  function selectMessage() {
    try {
      const url = new URL(messageUrl);
      const match = /^\/archives\/([A-Z][A-Z0-9]+)\/p(\d{10,16})(\d{6})$/.exec(url.pathname);
      if (url.protocol !== "https:" || !url.hostname.endsWith(".slack.com") || !match || !workspace)
        throw new Error();
      void send({
        kind: "select",
        workspaceId: workspace.id,
        channelId: match[1]!,
        ts: `${match[2]}.${match[3]}`,
      });
    } catch {
      setError(
        "Choose the matching workspace and paste a Slack message link from a configured channel.",
      );
    }
  }
  function importMessage(message: SlackMessage, ask: boolean) {
    const config = data?.channels.find(
      (c) => c.workspaceId === message.workspaceId && c.channelId === message.channelId,
    );
    void send(
      {
        kind: "import",
        ...message,
        projectId: projectId ? ProjectId.make(projectId) : (config?.projectId ?? null),
        repository: repository.trim() || config?.repository || null,
        priority,
      },
      ask,
    );
  }
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
      <div className="mx-auto flex max-w-5xl flex-col gap-5">
        <h2 className="text-xl font-semibold">Slack</h2>
        <p className="text-sm text-muted-foreground">
          {automaticTasks
            ? "Connect a workspace to turn direct mentions of you into Work tasks automatically. The first sync imports the last seven days, then refreshes every five minutes. No channel selection or automation rules are required. Tasks start in Inbox and never start agents automatically."
            : "Choose channels, sync mentions and create Work tasks from their messages."}{" "}
          Tasks and source messages are shared with everyone who can read this environment,
          including mentions from private conversations your account can access.
        </p>
        {!data?.configured && (
          <p className="text-sm">
            The environment owner must configure a Slack app and HTTPS callback before connecting.
            See the Slack section in the Work guide.
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={pending || !data?.configured}
            onClick={() => void configure({ kind: "connect" })}
          >
            Connect workspace
          </Button>
          <Button variant="outline" onClick={() => result.refresh()}>
            Refresh connections
          </Button>
        </div>
        {authorizeUrl && (
          <a
            href={authorizeUrl}
            target="_blank"
            rel="noreferrer"
            className="text-primary underline"
          >
            Continue to Slack to choose a workspace
          </a>
        )}
        {(error || result.error) && (
          <p role="alert" className="text-sm text-destructive">
            {error ?? result.error}
          </p>
        )}
        {workspace && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <label>
                Workspace{" "}
                <select
                  aria-label="Workspace"
                  className={selectClass}
                  value={workspace.id}
                  onChange={(e) => {
                    setWorkspaceId(e.target.value);
                    setAvailable([]);
                    setChannelId("");
                    setOffset(0);
                    setPages({});
                  }}
                >
                  {data?.workspaces.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </select>
              </label>
              <Button
                disabled={pending}
                variant="outline"
                onClick={() => void configure({ kind: "disconnect", workspaceId: workspace.id })}
              >
                Disconnect workspace
              </Button>
            </div>
            {automaticTasks && (
              <section className="grid gap-2 rounded-xl border p-4">
                <p className="font-medium">Direct mentions → Work tasks</p>
                <ExternalSyncStatus value={workspace} />
                <p className="text-sm text-muted-foreground">
                  Sync continues while this environment is running, even when this panel is closed.
                  Disconnecting stops imports and keeps your Work tasks.
                </p>
              </section>
            )}
            <section className="grid gap-3 rounded-xl border p-4">
              <h3 className="font-medium">
                {automaticTasks
                  ? "Optional channel defaults and manual imports"
                  : "Channel and task defaults"}
              </h3>
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={pending}
                  variant="outline"
                  onClick={() => void configure({ kind: "channels", workspaceId: workspace.id })}
                >
                  Choose channels
                </Button>
                {channelCursor && (
                  <Button
                    disabled={pending}
                    variant="outline"
                    onClick={() =>
                      void configure({
                        kind: "channels",
                        workspaceId: workspace.id,
                        cursor: channelCursor,
                      })
                    }
                  >
                    More channels
                  </Button>
                )}
              </div>
              <label className="grid gap-1 text-sm">
                Channel
                <select
                  className={selectClass}
                  value={channelId}
                  onChange={(e) => setChannelId(e.target.value)}
                >
                  <option value="">Select a channel</option>
                  {channelId && !available.some((c) => c.id === channelId) && (
                    <option value={channelId}>
                      {data?.channels.find((c) => c.channelId === channelId)?.name ?? channelId}
                    </option>
                  )}
                  {available.map((c) => (
                    <option key={c.id} value={c.id}>
                      #{c.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1 text-sm">
                Project for new tasks
                <select
                  className={selectClass}
                  value={projectId}
                  onChange={(e) => setProjectId(e.target.value)}
                >
                  <option value="">Use channel default / no project</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.title}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1 text-sm">
                Repository for new tasks
                <Input
                  value={repository}
                  onChange={(e) => setRepository(e.target.value)}
                  placeholder="owner/repository (or channel default)"
                />
              </label>
              <label className="grid gap-1 text-sm">
                Priority
                <select
                  className={selectClass}
                  value={priority}
                  onChange={(e) => setPriority(e.target.value as WorkItemPriority)}
                >
                  {["low", "medium", "high", "urgent"].map((p) => (
                    <option key={p}>{p}</option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={channelMentions}
                  onChange={(e) => setChannelMentions(e.target.checked)}
                />
                Include @channel, @here and @everyone mentions
              </label>
              <Button
                disabled={pending || !channelId}
                onClick={() =>
                  void configure({
                    kind: "configure",
                    workspaceId: workspace.id,
                    channelId,
                    name: channelId,
                    projectId: projectId ? ProjectId.make(projectId) : null,
                    repository: repository.trim() || null,
                    channelMentions,
                  })
                }
              >
                Save channel
              </Button>
            </section>
            {data?.channels
              .filter((c) => c.workspaceId === workspace.id)
              .map((c) => (
                <div
                  key={c.channelId}
                  className="flex flex-wrap items-center gap-2 rounded-lg border p-3"
                >
                  <span className="mr-auto text-sm">
                    #{c.name} · {projects.find((p) => p.id === c.projectId)?.title ?? "No project"}
                    {c.repository ? ` · ${c.repository}` : ""}
                  </span>
                  <Button
                    disabled={pending}
                    variant="outline"
                    onClick={() =>
                      void send({
                        kind: "sync",
                        workspaceId: c.workspaceId,
                        channelId: c.channelId,
                      })
                    }
                  >
                    Sync mentions
                  </Button>
                  {!!pages[`${c.workspaceId}/${c.channelId}`] && (
                    <Button
                      disabled={pending}
                      variant="outline"
                      onClick={() =>
                        void send({
                          kind: "sync",
                          workspaceId: c.workspaceId,
                          channelId: c.channelId,
                          page: pages[`${c.workspaceId}/${c.channelId}`] ?? 1,
                        })
                      }
                    >
                      Older results
                    </Button>
                  )}
                  <Button variant="ghost" onClick={() => edit(c)}>
                    Edit
                  </Button>
                  <Button
                    disabled={pending}
                    variant="ghost"
                    onClick={() =>
                      void configure({
                        kind: "untrack",
                        workspaceId: c.workspaceId,
                        channelId: c.channelId,
                      })
                    }
                  >
                    Stop tracking
                  </Button>
                </div>
              ))}
            <div className="flex gap-2">
              <Input
                aria-label="Slack message link"
                placeholder="Paste a Slack message link"
                value={messageUrl}
                onChange={(e) => setMessageUrl(e.target.value)}
              />
              <Button disabled={pending || !messageUrl} onClick={selectMessage}>
                Add message
              </Button>
            </div>
          </>
        )}
        <label className="flex gap-2 text-sm">
          <input
            type="checkbox"
            checked={ignored}
            onChange={(e) => {
              setIgnored(e.target.checked);
              setOffset(0);
            }}
          />
          Show ignored messages
        </label>
        {!data?.items.length && (
          <p className="text-sm text-muted-foreground">
            No messages in this view. Configure a channel and sync mentions, or add a selected
            message.
          </p>
        )}
        {data?.channels
          .filter((c) => !workspaceId || c.workspaceId === workspaceId)
          .map((c) => (
            <div key={`sync:${c.workspaceId}:${c.channelId}`}>
              <span className="text-xs text-muted-foreground">#{c.name}</span>
              <ExternalSyncStatus value={c} />
            </div>
          ))}
        {data?.items.map((item) => {
          const m =
            detail &&
            detail.lastSyncedAt === item.lastSyncedAt &&
            detail.workspaceId === item.workspaceId &&
            detail.channelId === item.channelId &&
            detail.ts === item.ts
              ? {
                  ...item,
                  text: detail.text,
                  replies: detail.replies,
                  nextCursor: detail.nextCursor,
                }
              : item;
          const c = data.channels.find(
            (c) => c.workspaceId === m.workspaceId && c.channelId === m.channelId,
          );
          return (
            <article
              key={`${m.workspaceId}/${m.channelId}/${m.ts}`}
              className="grid gap-3 rounded-xl border p-4"
            >
              <div className="text-sm text-muted-foreground">
                {m.author} · #{c?.name ?? m.channelId} ·{" "}
                {new Date(Number(m.ts) * 1000).toLocaleString()} ·{" "}
                {projects.find((p) => p.id === c?.projectId)?.title ?? "No project"}
              </div>
              <ExternalSyncStatus value={m} />
              <p className="whitespace-pre-wrap break-words text-sm">{m.text}</p>
              {m.url && (
                <a
                  className="text-sm text-primary underline"
                  href={m.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open in Slack
                </a>
              )}
              {!!m.replies.length && (
                <details>
                  <summary className="text-sm">Thread context ({m.replies.length})</summary>
                  {m.replies.map((r) => (
                    <p key={r.ts} className="mt-2 whitespace-pre-wrap break-words text-sm">
                      <strong>{r.author}</strong>: {r.text}
                    </p>
                  ))}
                </details>
              )}
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={pending}
                  variant="outline"
                  onClick={() => void send({ kind: "thread", ...m })}
                >
                  Refresh thread
                </Button>
                {m.nextCursor && (
                  <Button
                    disabled={pending}
                    variant="outline"
                    onClick={() => void send({ kind: "thread", ...m, more: true })}
                  >
                    More replies
                  </Button>
                )}
                <Button
                  disabled={pending}
                  variant="ghost"
                  onClick={() => void send({ kind: "ignore", ...m, ignored: !m.ignored })}
                >
                  {m.ignored ? "Restore" : "Ignore"}
                </Button>
                {m.workItemId ? (
                  <Button onClick={() => setPlanningId(m.workItemId)}>Open task</Button>
                ) : (
                  <>
                    <Button disabled={pending} onClick={() => importMessage(m, false)}>
                      Create Task
                    </Button>
                    <Button
                      disabled={pending || !planningSupported}
                      onClick={() => importMessage(m, true)}
                    >
                      Ask Agent
                    </Button>
                    <Button
                      disabled={pending}
                      variant="outline"
                      onClick={() => {
                        setAttachment(m);
                        setTaskId("");
                      }}
                    >
                      Attach to existing task
                    </Button>
                  </>
                )}
              </div>
            </article>
          );
        })}
        {attachment && (
          <div className="flex flex-wrap gap-2 rounded-lg border p-4">
            <Input
              aria-label="Search existing tasks"
              value={taskSearch}
              onChange={(e) => setTaskSearch(e.target.value)}
              placeholder="Search existing tasks"
            />
            <select
              aria-label="Existing task"
              className={selectClass}
              value={taskId}
              onChange={(e) => setTaskId(e.target.value)}
            >
              <option value="">Choose an existing task</option>
              {tasks.data?.items.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                </option>
              ))}
            </select>
            <Button
              disabled={pending || !taskId}
              onClick={() => {
                const task = tasks.data?.items.find((t) => t.id === taskId);
                if (task)
                  void send({
                    kind: "attach",
                    ...attachment,
                    workItemId: task.id,
                    expectedRevision: task.revision,
                  });
              }}
            >
              Attach
            </Button>
            <Button variant="ghost" onClick={() => setAttachment(null)}>
              Cancel
            </Button>
          </div>
        )}
        <div className="flex gap-2">
          <Button
            disabled={offset === 0}
            variant="outline"
            onClick={() => setOffset(Math.max(0, offset - 25))}
          >
            Previous
          </Button>
          <span className="text-sm">{data?.total ?? 0} messages</span>
          <Button
            disabled={offset + 25 >= (data?.total ?? 0)}
            variant="outline"
            onClick={() => setOffset(offset + 25)}
          >
            Next
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Ask Agent creates or opens a task for planning. Review and approve a plan before
          execution. Slack messages are never sent automatically.
        </p>
        {planningId && (
          <WorkPlanPanel
            environmentId={environmentId}
            id={planningId}
            onClose={() => setPlanningId(null)}
            executionSupported={executionSupported}
            pullRequestsSupported={pullRequestsSupported}
            reviewsSupported={reviewsSupported}
          />
        )}
      </div>
    </div>
  );
}
