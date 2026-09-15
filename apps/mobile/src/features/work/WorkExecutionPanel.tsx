import { useRef, useState } from "react";
import { useNavigation } from "@react-navigation/native";
import { View } from "react-native";
import * as Cause from "effect/Cause";
import { createWorkExecutionAtoms } from "@t3tools/client-runtime/state/work-items";
import {
  type EnvironmentId,
  type WorkItemId,
  type WorkPlan,
  type WorkExecutionMutation,
} from "@t3tools/contracts";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { uuidv4 } from "../../lib/uuid";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { ControlPill, ControlPillMenu } from "../../components/ControlPill";
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
  const navigation = useNavigation();
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [commands, setCommands] = useState("");
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
    const commandId = previous.current?.key === key ? previous.current.commandId : uuidv4();
    previous.current = { key, commandId };
    try {
      const response = await mutate({ environmentId, input: { ...input, commandId } });
      if (response._tag === "Failure") {
        const cause = Cause.squash(response.cause);
        setError(cause instanceof Error ? cause.message : "Execution failed.");
      } else {
        previous.current = null;
        result.refresh();
      }
    } finally {
      setPending(false);
    }
  }
  function open(screen: "Thread" | "ThreadFiles" | "ThreadReview" | "ThreadTerminal") {
    if (!run) return;
    onClose();
    navigation.navigate(screen, { environmentId, threadId: run.threadId });
  }
  return (
    <View className="gap-3 rounded-xl border border-border p-4">
      <Text className="font-semibold">Execution</Text>
      {(error || result.error) && (
        <Text accessibilityRole="alert" className="text-destructive">
          {error ?? result.error}
        </Text>
      )}
      {!data ? (
        <Text>Loading execution…</Text>
      ) : (
        <>
          {run && (
            <>
              <Text>
                {run.agentName} · {run.status} · {run.activity}
              </Text>
              <Text selectable className="text-xs text-muted-foreground">
                {run.branch} · Started {new Date(run.startedAt).toLocaleString()}
                {run.completedAt ? ` · Finished ${new Date(run.completedAt).toLocaleString()}` : ""}
              </Text>
              {run.worktreePath && (
                <Text selectable className="text-xs text-muted-foreground">
                  {run.worktreePath}
                </Text>
              )}
              {run.error && (
                <Text accessibilityRole="alert" className="text-destructive">
                  {run.error}
                </Text>
              )}
              {run.threadReady && (
                <View className="flex-row flex-wrap gap-2">
                  <ControlPill label="Open Agent Thread" onPress={() => open("Thread")} />
                  <ControlPill label="Open Worktree" onPress={() => open("ThreadFiles")} />
                  <ControlPill label="View Changes" onPress={() => open("ThreadReview")} />
                  <ControlPill label="Terminal output" onPress={() => open("ThreadTerminal")} />
                </View>
              )}
              {run.changedFiles.length > 0 && (
                <Text selectable>Changed files: {run.changedFiles.join(", ")}</Text>
              )}
              {run.validationResults.map((validation) => (
                <View key={`${validation.command}-${validation.startedAt}`} className="gap-1">
                  <Text>
                    {validation.command} ·{" "}
                    {validation.timedOut ? "Timed out" : `Exit ${validation.exitCode ?? "unknown"}`}
                  </Text>
                  <Text selectable className="text-xs text-muted-foreground">
                    {validation.output}
                  </Text>
                </View>
              ))}
              {active && (
                <ControlPill
                  label="Stop execution"
                  disabled={pending || run.status === "stopping" || run.status === "publishing"}
                  onPress={() => void send({ kind: "stop", id, expectedRevision: run.revision })}
                />
              )}
            </>
          )}
          {!active && plan?.content && ["draft", "approved"].includes(plan.status) && (
            <>
              <Text className="text-sm text-muted-foreground">
                Execute the reviewed plan in a new worktree from{" "}
                {data.item.branch ?? "the current commit"}. The project checkout must be clean.
                Setup runs first; failed setup or validation blocks the WorkItem. Provider approvals
                appear in the agent thread.
              </Text>
              <ControlPillMenu
                title="Execution agent"
                actions={data.agents.map((entry) => ({
                  id: entry.instanceId,
                  title: entry.displayName ?? entry.driver,
                }))}
                onPressAction={({ nativeEvent }) => {
                  setProvider(nativeEvent.event);
                  setModel("");
                }}
              >
                <ControlPill label={`Agent: ${agent?.displayName ?? agent?.driver ?? "Select"}`} />
              </ControlPillMenu>
              <ControlPillMenu
                title="Model"
                actions={(agent?.models ?? []).map((entry) => ({
                  id: entry.slug,
                  title: entry.name,
                }))}
                onPressAction={({ nativeEvent }) => setModel(nativeEvent.event)}
              >
                <ControlPill label={`Model: ${chosen ?? "Select"}`} />
              </ControlPillMenu>
              <Text>Required validation commands (one shell command per line)</Text>
              <TextInput
                className="min-h-24 rounded-lg border border-border p-3 text-foreground"
                accessibilityLabel="Required validation commands"
                multiline
                value={commands}
                maxLength={40000}
                onChangeText={setCommands}
                placeholder="Enter test, typecheck, or build commands"
              />
              <Text className="text-xs text-muted-foreground">
                These commands run in the worktree on the selected environment, with a ten-minute
                limit each. At least one is required. Review requires an explicit completion report
                and passing validation.
              </Text>
              <ControlPill
                label="Approve & Execute"
                disabled={
                  pending ||
                  !agent ||
                  !chosen ||
                  !validationCommands.length ||
                  !["ready", "awaiting_approval"].includes(data.item.status)
                }
                onPress={() => {
                  if (agent && chosen)
                    void send({
                      kind: "start",
                      id,
                      expectedWorkItemRevision: data.item.revision,
                      expectedPlanRevision: plan.revision,
                      modelSelection: { instanceId: agent.instanceId, model: chosen },
                      validationCommands,
                    });
                }}
              />
              {!["ready", "awaiting_approval"].includes(data.item.status) && (
                <Text>
                  Move the WorkItem to Ready and review its plan before another execution.
                </Text>
              )}
            </>
          )}
        </>
      )}
    </View>
  );
}
