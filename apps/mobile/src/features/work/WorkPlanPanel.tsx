import { WorkActivityPanel } from "./WorkActivityPanel";
import { WorkReviewPanel } from "./WorkReviewPanel";
import { WorkPullRequestPanel } from "./WorkPullRequestPanel";
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
import { Modal, ScrollView, View } from "react-native";
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
  const navigation = useNavigation();
  const result = useEnvironmentQuery(atoms.get({ environmentId, input: { id } }));
  const mutate = useAtomCommand(atoms.mutate, { reportFailure: false });
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [feedback, setFeedback] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ revision: number; content: WorkPlanContent } | null>(null);
  const previous = useRef<{ key: string; command: WorkPlanMutation } | null>(null);
  const data = result.data;
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
        : { ...command, id, commandId: uuidv4() };
    previous.current = { key, command: input };
    try {
      const response = await mutate({ environmentId, input });
      if (response._tag === "Success") {
        previous.current = null;
        setEditor(null);
        result.refresh();
      } else {
        const failure = Cause.squash(response.cause);
        setError(failure instanceof Error ? failure.message : "Could not update plan.");
      }
    } finally {
      setPending(false);
    }
  }
  return (
    <Modal visible presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView className="flex-1 bg-background" edges={["top", "bottom"]}>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerClassName="gap-4 p-4 pb-10">
          <ControlPill label="Close plan" onPress={onClose} />
          <Text className="text-xl font-semibold">Plan{data ? `: ${data.item.title}` : ""}</Text>
          {(error || result.error) && (
            <Text accessibilityRole="alert" className="text-destructive">
              {error ?? result.error}
            </Text>
          )}
          {!data ? (
            <Text>Loading plan…</Text>
          ) : (
            <>
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
                  <Text>Guidance for this plan</Text>
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
                  Enable a supported provider in Settings. Protected planning supports Claude,
                  OpenCode and Antigravity. Codex, Cursor and Grok are unavailable for this
                  workflow.
                </Text>
              )}
              {!data.item.projectId ||
              !["ready", "awaiting_approval", "planning"].includes(data.item.status) ? (
                <Text className="text-muted-foreground">
                  Assign a project and move this WorkItem to Ready before planning.
                </Text>
              ) : null}
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
                    !data.item.projectId ||
                    data.item.archivedAt !== null ||
                    !["ready", "awaiting_approval"].includes(data.item.status)
                  }
                  onPress={() => {
                    if (agent && chosenModel)
                      void send({
                        kind: "start",
                        expectedWorkItemRevision: data.item.revision,
                        modelSelection: {
                          instanceId: ProviderInstanceId.make(agent.instanceId),
                          model: chosenModel,
                        },
                        feedback,
                      });
                  }}
                />
              )}
              {plan && (
                <Text className="text-sm text-muted-foreground">
                  {plan.agentName} · {plan.modelSelection.model} · {plan.status} · Revision{" "}
                  {plan.revision}
                  {plan.generatedAt ? ` · ${new Date(plan.generatedAt).toLocaleString()}` : ""}
                </Text>
              )}
              {plan?.content && (
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
              {pullRequestsSupported && !editor && (
                <WorkPullRequestPanel environmentId={environmentId} id={id} />
              )}
              {reviewsSupported && !editor && (
                <WorkReviewPanel environmentId={environmentId} id={id} />
              )}
              {executionSupported && !editor && (
                <WorkExecutionPanel
                  environmentId={environmentId}
                  id={id}
                  plan={plan ?? null}
                  onClose={onClose}
                />
              )}
            </>
          )}
          <WorkActivityPanel environmentId={environmentId} id={id} onNavigate={onClose} />
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}
