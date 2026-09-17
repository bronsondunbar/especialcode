import { WorkRepositoryField, useWorkTaskRepository } from "./WorkRepositoryField";
import { Checkbox } from "../ui/checkbox";
import { WorkDetails } from "./WorkDetails";
import { useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { createWorkExecutionAtoms } from "@t3tools/client-runtime/state/work-items";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type EnvironmentId,
  type WorkItemId,
  type WorkPlan,
  type WorkExecutionMutation,
} from "@t3tools/contracts";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useEnvironmentQuery, formatEnvironmentQueryError } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { randomUUID } from "../../lib/utils";
import { useRightPanelStore } from "../../rightPanelStore";
import { useTerminalUiStateStore } from "../../terminalUiStateStore";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
const atoms = createWorkExecutionAtoms(connectionAtomRuntime);
export function WorkExecutionPanel({
  environmentId,
  id,
  plan,
  onClose,
}: {
  environmentId: EnvironmentId;
  id: WorkItemId;
  plan: WorkPlan | null;
  onClose: () => void;
}) {
  const result = useEnvironmentQuery(atoms.get({ environmentId, input: { id } }));
  const mutate = useAtomCommand(atoms.mutate, { reportFailure: false });
  const navigate = useNavigate();
  const repository = useWorkTaskRepository(environmentId, result.data?.item);
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [commands, setCommands] = useState("");
  const [guidance, setGuidance] = useState("");
  const [usePlan, setUsePlan] = useState(false);
  const availablePlan =
    repository.projectId === result.data?.item.projectId &&
    plan?.content &&
    ["draft", "approved"].includes(plan.status)
      ? plan
      : null;
  const selectedPlan = usePlan ? availablePlan : null;
  const allowedStatuses = selectedPlan
    ? ["ready", "awaiting_approval"]
    : ["inbox", "backlog", "ready", "awaiting_approval", "blocked"];
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const previous = useRef<{ key: string; commandId: string } | null>(null);
  const data = result.data;
  const run = data?.execution;
  const active = run && !["succeeded", "failed", "stopped"].includes(run.status);
  const agent =
    data?.agents.find(
      (agent) => agent.instanceId === (provider || plan?.modelSelection.instanceId),
    ) ?? data?.agents[0];
  const chosen =
    agent?.models.find((entry) => entry.slug === (model || plan?.modelSelection.model))?.slug ??
    agent?.models[0]?.slug;
  const validationCommands = commands
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  async function send(
    input:
      | Omit<Extract<WorkExecutionMutation, { kind: "start" }>, "commandId">
      | Omit<Extract<WorkExecutionMutation, { kind: "stop" }>, "commandId">,
  ) {
    if (pending) return;
    setPending(true);
    setError(null);
    const key = JSON.stringify(input);
    const commandId = previous.current?.key === key ? previous.current.commandId : randomUUID();
    previous.current = { key, commandId };
    try {
      const response = await mutate({ environmentId, input: { ...input, commandId } });
      if (response._tag === "Failure") setError(formatEnvironmentQueryError(response.cause));
      else {
        previous.current = null;
        result.refresh();
      }
    } finally {
      setPending(false);
    }
  }
  function open(kind?: "diff" | "files" | "terminal") {
    if (!run) return;
    const ref = scopeThreadRef(environmentId, run.threadId);
    if (kind === "terminal") useTerminalUiStateStore.getState().setTerminalOpen(ref, true);
    else if (kind) useRightPanelStore.getState().open(ref, kind);
    onClose();
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId: run.threadId },
    });
  }
  return (
    <section className="grid gap-3 rounded-xl border p-4">
      <h3 className="font-medium">Execution</h3>
      {(error || result.error) && (
        <p role="alert" className="text-sm text-destructive">
          {error ?? result.error}
        </p>
      )}
      {!data ? (
        <p>Loading execution…</p>
      ) : (
        <>
          {run && (
            <>
              <p role="status" className="text-sm">
                {run.agentName} · {run.status} · {run.activity}
              </p>
              <p className="break-all text-xs text-muted-foreground">
                {run.branch} · Started {new Date(run.startedAt).toLocaleString()}
                {run.completedAt ? ` · Finished ${new Date(run.completedAt).toLocaleString()}` : ""}
              </p>
              {run.worktreePath && (
                <p className="break-all text-xs text-muted-foreground">{run.worktreePath}</p>
              )}
              {run.error && (
                <p role="alert" className="text-sm text-destructive">
                  {run.error}
                </p>
              )}
              {run.threadReady && (
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" onClick={() => open()}>
                    Open Agent Thread
                  </Button>
                  <Button variant="outline" onClick={() => open("files")}>
                    Open Worktree
                  </Button>
                  <Button variant="outline" onClick={() => open("diff")}>
                    View Changes
                  </Button>
                  <Button variant="outline" onClick={() => open("terminal")}>
                    Terminal output
                  </Button>
                </div>
              )}
              {run.changedFiles.length > 0 && (
                <p className="break-words text-sm">Changed files: {run.changedFiles.join(", ")}</p>
              )}
              {run.validationResults.map((validation) => (
                <details key={`${validation.command}-${validation.startedAt}`} className="text-sm">
                  <summary>
                    {validation.command} ·{" "}
                    {validation.timedOut ? "Timed out" : `Exit ${validation.exitCode ?? "unknown"}`}
                  </summary>
                  <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">
                    {validation.output}
                  </pre>
                </details>
              ))}
              {active && (
                <Button
                  variant="outline"
                  disabled={pending || run.status === "stopping" || run.status === "publishing"}
                  onClick={() => void send({ kind: "stop", id, expectedRevision: run.revision })}
                >
                  Stop execution
                </Button>
              )}
            </>
          )}
          {!active && (
            <>
              <WorkRepositoryField {...repository} disabled={pending} />
              <p className="text-sm text-muted-foreground">
                The agent receives the task title and description, plus any guidance below. Execute
                in a new worktree from {data.item.branch ?? "the current commit"}. The project
                checkout must be clean. Project setup runs first; failed setup or validation blocks
                the WorkItem. Provider approvals appear in the agent thread.
              </p>
              <label className="grid gap-1 text-sm">
                Additional guidance (optional)
                <Textarea
                  value={guidance}
                  onChange={(event) => setGuidance(event.target.value)}
                  maxLength={20000}
                  placeholder="Add constraints or details, or leave empty"
                  disabled={pending}
                />
              </label>
              {availablePlan && (
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox checked={usePlan} onCheckedChange={setUsePlan} disabled={pending} />
                  Use the existing plan
                </label>
              )}

              <div className="flex flex-wrap gap-3">
                <label className="grid gap-1 text-sm">
                  Execution agent
                  <select
                    className="h-9 rounded border bg-background px-2"
                    value={agent?.instanceId ?? ""}
                    onChange={(event) => {
                      setProvider(event.target.value);
                      setModel("");
                    }}
                  >
                    <option value="" disabled>
                      Select agent
                    </option>
                    {data.agents.map((entry) => (
                      <option key={entry.instanceId} value={entry.instanceId}>
                        {entry.displayName ?? entry.driver}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-1 text-sm">
                  Model
                  <select
                    className="h-9 rounded border bg-background px-2"
                    value={chosen ?? ""}
                    onChange={(event) => setModel(event.target.value)}
                  >
                    <option value="" disabled>
                      Select model
                    </option>
                    {agent?.models.map((entry) => (
                      <option key={entry.slug} value={entry.slug}>
                        {entry.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <WorkDetails
                title={
                  selectedPlan ? "Required validation commands" : "Validation commands (optional)"
                }
              >
                <label className="grid gap-1 text-sm">
                  Validation commands (one shell command per line)
                  <Textarea
                    value={commands}
                    maxLength={40000}
                    onChange={(event) => setCommands(event.target.value)}
                    placeholder="Enter the project's test, typecheck, or build commands"
                  />
                </label>
                <p className="text-xs text-muted-foreground">
                  These commands run on the selected environment in the worktree, with a ten-minute
                  limit per command. The agent also chooses appropriate checks for its changes.
                </p>
              </WorkDetails>
              <Button
                disabled={
                  pending ||
                  !agent ||
                  !chosen ||
                  (!!selectedPlan && !validationCommands.length) ||
                  !repository.projectId ||
                  !!data.item.archivedAt ||
                  plan?.status === "generating" ||
                  !allowedStatuses.includes(data.item.status)
                }
                onClick={() => {
                  if (agent && chosen && repository.projectId)
                    void send({
                      kind: "start",
                      id,
                      expectedWorkItemRevision: data.item.revision,
                      projectId: repository.projectId,
                      expectedPlanRevision: selectedPlan?.revision ?? null,
                      ...(guidance.trim() ? { guidance: guidance.trim() } : {}),
                      modelSelection: { instanceId: agent.instanceId, model: chosen },
                      validationCommands,
                    });
                }}
              >
                {selectedPlan ? "Approve & Execute" : "Execute with agent"}
              </Button>
              {!allowedStatuses.includes(data.item.status) && (
                <p className="text-sm">Move the task to Ready before another execution.</p>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
