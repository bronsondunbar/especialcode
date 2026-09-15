import { AutomationExecutionPolicyEditor } from "./AutomationExecutionPolicyEditor";
import { useState } from "react";
import * as Cause from "effect/Cause";
import { createWorkAutomationAtoms } from "@t3tools/client-runtime/state/work-items";
import {
  AUTOMATION_TRIGGERS,
  AUTOMATION_CONDITION_STATUSES,
  WORK_ITEM_MANUAL_STATUSES,
  type AutomationAction,
  type AutomationControlMutation,
  type AutomationConfig,
  type AutomationMutation,
  type AutomationRule,
  type EnvironmentId,
  type ServerProvider,
} from "@t3tools/contracts";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
const atoms = createWorkAutomationAtoms(connectionAtomRuntime);
const selectClass = "h-9 min-w-0 rounded-lg border border-input bg-background px-2 text-sm";
const actionLabels = {
  execute_approved: "Execute approved WorkItem",
  import_work_item: "Create/import WorkItem",
  change_status: "Change status",
  assign_provider: "Assign provider",
  generate_plan: "Generate plan",
  notify: "Create notification",
} as const;
export function WorkAutomationPanel({
  environmentId,
  providers,
  autonomousSupported = false,
}: {
  environmentId: EnvironmentId;
  providers: ReadonlyArray<ServerProvider>;
  autonomousSupported?: boolean;
}) {
  const [ruleId, setRuleId] = useState<string>();
  const [offset, setOffset] = useState(0);
  const [editor, setEditor] = useState<{
    id: string;
    revision: number;
    value: AutomationConfig;
    actionKeys: string[];
  } | null>(null);
  const [pending, setPending] = useState(false);
  const [controlling, setControlling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const query = useEnvironmentQuery(
    atoms.list({ environmentId, input: { ...(ruleId ? { ruleId } : {}), offset, limit: 25 } }),
  );
  const mutate = useAtomCommand(atoms.mutate, { reportFailure: false });
  const controlCommand = useAtomCommand(atoms.control, { reportFailure: false });
  async function control(input: AutomationControlMutation) {
    setControlling(true);
    setError(null);
    try {
      const result = await controlCommand({ environmentId, input });
      if (result._tag !== "Success") setError(String(Cause.squash(result.cause)));
      query.refresh();
    } finally {
      setControlling(false);
    }
  }
  async function save(input: AutomationMutation) {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await mutate({ environmentId, input });
      if (result._tag === "Success") {
        setEditor(null);
        query.refresh();
      } else setError(String(Cause.squash(result.cause)));
    } finally {
      setPending(false);
    }
  }
  function edit(rule: AutomationRule) {
    setEditor({
      id: rule.id,
      revision: rule.revision,
      value: rule,
      actionKeys: rule.actions.map(() => randomUUID()),
    });
    setError(null);
  }
  function patch(value: Partial<AutomationConfig>, actionKeys?: string[]) {
    setEditor((current) =>
      current
        ? {
            ...current,
            value: { ...current.value, ...value },
            actionKeys: actionKeys ?? current.actionKeys,
          }
        : null,
    );
  }
  function updateAction(index: number, value: AutomationAction) {
    if (editor)
      patch({ actions: editor.value.actions.map((step, i) => (i === index ? value : step)) });
  }
  const config = editor?.value;
  return (
    <section className="flex-1 overflow-y-auto p-4 sm:p-6" aria-label="Automation settings">
      <div className="mx-auto grid max-w-4xl gap-5">
        {autonomousSupported && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border p-3">
            <Button
              variant="destructive"
              disabled={controlling}
              onClick={() => void control({ kind: "stop_all" })}
            >
              Stop all automations
            </Button>
            {query.data?.control?.paused && (
              <>
                <span className="text-sm">
                  Automations are paused. Check running threads for stop progress.
                </span>
                <Button
                  disabled={controlling}
                  onClick={() =>
                    void control({
                      kind: "resume",
                      expectedRevision: query.data!.control!.revision,
                    })
                  }
                >
                  Resume automations
                </Button>
              </>
            )}
          </div>
        )}
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">Automations</h2>
          <Button
            disabled={pending}
            onClick={() =>
              setEditor({
                id: randomUUID(),
                revision: 0,
                actionKeys: [randomUUID(), randomUUID()],
                value: {
                  name: "",
                  enabled: false,
                  trigger: "github_label_changed",
                  conditions: { label: "agent-ready" },
                  actions: [
                    { kind: "import_work_item" },
                    { kind: "notify", message: "WorkItem is ready to review" },
                  ],
                },
              })
            }
          >
            Create rule
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          Rules run in this environment when new events arrive, even while clients are closed. All
          conditions must match. Planning can run automatically; coding still requires explicit
          approval. New rules start disabled.
        </p>
        {(error || query.error) && (
          <p role="alert" className="text-sm text-destructive">
            {error ?? query.error}
          </p>
        )}
        {!query.data && !query.error && <p>Loading automations…</p>}
        {editor && config && (
          <form
            className="grid gap-4 rounded-xl border p-4"
            onSubmit={(event) => {
              event.preventDefault();
              void save({
                kind: "save",
                id: editor.id,
                expectedRevision: editor.revision,
                value: config,
              });
            }}
          >
            <h3 className="font-semibold">{editor.revision ? "Edit rule" : "Create rule"}</h3>
            <label className="grid gap-1 text-sm">
              Name
              <Input
                required
                maxLength={500}
                value={config.name}
                onChange={(event) => patch({ name: event.target.value })}
              />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={config.enabled}
                onChange={(event) => patch({ enabled: event.target.checked })}
              />
              Enabled
            </label>
            <label className="grid gap-1 text-sm">
              Trigger
              <select
                className={selectClass}
                value={config.trigger}
                onChange={(event) => {
                  const trigger = AUTOMATION_TRIGGERS.find((t) => t.id === event.target.value);
                  if (trigger) patch({ trigger: trigger.id });
                }}
              >
                {AUTOMATION_TRIGGERS.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
            <fieldset className="grid gap-3 sm:grid-cols-2">
              <legend className="mb-2 text-sm font-medium">Conditions (all must match)</legend>
              <label className="grid gap-1 text-sm">
                Repository (optional)
                <Input
                  placeholder="owner/repository"
                  value={config.conditions.repository ?? ""}
                  onChange={(event) => {
                    const { repository: _, ...rest } = config.conditions;
                    patch({
                      conditions: event.target.value
                        ? { ...rest, repository: event.target.value }
                        : rest,
                    });
                  }}
                />
              </label>
              <label className="grid gap-1 text-sm">
                Exact GitHub label (optional)
                <Input
                  value={config.conditions.label ?? ""}
                  onChange={(event) => {
                    const { label: _, ...rest } = config.conditions;
                    patch({
                      conditions: event.target.value
                        ? { ...rest, label: event.target.value }
                        : rest,
                    });
                  }}
                />
              </label>
              <label className="grid gap-1 text-sm">
                WorkItem status
                <select
                  className={selectClass}
                  value={config.conditions.status ?? ""}
                  onChange={(event) => {
                    const { status: _, ...rest } = config.conditions;
                    const status = AUTOMATION_CONDITION_STATUSES.find(
                      (s) => s === event.target.value,
                    );
                    patch({ conditions: status ? { ...rest, status } : rest });
                  }}
                >
                  <option value="">Any status</option>
                  {AUTOMATION_CONDITION_STATUSES.map((status) => (
                    <option key={status}>{status}</option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1 text-sm">
                Agent thread
                <select
                  className={selectClass}
                  value={
                    config.conditions.hasAgentThread === undefined
                      ? "any"
                      : String(config.conditions.hasAgentThread)
                  }
                  onChange={(event) => {
                    const { hasAgentThread: _, ...rest } = config.conditions;
                    patch({
                      conditions:
                        event.target.value === "any"
                          ? rest
                          : { ...rest, hasAgentThread: event.target.value === "true" },
                    });
                  }}
                >
                  <option value="any">Any</option>
                  <option value="true">Has linked thread</option>
                  <option value="false">No linked thread</option>
                </select>
              </label>
            </fieldset>
            <p className="text-xs text-muted-foreground">
              Actions run in order and stop on failure. Create/import uses the GitHub issue’s
              tracked project. Generate plan needs a project and an available provider; the
              resulting plan still needs approval.
            </p>
            {autonomousSupported && config.execution && (
              <AutomationExecutionPolicyEditor
                key={`${editor.id}:${editor.revision}`}
                value={config.execution}
                providers={providers}
                onChange={(execution) => patch({ execution })}
              />
            )}
            <ol className="grid gap-3">
              {config.actions.map((step, index) => (
                <li key={editor.actionKeys[index]} className="grid gap-2 rounded-lg border p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">
                      {index + 1}. {actionLabels[step.kind]}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={index === 0}
                      onClick={() => {
                        const actions = [...config.actions];
                        [actions[index - 1], actions[index]] = [
                          actions[index]!,
                          actions[index - 1]!,
                        ];
                        const keys = [...editor.actionKeys];
                        [keys[index - 1], keys[index]] = [keys[index]!, keys[index - 1]!];
                        patch({ actions }, keys);
                      }}
                    >
                      Move up
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        patch(
                          { actions: config.actions.filter((_, i) => i !== index) },
                          editor.actionKeys.filter((_, i) => i !== index),
                        )
                      }
                    >
                      Remove
                    </Button>
                  </div>
                  {step.kind === "execute_approved" && (
                    <label className="grid gap-1 text-sm">
                      Validation commands (one per line)
                      <textarea
                        className="rounded-lg border bg-background p-2"
                        defaultValue={step.validationCommands.join("\n")}
                        onChange={(event) =>
                          updateAction(index, {
                            ...step,
                            validationCommands: event.target.value
                              .split("\n")
                              .map((s) => s.trim())
                              .filter(Boolean),
                          })
                        }
                      />
                    </label>
                  )}
                  {step.kind === "notify" && (
                    <Input
                      aria-label={`Notification message ${index + 1}`}
                      required
                      maxLength={500}
                      value={step.message}
                      onChange={(event) =>
                        updateAction(index, { ...step, message: event.target.value })
                      }
                    />
                  )}
                  {step.kind === "change_status" && (
                    <select
                      aria-label={`Target status ${index + 1}`}
                      className={selectClass}
                      value={step.status}
                      onChange={(event) => {
                        const status = WORK_ITEM_MANUAL_STATUSES.find(
                          (s) => s === event.target.value,
                        );
                        if (status) updateAction(index, { ...step, status });
                      }}
                    >
                      {WORK_ITEM_MANUAL_STATUSES.map((s) => (
                        <option key={s}>{s}</option>
                      ))}
                    </select>
                  )}
                  {(step.kind === "assign_provider" ||
                    step.kind === "generate_plan" ||
                    step.kind === "execute_approved") && (
                    <select
                      aria-label={`Provider ${index + 1}`}
                      className={selectClass}
                      value={
                        step.kind === "generate_plan" || step.kind === "execute_approved"
                          ? step.modelSelection.instanceId
                          : step.instanceId
                      }
                      onChange={(event) => {
                        const provider = providers.find((p) => p.instanceId === event.target.value);
                        if (provider)
                          updateAction(
                            index,
                            step.kind === "assign_provider"
                              ? { ...step, instanceId: provider.instanceId }
                              : {
                                  ...step,
                                  modelSelection: {
                                    instanceId: provider.instanceId,
                                    model: provider.models[0]?.slug ?? "",
                                  },
                                },
                          );
                      }}
                    >
                      <option value="" disabled>
                        Choose provider
                      </option>
                      {providers.map((p) => (
                        <option key={p.instanceId} value={p.instanceId}>
                          {p.displayName ?? p.driver}
                        </option>
                      ))}
                    </select>
                  )}
                  {(step.kind === "generate_plan" || step.kind === "execute_approved") && (
                    <select
                      aria-label={`Planning model ${index + 1}`}
                      required
                      className={selectClass}
                      value={step.modelSelection.model}
                      onChange={(event) =>
                        updateAction(index, {
                          ...step,
                          modelSelection: { ...step.modelSelection, model: event.target.value },
                        })
                      }
                    >
                      <option value="" disabled>
                        Choose model
                      </option>
                      {providers
                        .find((p) => p.instanceId === step.modelSelection.instanceId)
                        ?.models.map((m) => (
                          <option key={m.slug} value={m.slug}>
                            {m.name}
                          </option>
                        ))}
                    </select>
                  )}
                </li>
              ))}
            </ol>
            <div className="flex flex-wrap gap-2">
              {(Object.keys(actionLabels) as Array<AutomationAction["kind"]>)
                .filter((kind) => kind !== "execute_approved" || autonomousSupported)
                .map((kind) => (
                  <Button
                    key={kind}
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={
                      config.actions.length >= 10 ||
                      ((kind === "assign_provider" ||
                        kind === "generate_plan" ||
                        kind === "execute_approved") &&
                        !providers[0])
                    }
                    onClick={() => {
                      const provider = providers[0];
                      const action: AutomationAction | null =
                        kind === "change_status"
                          ? { kind, status: "ready" }
                          : kind === "notify"
                            ? { kind, message: "WorkItem needs attention" }
                            : kind === "assign_provider"
                              ? provider
                                ? { kind, instanceId: provider.instanceId }
                                : null
                              : kind === "generate_plan" || kind === "execute_approved"
                                ? provider
                                  ? {
                                      kind,
                                      validationCommands: [],
                                      modelSelection: {
                                        instanceId: provider.instanceId,
                                        model: provider.models[0]?.slug ?? "",
                                      },
                                    }
                                  : null
                                : { kind };
                      if (action)
                        patch(
                          {
                            actions: [...config.actions, action],
                            ...(action.kind === "execute_approved" && !config.execution
                              ? {
                                  execution: {
                                    trusted: false,
                                    allowedRepositories: [],
                                    allowedLabels: [],
                                    allowedProviders: [],
                                    maxConcurrentRuns: 2,
                                    permissionMode: "approval-required" as const,
                                    requireTests: true,
                                    requirePullRequest: true,
                                  },
                                }
                              : {}),
                          },
                          [...editor.actionKeys, randomUUID()],
                        );
                    }}
                  >
                    Add {actionLabels[kind].toLowerCase()}
                  </Button>
                ))}
            </div>
            <div className="flex gap-2">
              <Button type="submit" disabled={pending || config.actions.length === 0}>
                {pending ? "Saving…" : "Save rule"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={pending}
                onClick={() => setEditor(null)}
              >
                Cancel
              </Button>
            </div>
          </form>
        )}
        {query.data?.rules.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No rules yet. Create one to respond to future events.
          </p>
        )}
        {query.data?.rules.map((rule) => (
          <article key={rule.id} className="grid gap-2 rounded-xl border p-4">
            <h3 className="font-semibold">
              {rule.name} · {rule.enabled ? "Enabled" : "Disabled"}
            </h3>
            <p className="text-sm">
              {AUTOMATION_TRIGGERS.find((t) => t.id === rule.trigger)?.label} →{" "}
              {rule.actions.map((a) => actionLabels[a.kind]).join(" → ")}
            </p>
            <p className="text-xs text-muted-foreground">
              Last execution:{" "}
              {rule.lastRun
                ? `${rule.lastRun.status} · ${new Date(rule.lastRun.createdAt).toLocaleString()} · ${rule.lastRun.message}`
                : "Never"}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" disabled={pending} onClick={() => edit(rule)}>
                Edit
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={pending}
                onClick={() =>
                  void save({
                    kind: "save",
                    id: rule.id,
                    expectedRevision: rule.revision,
                    value: { ...rule, enabled: !rule.enabled },
                  })
                }
              >
                {rule.enabled ? "Disable" : "Enable"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setRuleId(rule.id);
                  setOffset(0);
                }}
              >
                History
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={pending}
                onClick={() =>
                  void save({ kind: "delete", id: rule.id, expectedRevision: rule.revision })
                }
              >
                Delete
              </Button>
            </div>
          </article>
        ))}
        <div className="flex items-center justify-between">
          <h3 className="font-semibold">Execution history</h3>
          {ruleId && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setRuleId(undefined);
                setOffset(0);
              }}
            >
              All rules
            </Button>
          )}
        </div>
        {query.data?.runs.map((run) => (
          <article key={run.id} className="grid gap-1 border-b pb-3 text-sm">
            <strong>
              {run.ruleName} · {run.status}
            </strong>
            <span className="text-xs text-muted-foreground">
              {new Date(run.createdAt).toLocaleString()} · Rule revision {run.ruleRevision} ·{" "}
              {run.completedActions}/{run.actionCount} actions
            </span>
            <p>{run.message}</p>
            {run.workItemId && (
              <span className="break-all text-xs text-muted-foreground">
                WorkItem: {run.workItemId}
              </span>
            )}
          </article>
        ))}
        {query.data?.total === 0 && (
          <p className="text-sm text-muted-foreground">No executions yet.</p>
        )}
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - 25))}
          >
            Newer
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={offset + 25 >= (query.data?.total ?? 0)}
            onClick={() => setOffset(offset + 25)}
          >
            Older
          </Button>
        </div>
      </div>
    </section>
  );
}
