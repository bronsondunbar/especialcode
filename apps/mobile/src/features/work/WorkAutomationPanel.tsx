import { AutomationExecutionPolicyEditor } from "./AutomationExecutionPolicyEditor";
import { useState } from "react";
import { ScrollView, Switch, View } from "react-native";
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
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { ControlPill, ControlPillMenu } from "../../components/ControlPill";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { uuidv4 } from "../../lib/uuid";
const atoms = createWorkAutomationAtoms(connectionAtomRuntime);
const labels = {
  execute_approved: "Execute approved WorkItem",
  import_work_item: "Create/import WorkItem",
  change_status: "Change status",
  assign_provider: "Assign provider",
  generate_plan: "Generate plan",
  notify: "Create notification",
} as const;
function Choice({
  title,
  value,
  options,
  onChange,
}: {
  title: string;
  value: string;
  options: ReadonlyArray<{ id: string; label: string }>;
  onChange: (id: string) => void;
}) {
  return (
    <ControlPillMenu
      title={title}
      actions={options.map((o) => ({
        id: o.id,
        title: o.label,
        state: o.id === value ? "on" : "off",
      }))}
      onPressAction={({ nativeEvent }) => onChange(nativeEvent.event)}
    >
      <ControlPill
        variant="pill"
        label={`${title}: ${options.find((o) => o.id === value)?.label ?? "Choose"}`}
        accessibilityLabel={title}
      />
    </ControlPillMenu>
  );
}
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
      actionKeys: rule.actions.map(() => uuidv4()),
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
  function updateAction(index: number, step: AutomationAction) {
    if (editor) patch({ actions: editor.value.actions.map((s, i) => (i === index ? step : s)) });
  }
  const config = editor?.value;
  return (
    <ScrollView
      className="flex-1"
      contentContainerClassName="gap-4 p-4 pb-12"
      keyboardShouldPersistTaps="handled"
    >
      <Text className="text-xl font-semibold text-foreground">Automation settings</Text>
      {autonomousSupported && (
        <View className="gap-2">
          <ControlPill
            variant="pill"
            className="border border-danger"
            label="Stop all automations"
            disabled={controlling}
            onPress={() => void control({ kind: "stop_all" })}
          />
          {query.data?.control?.paused && (
            <>
              <Text className="text-sm text-foreground">
                Automations are paused. Check running threads for stop progress.
              </Text>
              <ControlPill
                variant="pill"
                label="Resume automations"
                disabled={controlling}
                onPress={() =>
                  void control({ kind: "resume", expectedRevision: query.data!.control!.revision })
                }
              />
            </>
          )}
        </View>
      )}
      <Text className="text-sm text-muted-foreground">
        Rules run in this environment on future events, even with clients closed. All conditions
        must match. Planning can run automatically; only trusted rules can execute explicitly
        approved plans. New rules start disabled.
      </Text>
      <ControlPill
        variant="pill"
        label="Create rule"
        disabled={pending}
        onPress={() =>
          setEditor({
            id: uuidv4(),
            revision: 0,
            actionKeys: [uuidv4(), uuidv4()],
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
      />
      {(error || query.error) && (
        <Text accessibilityRole="alert" className="text-destructive">
          {error ?? query.error}
        </Text>
      )}
      {!query.data && !query.error && (
        <Text className="text-muted-foreground">Loading automations…</Text>
      )}
      {editor && config && (
        <View className="gap-3 rounded-xl border border-border p-4">
          <Text className="font-semibold text-foreground">
            {editor.revision ? "Edit rule" : "Create rule"}
          </Text>
          <Text className="text-sm text-foreground">Name</Text>
          <TextInput
            accessibilityLabel="Rule name"
            className="rounded-lg border border-border p-3 text-foreground"
            value={config.name}
            maxLength={500}
            onChangeText={(name) => patch({ name })}
          />
          <View className="flex-row items-center justify-between">
            <Text className="text-foreground">Enabled</Text>
            <Switch
              accessibilityLabel="Rule enabled"
              value={config.enabled}
              onValueChange={(enabled) => patch({ enabled })}
            />
          </View>
          <Choice
            title="Trigger"
            value={config.trigger}
            options={AUTOMATION_TRIGGERS}
            onChange={(id) => {
              const trigger = AUTOMATION_TRIGGERS.find((t) => t.id === id);
              if (trigger) patch({ trigger: trigger.id });
            }}
          />
          <Text className="text-sm font-semibold text-foreground">Conditions (all must match)</Text>
          <Text className="text-sm text-foreground">Repository (optional)</Text>
          <TextInput
            accessibilityLabel="Repository condition"
            placeholder="owner/repository"
            autoCapitalize="none"
            className="rounded-lg border border-border p-3 text-foreground"
            value={config.conditions.repository ?? ""}
            onChangeText={(value) => {
              const { repository: _, ...rest } = config.conditions;
              patch({ conditions: value ? { ...rest, repository: value } : rest });
            }}
          />
          <Text className="text-sm text-foreground">Exact GitHub label (optional)</Text>
          <TextInput
            accessibilityLabel="Label condition"
            autoCapitalize="none"
            className="rounded-lg border border-border p-3 text-foreground"
            value={config.conditions.label ?? ""}
            onChangeText={(value) => {
              const { label: _, ...rest } = config.conditions;
              patch({ conditions: value ? { ...rest, label: value } : rest });
            }}
          />
          <Choice
            title="Status"
            value={config.conditions.status ?? ""}
            options={[
              { id: "", label: "Any" },
              ...AUTOMATION_CONDITION_STATUSES.map((id) => ({ id, label: id })),
            ]}
            onChange={(id) => {
              const { status: _, ...rest } = config.conditions;
              const status = AUTOMATION_CONDITION_STATUSES.find((s) => s === id);
              patch({ conditions: status ? { ...rest, status } : rest });
            }}
          />
          <Choice
            title="Agent thread"
            value={
              config.conditions.hasAgentThread === undefined
                ? "any"
                : String(config.conditions.hasAgentThread)
            }
            options={[
              { id: "any", label: "Any" },
              { id: "true", label: "Has linked thread" },
              { id: "false", label: "No linked thread" },
            ]}
            onChange={(id) => {
              const { hasAgentThread: _, ...rest } = config.conditions;
              patch({
                conditions: id === "any" ? rest : { ...rest, hasAgentThread: id === "true" },
              });
            }}
          />
          <Text className="text-sm text-muted-foreground">
            Actions run in order and stop on failure. Imports use the tracked project. Planning
            requires a project and an available provider.
          </Text>
          {autonomousSupported && config.execution && (
            <AutomationExecutionPolicyEditor
              key={`${editor.id}:${editor.revision}`}
              value={config.execution}
              providers={providers}
              onChange={(execution) => patch({ execution })}
            />
          )}
          {config.actions.map((step, index) => (
            <View
              key={editor.actionKeys[index]}
              className="gap-2 rounded-lg border border-border p-3"
            >
              <Text className="font-semibold text-foreground">
                {index + 1}. {labels[step.kind]}
              </Text>
              {step.kind === "execute_approved" && (
                <>
                  <Text className="text-sm text-foreground">
                    Validation commands (one per line)
                  </Text>
                  <TextInput
                    accessibilityLabel="Validation commands"
                    multiline
                    autoCapitalize="none"
                    className="rounded-lg border border-border p-3 text-foreground"
                    defaultValue={step.validationCommands.join("\n")}
                    onChangeText={(text) =>
                      updateAction(index, {
                        ...step,
                        validationCommands: text
                          .split("\n")
                          .map((s) => s.trim())
                          .filter(Boolean),
                      })
                    }
                  />
                </>
              )}
              {step.kind === "notify" && (
                <TextInput
                  accessibilityLabel={`Notification message ${index + 1}`}
                  className="rounded-lg border border-border p-3 text-foreground"
                  value={step.message}
                  maxLength={500}
                  onChangeText={(message) => updateAction(index, { ...step, message })}
                />
              )}
              {step.kind === "change_status" && (
                <Choice
                  title="Target status"
                  value={step.status}
                  options={WORK_ITEM_MANUAL_STATUSES.map((id) => ({ id, label: id }))}
                  onChange={(id) => {
                    const status = WORK_ITEM_MANUAL_STATUSES.find((s) => s === id);
                    if (status) updateAction(index, { ...step, status });
                  }}
                />
              )}
              {(step.kind === "assign_provider" ||
                step.kind === "generate_plan" ||
                step.kind === "execute_approved") && (
                <Choice
                  title="Provider"
                  value={
                    step.kind !== "assign_provider"
                      ? step.modelSelection.instanceId
                      : step.instanceId
                  }
                  options={providers.map((p) => ({
                    id: p.instanceId,
                    label: p.displayName ?? p.driver,
                  }))}
                  onChange={(id) => {
                    const provider = providers.find((p) => p.instanceId === id);
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
                />
              )}
              {(step.kind === "generate_plan" || step.kind === "execute_approved") && (
                <Choice
                  title="Planning model"
                  value={step.modelSelection.model}
                  options={
                    providers
                      .find((p) => p.instanceId === step.modelSelection.instanceId)
                      ?.models.map((m) => ({ id: m.slug, label: m.name })) ?? []
                  }
                  onChange={(model) =>
                    updateAction(index, {
                      ...step,
                      modelSelection: { ...step.modelSelection, model },
                    })
                  }
                />
              )}
              <View className="flex-row flex-wrap gap-2">
                <ControlPill
                  variant="pill"
                  label="Move up"
                  disabled={index === 0}
                  onPress={() => {
                    const actions = [...config.actions];
                    [actions[index - 1], actions[index]] = [actions[index]!, actions[index - 1]!];
                    const keys = [...editor.actionKeys];
                    [keys[index - 1], keys[index]] = [keys[index]!, keys[index - 1]!];
                    patch({ actions }, keys);
                  }}
                />
                <ControlPill
                  variant="pill"
                  label="Remove action"
                  onPress={() =>
                    patch(
                      { actions: config.actions.filter((_, i) => i !== index) },
                      editor.actionKeys.filter((_, i) => i !== index),
                    )
                  }
                />
              </View>
            </View>
          ))}
          <View className="flex-row flex-wrap gap-2">
            {(Object.keys(labels) as Array<AutomationAction["kind"]>)
              .filter((kind) => kind !== "execute_approved" || autonomousSupported)
              .map((kind) => (
                <ControlPill
                  variant="pill"
                  key={kind}
                  label={`Add ${labels[kind].toLowerCase()}`}
                  disabled={
                    config.actions.length >= 10 ||
                    ((kind === "assign_provider" ||
                      kind === "generate_plan" ||
                      kind === "execute_approved") &&
                      !providers[0])
                  }
                  onPress={() => {
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
                        [...editor.actionKeys, uuidv4()],
                      );
                  }}
                />
              ))}
          </View>
          <ControlPill
            variant="pill"
            label={pending ? "Saving…" : "Save rule"}
            disabled={pending || !config.name.trim() || config.actions.length === 0}
            onPress={() =>
              void save({
                kind: "save",
                id: editor.id,
                expectedRevision: editor.revision,
                value: config,
              })
            }
          />
          <ControlPill
            variant="pill"
            label="Cancel"
            disabled={pending}
            onPress={() => setEditor(null)}
          />
        </View>
      )}
      {query.data?.rules.length === 0 && (
        <Text className="text-muted-foreground">No rules yet.</Text>
      )}
      {query.data?.rules.map((rule) => (
        <View key={rule.id} className="gap-2 rounded-xl border border-border p-4">
          <Text className="font-semibold text-foreground">
            {rule.name} · {rule.enabled ? "Enabled" : "Disabled"}
          </Text>
          <Text className="text-sm text-foreground">
            {AUTOMATION_TRIGGERS.find((t) => t.id === rule.trigger)?.label} →{" "}
            {rule.actions.map((a) => labels[a.kind]).join(" → ")}
          </Text>
          <Text className="text-xs text-muted-foreground">
            Last execution:{" "}
            {rule.lastRun
              ? `${rule.lastRun.status} · ${new Date(rule.lastRun.createdAt).toLocaleString()} · ${rule.lastRun.message}`
              : "Never"}
          </Text>
          <View className="flex-row flex-wrap gap-2">
            <ControlPill
              variant="pill"
              label="Edit"
              disabled={pending}
              onPress={() => edit(rule)}
            />
            <ControlPill
              variant="pill"
              label={rule.enabled ? "Disable" : "Enable"}
              disabled={pending}
              onPress={() =>
                void save({
                  kind: "save",
                  id: rule.id,
                  expectedRevision: rule.revision,
                  value: { ...rule, enabled: !rule.enabled },
                })
              }
            />
            <ControlPill
              variant="pill"
              label="History"
              onPress={() => {
                setRuleId(rule.id);
                setOffset(0);
              }}
            />
            <ControlPill
              variant="pill"
              label="Delete"
              disabled={pending}
              onPress={() =>
                void save({ kind: "delete", id: rule.id, expectedRevision: rule.revision })
              }
            />
          </View>
        </View>
      ))}
      <Text className="font-semibold text-foreground">Execution history</Text>
      {ruleId && (
        <ControlPill
          variant="pill"
          label="All rules"
          onPress={() => {
            setRuleId(undefined);
            setOffset(0);
          }}
        />
      )}
      {query.data?.runs.map((run) => (
        <View key={run.id} className="gap-1 border-b border-border pb-3">
          <Text className="font-semibold text-foreground">
            {run.ruleName} · {run.status}
          </Text>
          <Text className="text-xs text-muted-foreground">
            {new Date(run.createdAt).toLocaleString()} · Rule revision {run.ruleRevision} ·{" "}
            {run.completedActions}/{run.actionCount} actions
          </Text>
          <Text className="text-sm text-foreground">{run.message}</Text>
          {run.workItemId && (
            <Text className="text-xs text-muted-foreground">WorkItem: {run.workItemId}</Text>
          )}
        </View>
      ))}
      {query.data?.total === 0 && <Text className="text-muted-foreground">No executions yet.</Text>}
      <View className="flex-row gap-2">
        <ControlPill
          variant="pill"
          label="Newer"
          disabled={offset === 0}
          onPress={() => setOffset(Math.max(0, offset - 25))}
        />
        <ControlPill
          variant="pill"
          label="Older"
          disabled={offset + 25 >= (query.data?.total ?? 0)}
          onPress={() => setOffset(offset + 25)}
        />
      </View>
    </ScrollView>
  );
}
