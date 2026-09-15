import { ExternalSyncStatus } from "./ExternalSyncStatus";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { useDeferredValue, useState } from "react";
import {
  ProjectId,
  type EnvironmentId,
  type GitHubIssueDetail,
  type GitHubIssueReference,
  type GitHubIssuesMutation,
  type GitHubTrackedRepository,
} from "@t3tools/contracts";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { useProjects } from "../../state/entities";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { githubIssues } from "../../state/workItems";

const selectClass = "h-9 rounded-lg border border-input bg-background px-2 text-sm";
const key = (repo: { host: string; repository: string }) => `${repo.host}/${repo.repository}`;
export function GitHubIssuesPanel({ environmentId }: { environmentId: EnvironmentId }) {
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const [repository, setRepository] = useState("");
  const [label, setLabel] = useState("");
  const [assignee, setAssignee] = useState("");
  const [state, setState] = useState<"open" | "closed" | "all">("open");
  const [offset, setOffset] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<GitHubIssueDetail | null>(null);
  const [editing, setEditing] = useState<GitHubTrackedRepository | null>(null);
  const [showConfig, setShowConfig] = useState(false);
  const [number, setNumber] = useState("");
  const deferredLabel = useDeferredValue(label);
  const deferredAssignee = useDeferredValue(assignee);
  const result = useEnvironmentQuery(
    githubIssues.list({
      environmentId,
      input: {
        ...(repository ? { repository: repository } : {}),
        ...(deferredLabel.trim() ? { label: deferredLabel.trim() } : {}),
        ...(deferredAssignee.trim() ? { assignee: deferredAssignee.trim() } : {}),
        state,
        offset,
        limit: 50,
      },
    }),
  );
  const mutate = useAtomCommand(githubIssues.mutate, { reportFailure: false });
  const read = useAtomCommand(githubIssues.read, { reportFailure: false });
  async function load(ref: GitHubIssueReference) {
    const response = await read({ environmentId, input: ref });
    if (response._tag === "Success") setDetail(response.value);
    else setError(formatEnvironmentQueryError(response.cause));
  }
  async function send(input: GitHubIssuesMutation, showDetail = false) {
    if (pending) return false;
    setPending(true);
    setError(null);
    try {
      const response = await mutate({ environmentId, input });
      result.refresh();
      if (response._tag !== "Success") {
        setError(formatEnvironmentQueryError(response.cause));
        return false;
      }
      if (showDetail && (input.kind === "import" || input.kind === "refresh")) await load(input);
      if (input.kind === "sync" && detail && key(detail) === key(input)) await load(detail);
      if (input.kind === "untrack") {
        setRepository("");
        setDetail(null);
        setOffset(0);
      }
      return true;
    } finally {
      setPending(false);
    }
  }
  const repos = result.data?.repositories ?? [];
  const selected = repos.find((repo) => key(repo) === repository);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
      <div className="mx-auto flex max-w-5xl flex-col gap-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold">GitHub Issues</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Sync tracked repositories using this environment’s GitHub sign-in.
            </p>
          </div>
          <Button
            onClick={() => {
              setEditing(null);
              setShowConfig(true);
            }}
          >
            Track repository
          </Button>
        </div>
        {showConfig && (
          <form
            key={editing ? key(editing) : "new"}
            className="grid gap-3 rounded-xl border p-4 sm:grid-cols-2"
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              void send({
                kind: "configure",
                host: String(data.get("host")).trim(),
                repository: String(data.get("repository")).trim(),
                projectId: data.get("project") ? ProjectId.make(String(data.get("project"))) : null,
                importLabels: String(data.get("labels"))
                  .split(",")
                  .map((value) => value.trim())
                  .filter(Boolean),
              }).then((ok) => {
                if (ok) setShowConfig(false);
              });
            }}
          >
            <label className="grid gap-1 text-sm">
              GitHub host
              <Input
                name="host"
                required
                defaultValue={editing?.host ?? "github.com"}
                readOnly={!!editing}
              />
            </label>
            <label className="grid gap-1 text-sm">
              Repository
              <Input
                name="repository"
                required
                placeholder="owner/repository"
                defaultValue={editing?.repository}
                readOnly={!!editing}
              />
            </label>
            <label className="grid gap-1 text-sm">
              Project for new imports
              <select
                name="project"
                className={selectClass}
                defaultValue={editing?.projectId ?? ""}
              >
                <option value="">No project</option>
                {editing?.projectId &&
                  !projects.some((project) => project.id === editing.projectId) && (
                    <option value={editing.projectId}>Unavailable project</option>
                  )}
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.title}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-sm">
              Import issues matching any label
              <Input
                name="labels"
                placeholder="e.g. ready, agent"
                defaultValue={editing?.importLabels.join(", ")}
              />
            </label>
            <p className="text-sm text-muted-foreground sm:col-span-2">
              Rules import matching open issues when you sync. Leave labels empty for manual import
              only. Imports start in Inbox; agents are never started.
            </p>
            <div className="flex gap-2">
              <Button disabled={pending} type="submit">
                Save
              </Button>
              <Button variant="outline" type="button" onClick={() => setShowConfig(false)}>
                Cancel
              </Button>
            </div>
          </form>
        )}
        <div className="grid gap-2">
          {repos.map((repo) => (
            <div
              key={key(repo)}
              className="flex flex-wrap items-center gap-2 rounded-xl border p-3"
            >
              <div className="min-w-0 flex-1">
                <p className="break-all font-medium">{key(repo)}</p>
                <p className="text-xs text-muted-foreground">
                  {repo.lastSyncedAt
                    ? `Synced ${new Date(repo.lastSyncedAt).toLocaleString()}`
                    : "Not synced yet"}{" "}
                  ·{" "}
                  {repo.importLabels.length
                    ? `Import labels: ${repo.importLabels.join(", ")}`
                    : "Manual imports"}
                </p>
                {repo.syncError && (
                  <p role="alert" className="text-sm text-destructive">
                    {repo.syncError}
                  </p>
                )}
              </div>
              <Button
                size="sm"
                disabled={pending}
                onClick={() => void send({ ...repo, kind: "sync" })}
              >
                Sync
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() => {
                  setEditing(repo);
                  setShowConfig(true);
                }}
              >
                Configure
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() => void send({ ...repo, kind: "untrack" })}
              >
                Untrack
              </Button>
            </div>
          ))}
        </div>
        {repos.length === 0 && !result.isPending && (
          <p className="rounded-xl border border-dashed p-6 text-muted-foreground">
            Track a repository, then sync to browse issues. Untracking clears its issue cache and
            keeps imported work.
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <select
            aria-label="Repository filter"
            className={selectClass}
            value={repository}
            onChange={(event) => {
              setRepository(event.target.value);
              setOffset(0);
            }}
          >
            <option value="">All repositories</option>
            {repos.map((repo) => (
              <option key={key(repo)} value={key(repo)}>
                {key(repo)}
              </option>
            ))}
          </select>
          <Input
            className="w-44"
            aria-label="Label filter"
            placeholder="Exact label"
            value={label}
            onChange={(event) => {
              setLabel(event.target.value);
              setOffset(0);
            }}
          />
          <Input
            className="w-44"
            aria-label="Assignee filter"
            placeholder="Assignee username"
            value={assignee}
            onChange={(event) => {
              setAssignee(event.target.value);
              setOffset(0);
            }}
          />
          <select
            aria-label="GitHub state filter"
            className={selectClass}
            value={state}
            onChange={(event) => {
              setState(event.target.value as typeof state);
              setOffset(0);
            }}
          >
            <option value="open">Open</option>
            <option value="closed">Closed</option>
            <option value="all">All states</option>
          </select>
          <Button variant="outline" onClick={result.refresh}>
            Reload saved issues
          </Button>
        </div>
        {selected && (
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void send({ ...selected, kind: "import", number: Number(number) }, true);
            }}
          >
            <Input
              className="w-40"
              type="number"
              min="1"
              step="1"
              required
              aria-label="Issue number"
              placeholder="Issue number"
              value={number}
              onChange={(event) => setNumber(event.target.value)}
            />
            <Button disabled={pending} type="submit">
              Import to Work Queue
            </Button>
          </form>
        )}
        {pending && (
          <p role="status" className="text-sm text-muted-foreground">
            Updating GitHub issues…
          </p>
        )}
        {(error || result.error) && (
          <p role="alert" className="text-sm text-destructive">
            {error ?? result.error}
          </p>
        )}
        {result.isPending && !result.data && <p>Loading issues…</p>}
        {result.data && result.data.items.length === 0 && (
          <p className="py-6 text-muted-foreground">
            No saved issues match these filters. Sync a repository to fetch its issues.
          </p>
        )}
        <div className="grid gap-3">
          {result.data?.items.map((issue) => (
            <article key={`${key(issue)}:${issue.externalId}`} className="rounded-xl border p-4">
              <p className="text-xs text-muted-foreground">
                {issue.repository} #{issue.number} · GitHub: {issue.state}
                {issue.localStatus ? ` · Work: ${issue.localStatus}` : ""}
              </p>
              <button
                className="mt-1 text-left font-medium hover:underline"
                onClick={() => {
                  setError(null);
                  void load(issue);
                }}
              >
                {issue.title}
              </button>
              <ExternalSyncStatus value={issue} />
              <p className="mt-1 text-sm text-muted-foreground">
                {issue.labels.join(", ") || "No labels"} ·{" "}
                {issue.assignees.join(", ") || "Unassigned"}
                {issue.milestone ? ` · ${issue.milestone}` : ""}
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <Button
                  size="sm"
                  disabled={pending || !!issue.workItemId}
                  onClick={() => void send({ ...issue, kind: "import" }, true)}
                >
                  {issue.workItemId ? "In Work Queue" : "Import to Work Queue"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() => void send({ ...issue, kind: "refresh" }, true)}
                >
                  Refresh details
                </Button>
                <a className="text-sm underline" href={issue.url} target="_blank" rel="noreferrer">
                  Open GitHub
                </a>
              </div>
            </article>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - 50))}
          >
            Previous
          </Button>
          <span className="text-sm text-muted-foreground">{result.data?.total ?? 0} issues</span>
          <Button
            variant="outline"
            disabled={offset + 50 >= (result.data?.total ?? 0)}
            onClick={() => setOffset(offset + 50)}
          >
            Next
          </Button>
        </div>
        {detail && (
          <Dialog
            open
            onOpenChange={(open) => {
              if (!open) setDetail(null);
            }}
          >
            <DialogPopup className="max-w-2xl overflow-y-auto p-6" showCloseButton={false}>
              <div className="flex items-start justify-between gap-3">
                <DialogTitle className="font-semibold">
                  {detail.repository} #{detail.number}: {detail.title}
                </DialogTitle>
                <Button variant="ghost" onClick={() => setDetail(null)}>
                  Close
                </Button>
              </div>
              <p className="text-sm text-muted-foreground">
                GitHub: {detail.state} · Work: {detail.localStatus ?? "Not imported"}
              </p>
              {error && (
                <p role="alert" className="mt-3 text-sm text-destructive">
                  {error}
                </p>
              )}
              {pending && (
                <p role="status" className="mt-3 text-sm text-muted-foreground">
                  Updating issue…
                </p>
              )}
              <p className="mt-4 whitespace-pre-wrap break-words text-sm">
                {detail.body || "No description."}
              </p>
              <div className="my-4 flex items-center gap-3">
                <h4 className="font-medium">Comments</h4>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() => void send({ ...detail, kind: "refresh" }, true)}
                >
                  Refresh issue and comments
                </Button>
              </div>
              {!detail.commentsFetchedAt ? (
                <p className="text-sm text-muted-foreground">Refresh details to load comments.</p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Updated {new Date(detail.commentsFetchedAt).toLocaleString()}
                </p>
              )}
              {detail.commentsFetchedAt && !detail.comments.length && (
                <p className="mt-2 text-sm">No comments.</p>
              )}
              {detail.comments.map((comment) => (
                <article key={comment.id} className="mt-3 border-t pt-3">
                  <a
                    href={comment.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-sm font-medium underline"
                  >
                    {comment.author}
                  </a>
                  <p className="mt-1 whitespace-pre-wrap break-words text-sm">{comment.body}</p>
                </article>
              ))}
            </DialogPopup>
          </Dialog>
        )}
      </div>
    </div>
  );
}
