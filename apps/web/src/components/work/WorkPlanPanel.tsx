import { Tabs } from "@base-ui/react/tabs";
import { WorkRepositoryField, useWorkTaskRepository } from "./WorkRepositoryField";
import { WorkDetails } from "./WorkDetails";
import { WorkActivityPanel } from "./WorkActivityPanel";
import { WorkTaskContext, WorkTaskDiscussions } from "./WorkTaskContext";
import { WorkReviewPanel } from "./WorkReviewPanel";
import { WorkPullRequestPanel } from "./WorkPullRequestPanel";
import { WorkExecutionPanel } from "./WorkExecutionPanel";
import { useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  ProviderInstanceId,
  WORK_PLAN_SECTIONS,
  type EnvironmentId,
  type WorkItemId,
  type WorkPlanContent,
  type WorkPlanMutation,
} from "@t3tools/contracts";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { Button, buttonVariants } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { randomUUID } from "../../lib/utils";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { workPlans } from "../../state/workItems";
type Command = WorkPlanMutation extends infer T
  ? T extends WorkPlanMutation
    ? Omit<T, "commandId" | "id">
    : never
  : never;
export function WorkPlanPanel({
  environmentId,
  id,
  onClose,
  executionSupported = false,
  pullRequestsSupported = false,
  reviewsSupported = false,
}: {
  environmentId: EnvironmentId;
  id: WorkItemId;
  onClose: () => void;
  executionSupported?: boolean;
  pullRequestsSupported?: boolean;
  reviewsSupported?: boolean;
}) {
  const navigate = useNavigate();
  const result = useEnvironmentQuery(workPlans.get({ environmentId, input: { id } }));
  const mutate = useAtomCommand(workPlans.mutate, { reportFailure: false });
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [feedback, setFeedback] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ revision: number; content: WorkPlanContent } | null>(null);
  const [actionTab, setActionTab] = useState<"plan" | "execute">("plan");
  const [executionVisited, setExecutionVisited] = useState(false);
  const visibleTab = executionSupported && !editor ? actionTab : "plan";
  const previous = useRef<{ key: string; command: WorkPlanMutation } | null>(null);
  const data = result.data;
  const repository = useWorkTaskRepository(environmentId, data?.item);
  const canPlan =
    !!data &&
    ["inbox", "backlog", "ready", "awaiting_approval", "blocked"].includes(data.item.status);
  const plan = data?.plan;
  const agent =
    data?.agents.find(
      (agent) =>
        agent.instanceId ===
        (provider || plan?.modelSelection.instanceId || data.item.assignedAgent),
    ) ?? data?.agents[0];
  const chosenModel =
    agent?.models.find((candidate) => candidate.slug === model)?.slug ??
    agent?.models.find((candidate) => candidate.slug === plan?.modelSelection.model)?.slug ??
    agent?.models.find((candidate) => candidate.isDefault)?.slug ??
    agent?.models[0]?.slug;
  const generating = plan?.status === "generating";
  async function send(command: Command) {
    if (pending) return;
    setPending(true);
    setError(null);
    const key = JSON.stringify(command);
    const input =
      previous.current?.key === key
        ? previous.current.command
        : { ...command, id, commandId: randomUUID() };
    previous.current = { key, command: input };
    try {
      const response = await mutate({ environmentId, input });
      if (response._tag === "Success") {
        previous.current = null;
        setEditor(null);
        result.refresh();
      } else setError(formatEnvironmentQueryError(response.cause));
    } finally {
      setPending(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="max-w-3xl overflow-y-auto p-6" showCloseButton={false}>
        <div className="flex items-start justify-between gap-3">
          <DialogTitle>{data?.item.title ?? "Task"}</DialogTitle>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
        {(error || result.error) && (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {error ?? result.error}
          </p>
        )}
        {!data ? (
          <p className="mt-4">Loading task…</p>
        ) : (
          <div className="mt-5 flex flex-col gap-4">
            <WorkTaskContext environmentId={environmentId} item={data.item} />
            <Tabs.Root
              value={visibleTab}
              onValueChange={(value) => {
                if (value !== "plan" && value !== "execute") return;
                setActionTab(value);
                if (value === "execute") setExecutionVisited(true);
              }}
              className="grid min-w-0 gap-4"
            >
              <Tabs.List
                aria-label="Agent action"
                className="flex w-fit gap-1 rounded-lg border bg-input/40 p-1"
              >
                <Tabs.Tab
                  value="plan"
                  className={buttonVariants({
                    variant: "ghost",
                    className: "data-active:bg-background data-active:shadow-sm",
                  })}
                >
                  Plan
                </Tabs.Tab>
                {executionSupported && (
                  <Tabs.Tab
                    value="execute"
                    disabled={!!editor}
                    className={buttonVariants({
                      variant: "ghost",
                      className: "data-active:bg-background data-active:shadow-sm",
                    })}
                  >
                    Execute
                  </Tabs.Tab>
                )}
              </Tabs.List>
              <Tabs.Panel
                value="plan"
                keepMounted
                className="grid min-w-0 gap-4 data-[hidden]:hidden"
              >
                <WorkRepositoryField {...repository} disabled={pending || generating} />
                <p className="text-sm text-muted-foreground">
                  Planning inspects repository snapshots without changing files. A dedicated agent
                  thread keeps the generated result.
                </p>
                <div className="flex flex-wrap gap-3">
                  <label className="grid gap-1 text-sm">
                    Agent
                    <select
                      className="h-9 rounded-lg border bg-background px-2"
                      value={agent?.instanceId ?? ""}
                      disabled={generating}
                      onChange={(event) => {
                        setProvider(event.target.value);
                        setModel("");
                      }}
                    >
                      <option value="" disabled>
                        Select agent
                      </option>
                      {data.agents.map((agent) => (
                        <option key={agent.instanceId} value={agent.instanceId}>
                          {agent.displayName ?? agent.driver}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="grid gap-1 text-sm">
                    Model
                    <select
                      className="h-9 rounded-lg border bg-background px-2"
                      disabled={generating}
                      value={chosenModel ?? ""}
                      onChange={(event) => setModel(event.target.value)}
                    >
                      <option value="" disabled>
                        Select model
                      </option>
                      {agent?.models.map((model) => (
                        <option key={model.slug} value={model.slug}>
                          {model.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                {!data.agents.length && (
                  <p className="text-sm text-muted-foreground">
                    Enable a supported, signed-in provider in Settings. Protected planning supports
                    Codex, Claude, OpenCode and Antigravity; Cursor and Grok are unavailable for
                    this workflow.
                  </p>
                )}
                {!generating && (
                  <label className="grid gap-1 text-sm">
                    Guidance for this plan (optional)
                    <Textarea
                      value={feedback}
                      maxLength={20000}
                      placeholder="Constraints, questions, or changes for a regenerated plan"
                      onChange={(event) => setFeedback(event.target.value)}
                    />
                  </label>
                )}
                {!generating && !canPlan && (
                  <p className="text-sm text-muted-foreground">
                    Finish active work or reopen this task before starting a plan.
                  </p>
                )}
                {data.item.archivedAt && (
                  <p className="text-sm text-muted-foreground">
                    Restore this task before starting a plan.
                  </p>
                )}
                {generating ? (
                  <div className="flex items-center gap-3">
                    <p role="status">Planning with {plan.agentName}… You can close this view.</p>
                    <Button
                      variant="outline"
                      disabled={pending || data.item.status === "running"}
                      onClick={() => void send({ kind: "cancel", expectedRevision: plan.revision })}
                    >
                      Cancel planning
                    </Button>
                  </div>
                ) : (
                  <Button
                    className="self-start"
                    disabled={
                      pending ||
                      !agent ||
                      !chosenModel ||
                      !repository.projectId ||
                      data.item.archivedAt !== null ||
                      !canPlan
                    }
                    onClick={() => {
                      if (agent && chosenModel && repository.projectId)
                        void send({
                          kind: "start",
                          expectedWorkItemRevision: data.item.revision,
                          projectId: repository.projectId,
                          modelSelection: {
                            instanceId: ProviderInstanceId.make(agent.instanceId),
                            model: chosenModel,
                          },
                          feedback,
                        });
                    }}
                  >
                    {plan ? "Regenerate plan" : "Plan with Agent"}
                  </Button>
                )}
              </Tabs.Panel>
              {executionSupported && (
                <Tabs.Panel value="execute" keepMounted className="data-[hidden]:hidden">
                  {executionVisited && (
                    <WorkExecutionPanel
                      environmentId={environmentId}
                      id={id}
                      plan={plan ?? null}
                      onClose={onClose}
                    />
                  )}
                </Tabs.Panel>
              )}
            </Tabs.Root>
            <WorkTaskDiscussions environmentId={environmentId} item={data.item} />
            {plan && (
              <WorkDetails title="Plan details">
                {plan && (
                  <p className="text-sm text-muted-foreground">
                    {plan.agentName} · {plan.modelSelection.model} · {plan.status} · Revision{" "}
                    {plan.revision}
                    {plan.generatedAt
                      ? ` · Generated ${new Date(plan.generatedAt).toLocaleString()}`
                      : ""}
                  </p>
                )}
                {plan?.content && (
                  <Button
                    variant="outline"
                    className="self-start"
                    onClick={() => {
                      onClose();
                      void navigate({
                        to: "/$environmentId/$threadId",
                        params: { environmentId, threadId: plan.threadId },
                      });
                    }}
                  >
                    View agent thread
                  </Button>
                )}
                {plan?.error && (
                  <p role="alert" className="text-sm text-destructive">
                    {plan.error}
                  </p>
                )}
                {plan?.status === "approved" && data.item.status === "ready" && (
                  <p className="text-sm">
                    {plan.approvedWorkItemRevision === data.item.revision
                      ? "Plan approved. Review validation commands before execution."
                      : "Work changed since approval. Regenerate the plan before execution."}
                  </p>
                )}
                {editor ? (
                  <form
                    className="grid gap-3"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void send({
                        kind: "edit",
                        expectedRevision: editor.revision,
                        content: editor.content,
                      });
                    }}
                  >
                    <label className="grid gap-1 text-sm">
                      Summary
                      <Textarea
                        required
                        value={editor.content.summary}
                        onChange={(event) =>
                          setEditor({
                            ...editor,
                            content: { ...editor.content, summary: event.target.value },
                          })
                        }
                      />
                    </label>
                    {WORK_PLAN_SECTIONS.map((section) => (
                      <label key={section.key} className="grid gap-1 text-sm">
                        {section.label} (one entry per line)
                        <Textarea
                          value={editor.content[section.key].join("\n")}
                          onChange={(event) =>
                            setEditor({
                              ...editor,
                              content: {
                                ...editor.content,
                                [section.key]: event.target.value.split("\n"),
                              },
                            })
                          }
                        />
                      </label>
                    ))}
                    <label className="grid gap-1 text-sm">
                      Complexity
                      <select
                        className="h-9 rounded border bg-background"
                        value={editor.content.complexity}
                        onChange={(event) =>
                          setEditor({
                            ...editor,
                            content: {
                              ...editor.content,
                              complexity: event.target.value as WorkPlanContent["complexity"],
                            },
                          })
                        }
                      >
                        {["low", "medium", "high"].map((value) => (
                          <option key={value}>{value}</option>
                        ))}
                      </select>
                    </label>
                    <div className="flex gap-2">
                      <Button disabled={pending || data.item.status === "running"} type="submit">
                        Save plan
                      </Button>
                      <Button variant="outline" type="button" onClick={() => setEditor(null)}>
                        Cancel edit
                      </Button>
                    </div>
                  </form>
                ) : (
                  plan?.content && (
                    <section className="grid gap-4 rounded-xl border p-4">
                      <p className="whitespace-pre-wrap">{plan.content.summary}</p>
                      {WORK_PLAN_SECTIONS.map((section) => (
                        <div key={section.key}>
                          <h3 className="font-medium">{section.label}</h3>
                          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
                            {Array.from(new Set(plan.content![section.key])).map((entry) => (
                              <li key={entry} className="whitespace-pre-wrap break-words">
                                {entry}
                              </li>
                            ))}
                          </ul>
                        </div>
                      ))}
                      <p className="text-sm">Complexity: {plan.content.complexity}</p>
                      <p className="text-xs text-muted-foreground">
                        Inspected files:{" "}
                        {plan.inspectedFiles.join(", ") || "No readable source files"}
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          variant="outline"
                          disabled={pending || data.item.status === "running"}
                          onClick={() =>
                            setEditor({ revision: plan.revision, content: plan.content! })
                          }
                        >
                          Edit plan
                        </Button>
                        {plan.status === "draft" && (
                          <>
                            <Button
                              disabled={pending || data.item.status === "running"}
                              onClick={() =>
                                void send({ kind: "approve", expectedRevision: plan.revision })
                              }
                            >
                              Approve plan
                            </Button>
                            <Button
                              variant="outline"
                              disabled={pending || data.item.status === "running"}
                              onClick={() =>
                                void send({ kind: "reject", expectedRevision: plan.revision })
                              }
                            >
                              Reject / replan
                            </Button>
                          </>
                        )}
                      </div>
                    </section>
                  )
                )}
              </WorkDetails>
            )}
            {pullRequestsSupported && !editor && (
              <WorkDetails title="Pull requests">
                <WorkPullRequestPanel environmentId={environmentId} id={id} />
              </WorkDetails>
            )}
            {reviewsSupported && !editor && (
              <WorkDetails title="Review">
                <WorkReviewPanel environmentId={environmentId} id={id} />
              </WorkDetails>
            )}
          </div>
        )}
        <WorkDetails title="Activity">
          <WorkActivityPanel environmentId={environmentId} id={id} />
        </WorkDetails>
      </DialogPopup>
    </Dialog>
  );
}
