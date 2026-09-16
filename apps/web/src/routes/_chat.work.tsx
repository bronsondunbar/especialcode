import { VercelSettingsPanel } from "../components/vercel/VercelSettingsPanel";
import { ClearWorkQueueButton } from "../components/work/ClearWorkQueueButton";
import { WorkTaskThreadButton } from "../components/work/WorkTaskThreadButton";
import { WorkDashboard } from "../components/work/WorkDashboardPanel";
import { WorkAutomationPanel } from "../components/work/WorkAutomationPanel";
import { WorkActivityPanel } from "../components/work/WorkActivityPanel";
import { Dialog, DialogPopup, DialogTitle } from "../components/ui/dialog";
import { SlackPanel } from "../components/work/SlackPanel";
import { WorkPlanPanel } from "../components/work/WorkPlanPanel";
import { GitHubIssuesPanel } from "../components/work/GitHubIssuesPanel";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useDeferredValue, useRef, useState } from "react";
import { ArchiveIcon, ClipboardListIcon, PlusIcon, RefreshCwIcon } from "lucide-react";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WorkItemId,
  WORK_ITEM_MANUAL_STATUSES,
  WORK_ITEM_VIEWS,
  type ServerProvider,
  type WorkItem,
  type WorkItemSummary,
  type WorkItemMutation,
  type WorkItemPatch,
  type WorkItemPriority,
  type WorkItemSource,
  type WorkItemStatus,
} from "@t3tools/contracts";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { randomUUID } from "../lib/utils";
import { isElectron } from "../env";
import { useProjects, useThreadShells } from "../state/entities";
import { useEnvironments } from "../state/environments";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
import { workItems } from "../state/workItems";

const workTabs = ["queue", "github", "slack", "vercel", "automations", "dashboard"] as const;
type WorkTab = (typeof workTabs)[number];
export const Route = createFileRoute("/_chat/work")({
  component: WorkPage,
  validateSearch: (search: Record<string, unknown>): { tab?: WorkTab } => {
    const tab = workTabs.find((tab) => tab === search.tab);
    return tab ? { tab } : {};
  },
});
const selectClass = "h-9 rounded-lg border border-input bg-background px-2 text-sm";
const label = (value: string) => value.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase());
type Command = WorkItemMutation extends infer T
  ? T extends WorkItemMutation
    ? Omit<T, "commandId">
    : never
  : never;

function WorkPage() {
  const { environments } = useEnvironments();
  const supported = environments.filter(
    (environment) => environment.serverConfig?.environment.capabilities.workItems === true,
  );
  const requestedTab = Route.useSearch().tab ?? "dashboard";
  const navigate = Route.useNavigate();
  const setTab = (tab: WorkTab) => {
    void navigate({ search: { tab } });
  };
  const [selected, setSelected] = useState<EnvironmentId | null>(null);
  const environment = supported.find((item) => item.environmentId === selected) ?? supported[0];
  const tab =
    requestedTab === "dashboard" &&
    !environment?.serverConfig?.environment.capabilities.workDashboard
      ? "queue"
      : requestedTab;
  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <WorkspacePageHeader electron={isElectron}>
        <ClipboardListIcon className="size-4" />
        <h1 className="font-medium">Work</h1>
        {supported.length > 1 && (
          <select
            aria-label="Work environment"
            className={`${selectClass} no-drag ml-auto`}
            value={environment?.environmentId ?? ""}
            onChange={(event) => setSelected(EnvironmentId.make(event.target.value))}
          >
            {supported.map((item) => (
              <option key={item.environmentId} value={item.environmentId}>
                {item.label}
              </option>
            ))}
          </select>
        )}
      </WorkspacePageHeader>
      {environment && (
        <div className="flex flex-wrap gap-2 border-b px-4 py-2">
          {environment.serverConfig?.environment.capabilities.workDashboard && (
            <Button
              variant={tab === "dashboard" ? "secondary" : "ghost"}
              onClick={() => setTab("dashboard")}
            >
              Dashboard
            </Button>
          )}
          <Button variant={tab === "queue" ? "secondary" : "ghost"} onClick={() => setTab("queue")}>
            Work Queue
          </Button>
          {environment.serverConfig?.environment.capabilities.slack && (
            <Button
              variant={tab === "slack" ? "secondary" : "ghost"}
              onClick={() => setTab("slack")}
            >
              Slack
            </Button>
          )}
          {environment.serverConfig?.environment.capabilities.githubIssues && (
            <Button
              variant={tab === "github" ? "secondary" : "ghost"}
              onClick={() => setTab("github")}
            >
              GitHub
            </Button>
          )}
          {environment.serverConfig?.environment.capabilities.vercel && (
            <Button
              variant={tab === "vercel" ? "secondary" : "ghost"}
              onClick={() => setTab("vercel")}
            >
              Vercel
            </Button>
          )}
        </div>
      )}
      {environment &&
      tab === "dashboard" &&
      environment.serverConfig?.environment.capabilities.workDashboard ? (
        <WorkDashboard
          key={environment.environmentId}
          environmentId={environment.environmentId}
          providers={environment.serverConfig?.providers ?? []}
        />
      ) : environment &&
        tab === "automations" &&
        environment.serverConfig?.environment.capabilities.workAutomations ? (
        <WorkAutomationPanel
          autonomousSupported={
            environment.serverConfig?.environment.capabilities.autonomousWork === true
          }
          key={environment.environmentId}
          environmentId={environment.environmentId}
          providers={environment.serverConfig?.providers ?? []}
        />
      ) : environment &&
        tab === "slack" &&
        environment.serverConfig?.environment.capabilities.slack ? (
        <SlackPanel
          key={environment.environmentId}
          environmentId={environment.environmentId}
          planningSupported={environment.serverConfig?.environment.capabilities.workPlans === true}
          executionSupported={
            environment.serverConfig?.environment.capabilities.workExecutions === true
          }
          pullRequestsSupported={
            environment.serverConfig?.environment.capabilities.workPullRequests === true
          }
          reviewsSupported={environment.serverConfig?.environment.capabilities.workReviews === true}
        />
      ) : environment &&
        tab === "github" &&
        environment.serverConfig?.environment.capabilities.githubIssues ? (
        <GitHubIssuesPanel
          key={environment.environmentId}
          environmentId={environment.environmentId}
        />
      ) : environment &&
        tab === "vercel" &&
        environment.serverConfig?.environment.capabilities.vercel ? (
        <VercelSettingsPanel
          key={environment.environmentId}
          environmentId={environment.environmentId}
        />
      ) : environment ? (
        <WorkQueue
          key={environment.environmentId}
          environmentId={environment.environmentId}
          providers={environment.serverConfig?.providers ?? []}
          deletionSupported={
            environment.serverConfig?.environment.capabilities.workItemsDelete === true
          }
          reviewsSupported={environment.serverConfig?.environment.capabilities.workReviews === true}
          pullRequestsSupported={
            environment.serverConfig?.environment.capabilities.workPullRequests === true
          }
          planningSupported={environment.serverConfig?.environment.capabilities.workPlans === true}
          activitySupported={
            environment.serverConfig?.environment.capabilities.workActivity === true
          }
          executionSupported={
            environment.serverConfig?.environment.capabilities.workExecutions === true
          }
        />
      ) : (
        <div className="m-auto max-w-md p-6 text-center text-muted-foreground">
          Connect to an environment with Work support to create and manage tasks. Older servers need
          the project-management update.
        </div>
      )}
    </main>
  );
}

function WorkQueue({
  deletionSupported,
  environmentId,
  providers,
  planningSupported,
  activitySupported,
  executionSupported,
  pullRequestsSupported,
  reviewsSupported,
}: {
  environmentId: EnvironmentId;
  providers: ReadonlyArray<ServerProvider>;
  deletionSupported: boolean;
  planningSupported: boolean;
  activitySupported: boolean;
  executionSupported: boolean;
  pullRequestsSupported: boolean;
  reviewsSupported: boolean;
}) {
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const threads = useThreadShells().filter((thread) => thread.environmentId === environmentId);
  const [activityId, setActivityId] = useState<WorkItemId | null>(null);
  const [planningId, setPlanningId] = useState<WorkItemId | null>(null);
  const [view, setView] = useState<string>("inbox");
  const [search, setSearch] = useState("");
  const query = useDeferredValue(search);
  const [project, setProject] = useState("");
  const [source, setSource] = useState("");
  const [priority, setPriority] = useState("");
  const [archived, setArchived] = useState(false);
  const [offset, setOffset] = useState(0);
  const [editor, setEditor] = useState<{ id: WorkItemId; item: WorkItem | null } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastCommand = useRef<{ key: string; command: WorkItemMutation } | null>(null);
  const read = useAtomCommand(workItems.read, { reportFailure: false });
  const mutate = useAtomCommand(workItems.mutate, { reportFailure: false });
  const result = useEnvironmentQuery(
    workItems.list({
      environmentId,
      input: {
        ...(archived
          ? {}
          : { statuses: [...(WORK_ITEM_VIEWS.find((tab) => tab.id === view)?.statuses ?? [])] }),
        ...(project === ""
          ? {}
          : { projectId: project === "unassigned" ? null : ProjectId.make(project) }),
        ...(source === "" ? {} : { source: source as WorkItemSource }),
        ...(priority === "" ? {} : { priority: priority as WorkItemPriority }),
        query,
        archived,
        offset,
        limit: 50,
      },
    }),
  );
  async function send(command: Command): Promise<boolean> {
    if (pending) return false;
    setPending(true);
    setError(null);
    const key = JSON.stringify(command);
    const request =
      lastCommand.current?.key === key
        ? lastCommand.current.command
        : { ...command, commandId: randomUUID() };
    lastCommand.current = { key, command: request };
    try {
      const outcome = await mutate({ environmentId, input: request });
      if (outcome._tag === "Success") {
        lastCommand.current = null;
        result.refresh();
        return true;
      }
      setError(formatEnvironmentQueryError(outcome.cause));
      return false;
    } finally {
      setPending(false);
    }
  }
  async function edit(id: WorkItemId) {
    setPending(true);
    setError(null);
    try {
      const outcome = await read({ environmentId, input: { id } });
      if (outcome._tag === "Success") setEditor({ id, item: outcome.value });
      else setError(formatEnvironmentQueryError(outcome.cause));
    } finally {
      setPending(false);
    }
  }
  const filter = (update: () => void) => {
    setOffset(0);
    update();
  };
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
      {activityId && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setActivityId(null);
          }}
        >
          <DialogPopup className="max-w-3xl overflow-y-auto p-6">
            <DialogTitle>Task activity</DialogTitle>
            <WorkActivityPanel environmentId={environmentId} id={activityId} />
          </DialogPopup>
        </Dialog>
      )}
      {planningId && (
        <WorkPlanPanel
          reviewsSupported={reviewsSupported}
          pullRequestsSupported={pullRequestsSupported}
          executionSupported={executionSupported}
          key={planningId}
          environmentId={environmentId}
          id={planningId}
          onClose={() => setPlanningId(null)}
        />
      )}
      <div className="mx-auto flex max-w-5xl flex-col gap-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold">Your work queue</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Organize tasks and keep their context together.
            </p>
          </div>
          <div className="flex flex-wrap items-start gap-2">
            {(!archived || deletionSupported) && (
              <ClearWorkQueueButton
                key={`${environmentId}:${archived}`}
                archived={archived}
                environmentId={environmentId}
                onCleared={() => {
                  setOffset(0);
                  result.refresh();
                }}
              />
            )}
            <Button
              disabled={pending}
              onClick={() => {
                setError(null);
                setEditor({ id: WorkItemId.make(randomUUID()), item: null });
              }}
            >
              <PlusIcon className="size-4" />
              Create task
            </Button>
          </div>
        </div>
        <nav aria-label="Work views" className="flex flex-wrap gap-1 border-b pb-2">
          {WORK_ITEM_VIEWS.map((tab) => (
            <Button
              key={tab.id}
              variant={!archived && view === tab.id ? "secondary" : "ghost"}
              aria-pressed={!archived && view === tab.id}
              onClick={() =>
                filter(() => {
                  setView(tab.id);
                  setArchived(false);
                })
              }
            >
              {tab.label}
            </Button>
          ))}
          <Button
            variant={archived ? "secondary" : "ghost"}
            aria-pressed={archived}
            onClick={() => filter(() => setArchived(!archived))}
          >
            <ArchiveIcon className="size-4" />
            Archived
          </Button>
        </nav>
        <div className="flex flex-wrap gap-2">
          <Input
            className="min-w-48 flex-1"
            aria-label="Search work items"
            placeholder="Search titles and descriptions…"
            value={search}
            onChange={(event) => filter(() => setSearch(event.target.value))}
          />
          <select
            aria-label="Filter by project"
            className={selectClass}
            value={project}
            onChange={(event) => filter(() => setProject(event.target.value))}
          >
            <option value="">All projects</option>
            <option value="unassigned">Unassigned</option>
            {projects.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter by source"
            className={selectClass}
            value={source}
            onChange={(event) => filter(() => setSource(event.target.value))}
          >
            <option value="">All sources</option>
            {["manual", "github_issue", "github_pr", "slack", "automation"].map((value) => (
              <option key={value} value={value}>
                {label(value)}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter by priority"
            className={selectClass}
            value={priority}
            onChange={(event) => filter(() => setPriority(event.target.value))}
          >
            <option value="">All priorities</option>
            {["urgent", "high", "medium", "low"].map((value) => (
              <option key={value} value={value}>
                {label(value)}
              </option>
            ))}
          </select>
          <Button variant="outline" aria-label="Refresh work items" onClick={result.refresh}>
            <RefreshCwIcon className="size-4" />
          </Button>
        </div>
        {(error || result.error) && (
          <p
            role="alert"
            className="rounded-lg border border-destructive/30 p-3 text-sm text-destructive"
          >
            {error ?? result.error}
          </p>
        )}
        {editor && (
          <TaskEditor
            key={`${editor.id}:${editor.item?.revision ?? "new"}`}
            item={editor.item}
            projects={projects}
            threads={threads}
            providers={providers}
            disabled={pending}
            onCancel={() => {
              setEditor(null);
              setError(null);
            }}
            onSave={async (fields) => {
              const saved = await send(
                editor.item
                  ? {
                      kind: "update",
                      id: editor.id,
                      expectedRevision: editor.item.revision,
                      patch: fields,
                    }
                  : {
                      kind: "create",
                      id: editor.id,
                      source: "manual",
                      title: fields.title ?? "",
                      fields,
                    },
              );
              if (saved) setEditor(null);
            }}
          />
        )}
        {result.isPending && !result.data ? (
          <p role="status" className="p-8 text-center text-muted-foreground">
            Loading work items…
          </p>
        ) : null}
        {result.data?.items.length === 0 && (
          <div className="rounded-xl border border-dashed px-6 py-12 text-center">
            <ClipboardListIcon className="mx-auto mb-3 size-7 text-muted-foreground" />
            <h3 className="font-medium">No work items here</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {view === "running" && !archived
                ? "No active planning work. Open a Ready task to plan with an agent."
                : "Create a task or adjust your filters."}
            </p>
          </div>
        )}
        <ul className="flex flex-col gap-3" aria-label="Work items">
          {result.data?.items.map((item) => (
            <li key={item.id} className="rounded-xl border bg-card p-4">
              {activitySupported && (
                <Button
                  size="sm"
                  variant="outline"
                  className="mb-3 mr-2"
                  onClick={() => setActivityId(item.id)}
                >
                  Activity
                </Button>
              )}
              <WorkTaskThreadButton environmentId={environmentId} id={item.id} />
              {planningSupported && (
                <Button
                  size="sm"
                  variant="outline"
                  className="mb-3"
                  onClick={() => setPlanningId(item.id)}
                >
                  Plan / Execution
                </Button>
              )}
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <h3 className="break-words font-medium">{item.title}</h3>
                  <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
                    {[
                      ["source", label(item.source)],
                      [
                        "project",
                        projects.find((project) => project.id === item.projectId)?.title ??
                          (item.projectId ? "Unavailable project" : "Unassigned"),
                      ],
                      ["repository", item.repository],
                      ["priority", label(item.priority)],
                      ["status", label(item.status)],
                      [
                        "agent",
                        item.assignedAgent
                          ? (providers.find(
                              (provider) => provider.instanceId === item.assignedAgent,
                            )?.displayName ?? item.assignedAgent)
                          : null,
                      ],
                    ]
                      .filter(([, text]) => text)
                      .map(([key, text]) => (
                        <span key={key} className="rounded-md bg-muted px-2 py-1">
                          {text}
                        </span>
                      ))}
                  </div>
                </div>
                <Button
                  variant="outline"
                  disabled={pending || item.archivedAt !== null}
                  onClick={() => void edit(item.id)}
                >
                  Edit
                </Button>
              </div>
              {item.bodyPreview && (
                <p className="mt-3 line-clamp-3 whitespace-pre-wrap break-words text-sm text-muted-foreground">
                  {item.bodyPreview}
                </p>
              )}
              {item.failureReason && (
                <p className="mt-3 text-sm text-destructive">Blocked: {item.failureReason}</p>
              )}
              {item.branch && (
                <p className="mt-2 text-xs text-muted-foreground">Branch: {item.branch}</p>
              )}
              <div className="mt-3 flex flex-wrap items-center gap-3">
                {!item.archivedAt && (
                  <StatusEditor
                    key={`${item.id}:${item.revision}`}
                    item={item}
                    disabled={pending}
                    onChange={(status, reason) =>
                      send({
                        kind: "status",
                        id: item.id,
                        expectedRevision: item.revision,
                        status,
                        ...(reason.trim() ? { reason: reason.trim() } : {}),
                      })
                    }
                  />
                )}
                <Button
                  variant="ghost"
                  disabled={pending}
                  onClick={() =>
                    void send({
                      kind: "archive",
                      id: item.id,
                      expectedRevision: item.revision,
                      archived: item.archivedAt === null,
                    })
                  }
                >
                  {item.archivedAt ? "Restore" : "Archive"}
                </Button>
                {item.agentThreadId && (
                  <Link
                    className="text-sm underline"
                    to="/$environmentId/$threadId"
                    params={{ environmentId, threadId: item.agentThreadId }}
                  >
                    Open thread
                  </Link>
                )}
                {item.resources.map((resource) => (
                  <a
                    key={`${resource.source}:${resource.namespace}:${resource.externalId}`}
                    className="text-sm underline"
                    href={resource.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {label(resource.source)} {resource.externalId}
                  </a>
                ))}
              </div>
              <p className="mt-3 select-all text-xs text-muted-foreground">
                Task ID: {item.id}
                {item.parentWorkItemId ? ` · Parent: ${item.parentWorkItemId}` : ""}
              </p>
            </li>
          ))}
        </ul>
        {result.data && (
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>
              {result.data.total} work item{result.data.total === 1 ? "" : "s"}
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - 50))}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                disabled={offset + 50 >= result.data.total}
                onClick={() => setOffset(offset + 50)}
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function StatusEditor({
  item,
  disabled,
  onChange,
}: {
  item: WorkItemSummary;
  disabled: boolean;
  onChange: (status: WorkItemStatus, reason: string) => Promise<boolean>;
}) {
  const [status, setStatus] = useState(item.status);
  const [reason, setReason] = useState(item.failureReason ?? "");
  const active = !WORK_ITEM_MANUAL_STATUSES.some((value) => value === item.status);
  return (
    <form
      className="flex flex-wrap gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void onChange(status, reason);
      }}
    >
      <select
        aria-label={`Status for ${item.title}`}
        className={selectClass}
        disabled={disabled || active}
        value={status}
        onChange={(event) => setStatus(event.target.value as WorkItemStatus)}
      >
        {active && <option value={item.status}>{label(item.status)}</option>}
        {WORK_ITEM_MANUAL_STATUSES.map((value) => (
          <option key={value} value={value}>
            {label(value)}
          </option>
        ))}
      </select>
      {status === "blocked" && (
        <Input
          aria-label="Blocked reason"
          placeholder="Why is this blocked?"
          required
          maxLength={500}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      )}
      <Button
        type="submit"
        variant="outline"
        disabled={disabled || active || status === item.status}
      >
        Move
      </Button>
    </form>
  );
}

function TaskEditor({
  item,
  projects,
  threads,
  providers,
  disabled,
  onCancel,
  onSave,
}: {
  item: WorkItem | null;
  projects: ReturnType<typeof useProjects>;
  threads: ReturnType<typeof useThreadShells>;
  providers: ReadonlyArray<ServerProvider>;
  disabled: boolean;
  onCancel: () => void;
  onSave: (fields: WorkItemPatch) => Promise<void>;
}) {
  const [projectId, setProjectId] = useState(item?.projectId ?? "");
  return (
    <form
      className="flex flex-col gap-4 rounded-xl border bg-card p-5"
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const text = (key: string) => String(data.get(key) ?? "").trim();
        void onSave({
          title: text("title"),
          body: String(data.get("body") ?? ""),
          projectId: projectId ? ProjectId.make(projectId) : null,
          priority: text("priority") as WorkItemPriority,
          repository: text("repository") || null,
          branch: text("branch") || null,
          assignedAgent: text("agent") ? ProviderInstanceId.make(text("agent")) : null,
          agentThreadId: text("thread") ? ThreadId.make(text("thread")) : null,
          parentWorkItemId: text("parent") ? WorkItemId.make(text("parent")) : null,
        });
      }}
    >
      <h3 className="font-medium">{item ? "Edit task" : "Create task"}</h3>
      <fieldset disabled={disabled} className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm sm:col-span-2">
          Title
          <Input name="title" required maxLength={500} defaultValue={item?.title ?? ""} />
        </label>
        <label className="flex flex-col gap-1 text-sm sm:col-span-2">
          Description
          <Textarea name="body" rows={4} maxLength={100000} defaultValue={item?.body ?? ""} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Project
          <select
            className={selectClass}
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
          >
            <option value="">Unassigned</option>
            {projectId && !projects.some((project) => project.id === projectId) && (
              <option value={projectId}>Unavailable project</option>
            )}
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.title}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Priority
          <select className={selectClass} name="priority" defaultValue={item?.priority ?? "medium"}>
            {["low", "medium", "high", "urgent"].map((value) => (
              <option key={value} value={value}>
                {label(value)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Repository
          <Input
            name="repository"
            maxLength={500}
            placeholder="owner/repository"
            defaultValue={item?.repository ?? ""}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Branch
          <Input name="branch" maxLength={500} defaultValue={item?.branch ?? ""} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Assigned agent
          <select className={selectClass} name="agent" defaultValue={item?.assignedAgent ?? ""}>
            <option value="">Unassigned</option>
            {item?.assignedAgent &&
              !providers.some((provider) => provider.instanceId === item.assignedAgent) && (
                <option value={item.assignedAgent}>{item.assignedAgent} (unavailable)</option>
              )}
            {providers.map((provider) => (
              <option key={provider.instanceId} value={provider.instanceId}>
                {provider.displayName ?? provider.instanceId}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Agent thread
          <select
            key={projectId}
            className={selectClass}
            name="thread"
            defaultValue={projectId === item?.projectId ? (item.agentThreadId ?? "") : ""}
          >
            <option value="">No thread</option>
            {projectId === item?.projectId &&
              item.agentThreadId &&
              !threads.some((thread) => thread.id === item.agentThreadId) && (
                <option value={item.agentThreadId}>{item.agentThreadId} (not loaded)</option>
              )}
            {threads
              .filter((thread) => thread.projectId === projectId)
              .map((thread) => (
                <option key={thread.id} value={thread.id}>
                  {thread.title}
                </option>
              ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm sm:col-span-2">
          Parent task ID (optional)
          <Input name="parent" maxLength={500} defaultValue={item?.parentWorkItemId ?? ""} />
        </label>
      </fieldset>
      <div className="flex gap-2">
        <Button type="submit" disabled={disabled}>
          {disabled ? "Saving…" : item ? "Save changes" : "Create task"}
        </Button>
        <Button type="button" variant="ghost" disabled={disabled} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
