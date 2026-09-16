import {
  workTaskDiscussionSources,
  workTaskProjectId,
  workTaskBranchName,
  workTaskBranchError,
  workTaskPromptWithDiscussion,
  type WorkTaskDiscussion,
} from "@t3tools/client-runtime/state/work-items";
import { useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { workTaskPrompt, type WorkTaskThreadInput } from "@t3tools/client-runtime/state/work-items";
import {
  ProjectId,
  ThreadId,
  type EnvironmentId,
  type WorkItem,
  type WorkItemId,
} from "@t3tools/contracts";
import { useComposerDraftStore } from "../../composerDraftStore";
import { randomUUID } from "../../lib/utils";
import { useProjects } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery, formatEnvironmentQueryError } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { workItems } from "../../state/workItems";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";

export function WorkTaskThreadButton({
  environmentId,
  id,
}: {
  environmentId: EnvironmentId;
  id: WorkItemId;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        New thread
      </Button>
      {open && (
        <TaskThreadDialog environmentId={environmentId} id={id} onClose={() => setOpen(false)} />
      )}
    </>
  );
}
function TaskThreadDialog({
  environmentId,
  id,
  onClose,
}: {
  environmentId: EnvironmentId;
  id: WorkItemId;
  onClose: () => void;
}) {
  const [pending, setPending] = useState(false);
  const query = useEnvironmentQuery(workItems.get({ environmentId, input: { id } }));
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogPopup className="max-w-2xl overflow-y-auto p-6">
        <DialogTitle>New thread from task</DialogTitle>
        {query.error && (
          <p role="alert" className="text-destructive">
            {query.error}
          </p>
        )}
        {!query.data && query.isPending && <p>Loading task…</p>}
        {query.data && (
          <TaskThreadForm
            environmentId={environmentId}
            task={query.data}
            onClose={onClose}
            pending={pending}
            setPending={setPending}
          />
        )}
      </DialogPopup>
    </Dialog>
  );
}
function TaskThreadForm({
  environmentId,
  task,
  onClose,
  pending,
  setPending,
}: {
  environmentId: EnvironmentId;
  task: WorkItem;
  onClose: () => void;
  pending: boolean;
  setPending: (pending: boolean) => void;
}) {
  const navigate = useNavigate();
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const { environments } = useEnvironments();
  const providers = (
    environments.find((environment) => environment.environmentId === environmentId)?.serverConfig
      ?.providers ?? []
  ).filter((provider) => provider.enabled && provider.models.length > 0);
  const [projectId, setProjectId] = useState(() => workTaskProjectId(task, projects));
  const project = projects.find((project) => project.id === projectId);
  const [newBranch, setNewBranch] = useState(true);
  const [branchName, setBranchName] = useState(() => workTaskBranchName(task));
  const [baseSelection, setBaseSelection] = useState("");
  const branches = useEnvironmentQuery(
    workItems.branches({
      environmentId,
      input: { cwd: newBranch ? (project?.workspaceRoot ?? null) : null },
    }),
  );
  const baseBranch =
    branches.data?.find((ref) => ref.name === baseSelection)?.name ??
    branches.data?.find((ref) => ref.isDefault)?.name ??
    branches.data?.find(({ current }) => current)?.name ??
    branches.data?.[0]?.name ??
    "";
  const branchError = newBranch ? workTaskBranchError(branchName) : null;
  const prepared = useRef<WorkTaskThreadInput["worktree"]>(undefined);
  const prepareBranch = useAtomCommand(workItems.prepareBranch, { reportFailure: false });
  const [providerId, setProviderId] = useState(task.assignedAgent ?? "");
  const [model, setModel] = useState("");
  const provider = providers.find((provider) => provider.instanceId === providerId) ?? providers[0];
  const selectedModel =
    provider?.models.find((candidate) => candidate.slug === model) ??
    provider?.models.find((candidate) => candidate.isDefault) ??
    provider?.models[0];
  const [prompt, setPrompt] = useState(() => workTaskPrompt(task));
  const [contextTask, setContextTask] = useState(task);
  const [discussions, setDiscussions] = useState<WorkTaskDiscussion[]>([]);
  const sources = workTaskDiscussionSources(contextTask);

  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<ThreadId | null>(null);
  const attempt = useRef<WorkTaskThreadInput | null>(null);
  const [hasAttempt, setHasAttempt] = useState(false);
  const start = useAtomCommand(workItems.startThread, { reportFailure: false });
  const fetchDiscussion = useAtomCommand(workItems.discussion, { reportFailure: false });
  async function addDiscussion(sourceKey: string, more = false) {
    if (pending || hasAttempt) return;
    setPending(true);
    setError(null);
    try {
      const response = await fetchDiscussion({
        environmentId,
        input: { taskId: task.id, sourceKey, more },
      });
      if (response._tag !== "Success") {
        setError(formatEnvironmentQueryError(response.cause));
        return;
      }
      setContextTask(response.value.task);
      const next = [
        ...discussions.filter((discussion) => discussion.source.key !== sourceKey),
        response.value.context,
      ];
      if (next.reduce((size, discussion) => size + discussion.text.length, 0) > 48_000) {
        setError("Discussion context is full. Remove another discussion before adding more.");
        return;
      }
      setDiscussions(next);
    } finally {
      setPending(false);
    }
  }

  async function openThread(threadId: ThreadId) {
    try {
      useComposerDraftStore
        .getState()
        .setPrompt(
          scopeThreadRef(environmentId, threadId),
          workTaskPromptWithDiscussion(prompt, discussions),
        );
      await navigate({ to: "/$environmentId/$threadId", params: { environmentId, threadId } });
      onClose();
    } catch {
      setError("Thread created, but it could not be opened. Try opening it again.");
    }
  }
  async function submit() {
    if (pending || !provider || !selectedModel || !projectId || !prompt.trim()) return;
    setPending(true);
    setError(null);
    try {
      if (newBranch && !prepared.current) {
        if (!project || !baseBranch || branchError) return;
        const result = await prepareBranch({
          environmentId,
          input: { task: contextTask, cwd: project.workspaceRoot, baseBranch, branch: branchName },
        });
        if (result._tag !== "Success") {
          setError(formatEnvironmentQueryError(result.cause));
          return;
        }
        prepared.current = result.value.worktree;
      }
      setHasAttempt(true);
      attempt.current ??= {
        task: contextTask,
        projectId: ProjectId.make(projectId),
        threadId: ThreadId.make(randomUUID()),
        modelSelection: { instanceId: provider.instanceId, model: selectedModel.slug },
        createdAt: new Date().toISOString(),
        ...(prepared.current ? { worktree: prepared.current } : {}),
      };
      const response = await start({ environmentId, input: attempt.current });
      if (response._tag !== "Success") {
        setError(formatEnvironmentQueryError(response.cause));
        return;
      }
      setCreated(response.value.threadId);
      if (response.value.warning) {
        setError(response.value.warning);
        return;
      }
      await openThread(response.value.threadId);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Could not create the thread. Retry later.",
      );
    } finally {
      setPending(false);
    }
  }
  const selectClass = "h-9 rounded-lg border border-input bg-background px-2 text-sm";
  return (
    <form
      className="mt-4 grid gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <p className="text-sm text-muted-foreground">
        Choose where to work and review the prompt. The thread opens with this text ready to send.
      </p>
      {task.agentThreadId && (
        <p className="text-sm text-muted-foreground">
          The new thread will become this task’s linked thread. The previous thread stays available
          in its project.
        </p>
      )}
      <label className="grid gap-1 text-sm">
        Repository
        <select
          className={selectClass}
          value={projectId}
          disabled={pending || hasAttempt}
          onChange={(event) => {
            setProjectId(event.target.value);
            setBaseSelection("");
          }}
          required
        >
          <option value="">Choose a repository</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.title} — {project.workspaceRoot}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={newBranch}
          disabled={pending || hasAttempt}
          onChange={(event) => setNewBranch(event.target.checked)}
        />
        Create a new branch in a separate worktree
      </label>
      {newBranch && (
        <>
          <label className="grid gap-1 text-sm">
            Base branch
            <select
              className={selectClass}
              value={baseBranch}
              disabled={pending || hasAttempt || branches.isPending}
              onChange={(event) => setBaseSelection(event.target.value)}
              required
            >
              <option value="">
                {branches.isPending ? "Loading branches…" : "Choose a base branch"}
              </option>
              {branches.data?.map((ref) => (
                <option key={ref.name} value={ref.name}>
                  {ref.name}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-sm">
            New branch name
            <input
              className={selectClass}
              value={branchName}
              disabled={pending || hasAttempt}
              onChange={(event) => setBranchName(event.target.value)}
              required
            />
          </label>
          {branchError && <p className="text-sm text-destructive">{branchError}</p>}
          {branches.error && (
            <p role="alert" className="text-sm text-destructive">
              {branches.error}
            </p>
          )}
          {!branches.isPending && project && !branches.error && !branches.data?.length && (
            <p>
              This repository has no base branches. Select another repository or use its current
              checkout.
            </p>
          )}
        </>
      )}
      <label className="grid gap-1 text-sm">
        Agent
        <select
          className={selectClass}
          value={provider?.instanceId ?? ""}
          disabled={pending || hasAttempt}
          onChange={(event) => {
            setProviderId(event.target.value);
            setModel("");
          }}
        >
          {providers.map((provider) => (
            <option key={provider.instanceId} value={provider.instanceId}>
              {provider.displayName ?? provider.instanceId}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1 text-sm">
        Model
        <select
          className={selectClass}
          value={selectedModel?.slug ?? ""}
          disabled={pending || hasAttempt}
          onChange={(event) => setModel(event.target.value)}
        >
          {provider?.models.map((model) => (
            <option key={model.slug} value={model.slug}>
              {model.slug}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1 text-sm">
        Prompt
        <Textarea
          className="min-h-64"
          value={prompt}
          disabled={pending}
          onChange={(event) => setPrompt(event.target.value)}
        />
      </label>
      {sources.length > 0 && (
        <section className="grid gap-2" aria-label="Optional discussion context">
          <h3 className="text-sm font-medium">Discussion context (optional)</h3>
          <p className="text-sm text-muted-foreground">
            Add comments or thread replies to the prompt. You can review and edit the combined text
            in the chat composer before sending.
          </p>
          {sources
            .filter(
              (source) => !discussions.some((discussion) => discussion.source.key === source.key),
            )
            .map((source) => (
              <Button
                key={source.key}
                type="button"
                variant="outline"
                disabled={pending || hasAttempt}
                onClick={() => void addDiscussion(source.key)}
              >
                Add {source.label}
              </Button>
            ))}
          {discussions.map((discussion) => (
            <div key={discussion.source.key} className="grid gap-2 rounded-lg border p-3">
              <p className="text-sm font-medium">{discussion.source.label}</p>
              <Textarea
                aria-label={discussion.source.label}
                value={discussion.text}
                readOnly
                className="min-h-32"
              />
              {discussion.truncated && (
                <p className="text-sm text-muted-foreground">
                  Discussion shortened. Open the source for the remaining context.
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                {discussion.hasMore && !discussion.truncated && (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={pending || hasAttempt}
                    onClick={() => void addDiscussion(discussion.source.key, true)}
                  >
                    Load more replies
                  </Button>
                )}
                <Button
                  type="button"
                  variant="outline"
                  disabled={pending}
                  onClick={() =>
                    setDiscussions((current) =>
                      current.filter((item) => item.source.key !== discussion.source.key),
                    )
                  }
                >
                  Remove context
                </Button>
              </div>
            </div>
          ))}
        </section>
      )}
      {!projects.length && <p>Add a project before starting a thread.</p>}
      {!providers.length && <p>Enable an agent provider before starting a thread.</p>}
      {task.archivedAt && <p>Restore this task before starting a linked thread.</p>}
      {hasAttempt && newBranch && !created && (
        <p className="text-sm text-muted-foreground">
          Branch {branchName} is ready. Retry will use it. Closing this dialog keeps the branch and
          worktree.
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        {created ? (
          <Button type="button" onClick={() => void openThread(created)}>
            Open created thread
          </Button>
        ) : (
          <Button
            type="submit"
            disabled={
              pending ||
              !projects.some((project) => project.id === projectId) ||
              (newBranch &&
                (!baseBranch || !!branchError || !!branches.error || branches.isPending)) ||
              !selectedModel ||
              !prompt.trim() ||
              !!task.archivedAt
            }
          >
            {pending
              ? hasAttempt
                ? "Creating thread…"
                : "Preparing…"
              : hasAttempt
                ? "Retry"
                : "Create thread"}
          </Button>
        )}
        <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
