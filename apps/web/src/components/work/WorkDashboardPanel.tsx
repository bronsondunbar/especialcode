import { WorkPlanPanel } from "./WorkPlanPanel";
import { WorkActivityPanel } from "./WorkActivityPanel";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { useEnvironments } from "../../state/environments";
import { useDeferredValue, useState } from "react";
import { Link } from "@tanstack/react-router";
import { createWorkDashboardAtoms } from "@t3tools/client-runtime/state/work-items";
import {
  WORK_DASHBOARD_SECTIONS,
  ProjectId,
  ProviderInstanceId,
  type EnvironmentId,
  type ServerProvider,
  type WorkDashboardInput,
  type WorkItemId,
  type WorkItemSource,
  type WorkItemStatus,
  type WorkItemPriority,
} from "@t3tools/contracts";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useEnvironmentQuery } from "../../state/query";
import { useProjects } from "../../state/entities";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
const atoms = createWorkDashboardAtoms(connectionAtomRuntime);
const label = (s: string) => s.replaceAll("_", " ");
const selectClass = "h-9 min-w-0 rounded-lg border border-input bg-background px-2 text-sm";
function WorkDashboardPanel({
  environmentId,
  providers,
  onOpen,
  onActivity,
}: {
  environmentId: EnvironmentId;
  providers: ReadonlyArray<ServerProvider>;
  onOpen: (id: WorkItemId) => void;
  onActivity: (id: WorkItemId) => void;
}) {
  const projects = useProjects().filter((p) => p.environmentId === environmentId);
  const [filters, setFilters] = useState<WorkDashboardInput>({});
  const input = useDeferredValue(filters);
  const query = useEnvironmentQuery(atoms.list({ environmentId, input }));
  function filter(patch: Partial<WorkDashboardInput>) {
    setFilters((previous) => ({ ...previous, ...patch, offset: 0 }));
  }
  return (
    <div className="flex-1 overflow-y-auto p-4 md:p-6">
      <div className="mx-auto grid max-w-7xl gap-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-2xl font-semibold">Developer dashboard</h2>
            <p className="text-sm text-muted-foreground">
              Attention, execution, and review across your projects.
            </p>
          </div>
          <Button variant="outline" onClick={query.refresh}>
            Refresh
          </Button>
        </div>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3" aria-label="Dashboard filters">
          <select
            aria-label="Filter by project"
            className={selectClass}
            value={filters.projectId ?? ""}
            onChange={(e) => {
              const { projectId: _, ...rest } = filters;
              setFilters(
                e.target.value
                  ? { ...rest, projectId: ProjectId.make(e.target.value), offset: 0 }
                  : { ...rest, offset: 0 },
              );
            }}
          >
            <option value="">All projects</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </select>
          <Input
            aria-label="Filter by repository"
            placeholder="Repository: owner/repository"
            value={filters.repository ?? ""}
            onChange={(e) => {
              const { repository: _, ...rest } = filters;
              setFilters(
                e.target.value
                  ? { ...rest, repository: e.target.value, offset: 0 }
                  : { ...rest, offset: 0 },
              );
            }}
          />
          <select
            aria-label="Filter by agent"
            className={selectClass}
            value={filters.agent ?? ""}
            onChange={(e) => {
              const { agent: _, ...rest } = filters;
              setFilters(
                e.target.value
                  ? { ...rest, agent: ProviderInstanceId.make(e.target.value), offset: 0 }
                  : { ...rest, offset: 0 },
              );
            }}
          >
            <option value="">All agents</option>
            {providers.map((p) => (
              <option key={p.instanceId} value={p.instanceId}>
                {p.displayName ?? p.driver}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter by source"
            className={selectClass}
            value={filters.source ?? ""}
            onChange={(e) => {
              const { source: _, ...rest } = filters;
              setFilters(
                e.target.value
                  ? { ...rest, source: e.target.value as WorkItemSource, offset: 0 }
                  : { ...rest, offset: 0 },
              );
            }}
          >
            <option value="">All sources</option>
            {["manual", "github_issue", "github_pr", "slack", "automation"].map((s) => (
              <option key={s} value={s}>
                {label(s)}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter by status"
            className={selectClass}
            value={filters.status ?? ""}
            onChange={(e) => {
              const { status: _, ...rest } = filters;
              setFilters(
                e.target.value
                  ? { ...rest, status: e.target.value as WorkItemStatus, offset: 0 }
                  : { ...rest, offset: 0 },
              );
            }}
          >
            <option value="">All statuses</option>
            {[
              "inbox",
              "backlog",
              "ready",
              "planning",
              "awaiting_approval",
              "running",
              "blocked",
              "review",
              "done",
              "cancelled",
            ].map((s) => (
              <option key={s} value={s}>
                {label(s)}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter by priority"
            className={selectClass}
            value={filters.priority ?? ""}
            onChange={(e) => {
              const { priority: _, ...rest } = filters;
              setFilters(
                e.target.value
                  ? { ...rest, priority: e.target.value as WorkItemPriority, offset: 0 }
                  : { ...rest, offset: 0 },
              );
            }}
          >
            <option value="">All priorities</option>
            {["urgent", "high", "medium", "low"].map((s) => (
              <option key={s} value={s}>
                {label(s)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant={!filters.section ? "secondary" : "ghost"}
            onClick={() => {
              const { section: _, ...rest } = filters;
              setFilters({ ...rest, offset: 0 });
            }}
          >
            Overview
          </Button>
          {WORK_DASHBOARD_SECTIONS.map((s) => (
            <Button
              key={s.id}
              variant={filters.section === s.id ? "secondary" : "ghost"}
              onClick={() => filter({ section: s.id })}
            >
              {s.title}
            </Button>
          ))}
          <Button variant="ghost" onClick={() => setFilters({})}>
            Clear filters
          </Button>
        </div>
        {query.error && (
          <p role="alert" className="text-sm text-destructive">
            {query.error}
          </p>
        )}
        {!query.data && !query.error && <p className="text-muted-foreground">Loading dashboard…</p>}
        <div
          className={
            filters.section ? "grid gap-4" : "grid items-start gap-4 lg:grid-cols-2 xl:grid-cols-3"
          }
        >
          {query.data?.sections.map((section) => (
            <section key={section.id} className="min-w-0 rounded-xl border bg-card p-4">
              <div className="mb-3 flex items-center justify-between gap-2">
                <h3 className="font-semibold">
                  {WORK_DASHBOARD_SECTIONS.find((s) => s.id === section.id)?.title}
                </h3>
                <span className="text-sm tabular-nums text-muted-foreground">{section.total}</span>
              </div>
              {section.items.length === 0 && (
                <p className="py-4 text-sm text-muted-foreground">No matching tasks.</p>
              )}
              <ul className="divide-y">
                {section.items.map((item) => (
                  <li key={item.id} className="grid gap-2 py-3">
                    <button
                      className="text-left text-sm font-medium hover:underline"
                      onClick={() => onOpen(item.id)}
                    >
                      {item.title}
                    </button>
                    <p className="text-xs text-muted-foreground">
                      {item.project ?? "Unassigned project"} · {label(item.priority)} ·{" "}
                      {label(item.status)}
                    </p>
                    <p className="break-words text-xs text-muted-foreground">
                      {item.repository ?? label(item.source)}
                      {item.agent &&
                        ` · ${item.agentName ?? providers.find((p) => p.instanceId === item.agent)?.displayName ?? item.agent}`}
                    </p>
                    {item.activity && <p className="text-sm">{item.activity}</p>}
                    {item.reasons.length > 0 && (
                      <p className="text-xs font-medium text-amber-700 dark:text-amber-400">
                        {item.reasons.join(" · ")}
                      </p>
                    )}
                    <div className="flex flex-wrap gap-3 text-xs">
                      <button className="hover:underline" onClick={() => onOpen(item.id)}>
                        Plan / execution
                      </button>
                      <button className="hover:underline" onClick={() => onActivity(item.id)}>
                        Activity
                      </button>
                      {item.threadId && (
                        <Link
                          className="hover:underline"
                          to="/$environmentId/$threadId"
                          params={{ environmentId, threadId: item.threadId }}
                        >
                          Open agent
                        </Link>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
              {filters.section ? (
                <div className="mt-3 flex items-center justify-between gap-2 text-xs">
                  <Button
                    variant="ghost"
                    disabled={!(filters.offset ?? 0)}
                    onClick={() =>
                      setFilters({ ...filters, offset: Math.max(0, (filters.offset ?? 0) - 8) })
                    }
                  >
                    Previous
                  </Button>
                  <span>
                    {section.items.length
                      ? `${(filters.offset ?? 0) + 1}–${(filters.offset ?? 0) + section.items.length} of ${section.total}`
                      : `${section.total} matching tasks`}
                  </span>
                  <Button
                    variant="ghost"
                    disabled={(filters.offset ?? 0) + section.items.length >= section.total}
                    onClick={() => setFilters({ ...filters, offset: (filters.offset ?? 0) + 8 })}
                  >
                    Next
                  </Button>
                </div>
              ) : (
                section.total > section.items.length && (
                  <Button variant="ghost" onClick={() => filter({ section: section.id })}>
                    View all {section.total}
                  </Button>
                )
              )}
            </section>
          ))}
        </div>
        <section className="rounded-xl border bg-card p-4">
          <h3 className="mb-3 font-semibold">Recent Activity</h3>
          <p className="mb-3 text-xs text-muted-foreground">
            Latest 12 events for the current filters. PR information reflects the latest sync.
          </p>
          {query.data?.activity.length === 0 && (
            <p className="text-sm text-muted-foreground">No matching activity.</p>
          )}
          <ol className="divide-y">
            {query.data?.activity.map((event) => (
              <li key={event.id} className="grid gap-1 py-3 sm:grid-cols-[1fr_auto]">
                <button
                  className="text-left text-sm hover:underline"
                  onClick={() => onActivity(event.workItemId)}
                >
                  {event.workItemTitle} · {event.title}
                </button>
                <time className="text-xs text-muted-foreground" dateTime={event.occurredAt}>
                  {new Date(event.occurredAt).toLocaleString()}
                </time>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </div>
  );
}

export function WorkDashboard({
  environmentId,
  providers,
}: {
  environmentId: EnvironmentId;
  providers: ReadonlyArray<ServerProvider>;
}) {
  const { environments } = useEnvironments();
  const capabilities = environments.find((e) => e.environmentId === environmentId)?.serverConfig
    ?.environment.capabilities;
  const [task, setTask] = useState<WorkItemId | null>(null);
  const [activity, setActivity] = useState<WorkItemId | null>(null);
  return (
    <>
      <WorkDashboardPanel
        environmentId={environmentId}
        providers={providers}
        onOpen={setTask}
        onActivity={setActivity}
      />
      {task && (
        <WorkPlanPanel
          key={task}
          environmentId={environmentId}
          id={task}
          onClose={() => setTask(null)}
          executionSupported={capabilities?.workExecutions === true}
          pullRequestsSupported={capabilities?.workPullRequests === true}
          reviewsSupported={capabilities?.workReviews === true}
        />
      )}
      {activity && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setActivity(null);
          }}
        >
          <DialogPopup className="max-w-3xl overflow-y-auto p-6">
            <DialogTitle>Task activity</DialogTitle>
            <WorkActivityPanel environmentId={environmentId} id={activity} />
          </DialogPopup>
        </Dialog>
      )}
    </>
  );
}
