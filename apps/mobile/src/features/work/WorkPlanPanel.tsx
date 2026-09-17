import { useOpenWorkThread } from "./useOpenWorkThread";
import { WorkRepositoryField, useWorkTaskRepository } from "./WorkRepositoryField";
import { WorkDetails } from "./WorkDetails";
import { WorkActivityPanel } from "./WorkActivityPanel";
import { WorkTaskContext, WorkTaskDiscussions } from "./WorkTaskContext";
import { WorkExecutionPanel } from "./WorkExecutionPanel";
import { createWorkPlanAtoms } from "@t3tools/client-runtime/state/work-items";
import {
  ProviderInstanceId,
  WORK_PLAN_SECTIONS,
  type EnvironmentId,
  type WorkItemId,
  type WorkPlanContent,
  type WorkPlanMutation,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { useRef, useState } from "react";
import { useNavigation } from "@react-navigation/native";
import { Modal, Platform, Pressable, ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { ControlPill, ControlPillMenu } from "../../components/ControlPill";
import { connectionAtomRuntime } from "../../connection/runtime";
import { uuidv4 } from "../../lib/uuid";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
const atoms = createWorkPlanAtoms(connectionAtomRuntime);
type Command = WorkPlanMutation extends infer T
  ? T extends WorkPlanMutation
    ? Omit<T, "commandId" | "id">
    : never
  : never;
const inputClass = "min-h-20 rounded-lg border border-border p-3 text-foreground";
function Choice({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: ReadonlyArray<{ id: string; title: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <ControlPillMenu
      title={label}
      actions={options.map((option) => ({
        ...option,
        state: option.id === value ? ("on" as const) : ("off" as const),
      }))}
      onPressAction={({ nativeEvent }) => onChange(nativeEvent.event)}
    >
      <ControlPill
        label={`${label}: ${options.find((option) => option.id === value)?.title ?? "Select"}`}
      />
    </ControlPillMenu>
  );
}
export function WorkPlanPanel({
  environmentId,
  id,
  onClose,
  executionSupported = false,
  initialAction = "plan",
  inline = false,
}: {
  environmentId: EnvironmentId;
  id: WorkItemId;
  onClose: () => void;
  executionSupported?: boolean;
  initialAction?: "plan" | "execute";
  inline?: boolean;
}) {
  const navigation = useNavigation();
  const result = useEnvironmentQuery(atoms.get({ environmentId, input: { id } }));
  const mutate = useAtomCommand(atoms.mutate, { reportFailure: false });
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [feedback, setFeedback] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ revision: number; content: WorkPlanContent } | null>(null);
  const [actionTab, setActionTab] = useState<"plan" | "execute">(initialAction);
  const [executionVisited, setExecutionVisited] = useState(initialAction === "execute");
  const visibleTab = executionSupported && !editor ? actionTab : "plan";
  const previous = useRef<{ key: string; command: WorkPlanMutation } | null>(null);
  const data = result.data;
  const repository = useWorkTaskRepository(environmentId, data?.item);
  const canPlan =
    !!data &&
    ["inbox", "backlog", "ready", "awaiting_approval", "blocked"].includes(data.item.status);
  const plan = data?.plan;
  const [startedCommandId, setStartedCommandId] = useState<string | null>(null);
  useOpenWorkThread(
    environmentId,
    plan?.generationId === startedCommandId ? plan.threadId : null,
    onClose,
  );
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
        : { ...command, id, commandId: uuidv4() };
    previous.current = { key, command: input };
    try {
      const response = await mutate({ environmentId, input });
      if (response._tag === "Success") {
        previous.current = null;
        setEditor(null);
        if (input.kind === "start") setStartedCommandId(input.commandId);
        else if (input.kind === "cancel") setStartedCommandId(null);
        result.refresh();
      } else {
        const failure = Cause.squash(response.cause);
        setError(failure instanceof Error ? failure.message : "Could not update plan.");
      }
    } finally {
      setPending(false);
    }
  }
  const content = (
    <>
      <ControlPill
        label={inline ? "Hide agent controls" : "Close task"}
        onPress={onClose}
        disabled={pending}
      />
      {!inline && <Text className="text-xl font-semibold">{data?.item.title ?? "Task"}</Text>}
      {(error || result.error) && (
        <Text accessibilityRole="alert" className="text-destructive">
          {error ?? result.error}
        </Text>
      )}
      {!data ? (
        <Text>Loading task…</Text>
      ) : (
        <>
          <WorkTaskContext environmentId={environmentId} item={data.item} />
          <View className="w-full flex-row gap-1 rounded-lg border border-border bg-card p-1">
            {(["plan", ...(executionSupported ? (["execute"] as const) : [])] as const).map(
              (tab) => (
                <Pressable
                  key={tab}
                  accessibilityRole={Platform.OS === "ios" ? "button" : "tab"}
                  accessibilityState={{
                    selected: visibleTab === tab,
                    disabled: tab === "execute" && !!editor,
                  }}
                  disabled={tab === "execute" && !!editor}
                  onPress={() => {
                    setActionTab(tab);
                    if (tab === "execute") setExecutionVisited(true);
                  }}
                  className={`min-h-11 flex-1 items-center justify-center rounded-md px-5 ${visibleTab === tab ? "bg-subtle-strong" : ""} ${tab === "execute" && editor ? "opacity-50" : ""}`}
                >
                  <Text className="text-sm font-medium">{tab === "plan" ? "Plan" : "Execute"}</Text>
                </Pressable>
              ),
            )}
          </View>
          <View style={visibleTab === "plan" ? undefined : { display: "none" }} className="gap-4">
            <WorkRepositoryField {...repository} disabled={pending || generating} />
            <Text className="text-sm text-muted-foreground">
              Planning inspects repository snapshots without changing files. A dedicated agent
              thread keeps the result.
            </Text>
            {!generating && (
              <>
                <Choice
                  label="Agent"
                  value={agent?.instanceId ?? ""}
                  options={data.agents.map((agent) => ({
                    id: agent.instanceId,
                    title: agent.displayName ?? agent.driver,
                  }))}
                  onChange={(value) => {
                    setProvider(value);
                    setModel("");
                  }}
                />
                <Choice
                  label="Model"
                  value={chosenModel ?? ""}
                  options={
                    agent?.models.map((model) => ({ id: model.slug, title: model.name })) ?? []
                  }
                  onChange={setModel}
                />
                <Text>Guidance for this plan (optional)</Text>
                <TextInput
                  className={inputClass}
                  accessibilityLabel="Plan guidance"
                  multiline
                  maxLength={20000}
                  value={feedback}
                  onChangeText={setFeedback}
                  placeholder="Constraints or changes for a regenerated plan"
                />
              </>
            )}
            {!data.agents.length && (
              <Text className="text-sm text-muted-foreground">
                Enable a supported provider in Settings. Protected planning supports Codex, Claude,
                OpenCode and Antigravity. Cursor and Grok are unavailable for this workflow.
              </Text>
            )}
            {!generating && !canPlan && (
              <Text className="text-sm text-muted-foreground">
                Finish active work or reopen this task before starting a plan.
              </Text>
            )}
            {data.item.archivedAt && (
              <Text className="text-sm text-muted-foreground">
                Restore this task before starting a plan.
              </Text>
            )}
            {generating ? (
              <>
                <Text>Planning with {plan.agentName}… You can close this view.</Text>
                <ControlPill
                  label="Cancel planning"
                  disabled={pending || data.item.status === "running"}
                  onPress={() => void send({ kind: "cancel", expectedRevision: plan.revision })}
                />
              </>
            ) : (
              <ControlPill
                label={plan ? "Regenerate plan" : "Plan with Agent"}
                disabled={
                  pending ||
                  !agent ||
                  !chosenModel ||
                  !repository.projectId ||
                  data.item.archivedAt !== null ||
                  !canPlan
                }
                onPress={() => {
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
              />
            )}
          </View>
          {executionSupported && executionVisited && (
            <View style={visibleTab === "execute" ? undefined : { display: "none" }}>
              <WorkExecutionPanel
                environmentId={environmentId}
                id={id}
                plan={plan ?? null}
                onClose={onClose}
              />
            </View>
          )}
          <WorkTaskDiscussions environmentId={environmentId} item={data.item} />
          {plan && (
            <WorkDetails title="Plan details">
              {plan && (
                <Text className="text-sm text-muted-foreground">
                  {plan.agentName} · {plan.modelSelection.model} · {plan.status} · Revision{" "}
                  {plan.revision}
                  {plan.generatedAt ? ` · ${new Date(plan.generatedAt).toLocaleString()}` : ""}
                </Text>
              )}
              {plan?.content && data.threadAvailable !== false && (
                <ControlPill
                  label="View agent thread"
                  onPress={() => {
                    onClose();
                    navigation.navigate("Thread", { environmentId, threadId: plan.threadId });
                  }}
                />
              )}
              {plan?.error && (
                <Text accessibilityRole="alert" className="text-destructive">
                  {plan.error}
                </Text>
              )}
              {plan?.status === "approved" && data.item.status === "ready" && (
                <Text>
                  {plan.approvedWorkItemRevision === data.item.revision
                    ? "Plan approved. Review validation commands before execution."
                    : "Work changed since approval. Regenerate before execution."}
                </Text>
              )}
              {editor ? (
                <View className="gap-3">
                  <Text>Summary</Text>
                  <TextInput
                    className={inputClass}
                    accessibilityLabel="Plan summary"
                    multiline
                    value={editor.content.summary}
                    onChangeText={(value) =>
                      setEditor({ ...editor, content: { ...editor.content, summary: value } })
                    }
                  />
                  {WORK_PLAN_SECTIONS.map((section) => (
                    <View key={section.key} className="gap-1">
                      <Text>{section.label} (one per line)</Text>
                      <TextInput
                        className={inputClass}
                        accessibilityLabel={section.label}
                        multiline
                        value={editor.content[section.key].join("\n")}
                        onChangeText={(value) =>
                          setEditor({
                            ...editor,
                            content: { ...editor.content, [section.key]: value.split("\n") },
                          })
                        }
                      />
                    </View>
                  ))}
                  <Choice
                    label="Complexity"
                    value={editor.content.complexity}
                    options={["low", "medium", "high"].map((value) => ({
                      id: value,
                      title: value,
                    }))}
                    onChange={(value) =>
                      setEditor({
                        ...editor,
                        content: {
                          ...editor.content,
                          complexity: value as WorkPlanContent["complexity"],
                        },
                      })
                    }
                  />
                  <ControlPill
                    label="Save plan"
                    disabled={pending || data.item.status === "running"}
                    onPress={() =>
                      void send({
                        kind: "edit",
                        expectedRevision: editor.revision,
                        content: editor.content,
                      })
                    }
                  />
                  <ControlPill label="Cancel edit" onPress={() => setEditor(null)} />
                </View>
              ) : (
                plan?.content && (
                  <View className="gap-4 rounded-xl border border-border p-4">
                    <Text selectable>{plan.content.summary}</Text>
                    {WORK_PLAN_SECTIONS.map((section) => (
                      <View key={section.key} className="gap-1">
                        <Text className="font-semibold">{section.label}</Text>
                        {Array.from(new Set(plan.content![section.key])).map((entry) => (
                          <Text key={entry} selectable>
                            • {entry}
                          </Text>
                        ))}
                      </View>
                    ))}
                    <Text>Complexity: {plan.content.complexity}</Text>
                    <Text className="text-xs text-muted-foreground">
                      Inspected files:{" "}
                      {plan.inspectedFiles.join(", ") || "No readable source files"}
                    </Text>
                    <ControlPill
                      label="Edit plan"
                      disabled={pending || data.item.status === "running"}
                      onPress={() => setEditor({ revision: plan.revision, content: plan.content! })}
                    />
                    {plan.status === "draft" && (
                      <>
                        <ControlPill
                          label="Approve plan"
                          disabled={pending || data.item.status === "running"}
                          onPress={() =>
                            void send({ kind: "approve", expectedRevision: plan.revision })
                          }
                        />
                        <ControlPill
                          label="Reject / replan"
                          disabled={pending || data.item.status === "running"}
                          onPress={() =>
                            void send({ kind: "reject", expectedRevision: plan.revision })
                          }
                        />
                      </>
                    )}
                  </View>
                )
              )}
            </WorkDetails>
          )}
        </>
      )}
      <WorkDetails title="Activity">
        <WorkActivityPanel environmentId={environmentId} id={id} onNavigate={onClose} />
      </WorkDetails>
    </>
  );
  if (inline) return <View className="gap-4">{content}</View>;
  return (
    <Modal visible presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView className="flex-1 bg-background" edges={["top", "bottom"]}>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerClassName="gap-4 p-4 pb-10">
          {content}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}
