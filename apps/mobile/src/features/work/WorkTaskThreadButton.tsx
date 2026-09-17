import { WorkRepositoryField, useWorkTaskRepository } from "./WorkRepositoryField";
import { VercelProjectField, type VercelSelection } from "../vercel/VercelProjectField";
import {
  workTaskDiscussionSources,
  workTaskBranchName,
  workTaskBranchError,
  workTaskPromptWithDiscussion,
  type WorkTaskDiscussion,
} from "@t3tools/client-runtime/state/work-items";
import { useRef, useState } from "react";
import { useNavigation } from "@react-navigation/native";
import { Modal, ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import * as Cause from "effect/Cause";
import {
  createWorkItemAtoms,
  workTaskPrompt,
  type WorkTaskThreadInput,
} from "@t3tools/client-runtime/state/work-items";
import {
  ProjectId,
  ThreadId,
  type EnvironmentId,
  type WorkItem,
  type WorkItemId,
} from "@t3tools/contracts";
import { connectionAtomRuntime } from "../../connection/runtime";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { uuidv4 } from "../../lib/uuid";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { setComposerDraftText } from "../../state/use-composer-drafts";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { ControlPill, ControlPillMenu } from "../../components/ControlPill";
const atoms = createWorkItemAtoms(connectionAtomRuntime);
function Choice({
  title,
  value,
  options,
  disabled,
  onChange,
}: {
  title: string;
  value: string;
  options: ReadonlyArray<{ id: string; title: string }>;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <ControlPillMenu
      title={title}
      actions={options.map((option) => ({
        ...option,
        state: option.id === value ? ("on" as const) : ("off" as const),
      }))}
      onPressAction={({ nativeEvent }) => {
        if (!disabled) onChange(nativeEvent.event);
      }}
    >
      <ControlPill
        disabled={disabled}
        label={`${title}: ${options.find((option) => option.id === value)?.title ?? "Choose"}`}
      />
    </ControlPillMenu>
  );
}
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
      <ControlPill label="New thread" onPress={() => setOpen(true)} />
      {open && (
        <TaskThreadModal environmentId={environmentId} id={id} onClose={() => setOpen(false)} />
      )}
    </>
  );
}
function TaskThreadModal({
  environmentId,
  id,
  onClose,
}: {
  environmentId: EnvironmentId;
  id: WorkItemId;
  onClose: () => void;
}) {
  const [pending, setPending] = useState(false);
  const query = useEnvironmentQuery(atoms.get({ environmentId, input: { id } }));
  return (
    <Modal
      visible
      animationType="slide"
      onRequestClose={() => {
        if (!pending) onClose();
      }}
    >
      <SafeAreaView className="flex-1 bg-background">
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerClassName="gap-4 p-4">
          <Text className="text-xl font-semibold">New thread from task</Text>
          {query.error && (
            <Text accessibilityRole="alert" className="text-destructive">
              {query.error}
            </Text>
          )}
          {!query.data && <ControlPill label="Close" onPress={onClose} />}
          {!query.data && query.isPending && <Text>Loading task…</Text>}
          {query.data && (
            <TaskThreadForm
              environmentId={environmentId}
              task={query.data}
              onClose={onClose}
              pending={pending}
              setPending={setPending}
            />
          )}
        </ScrollView>
      </SafeAreaView>
    </Modal>
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
  const navigation = useNavigation();
  const repository = useWorkTaskRepository(environmentId, task);
  const { projects, projectId } = repository;
  const { environments } = useEnvironments();
  const providers = (
    environments.find((environment) => environment.environmentId === environmentId)?.serverConfig
      ?.providers ?? []
  ).filter((provider) => provider.enabled && provider.models.length > 0);
  const project = projects.find((project) => project.id === projectId);
  const [vercel, setVercel] = useState<{ projectId: string; selection: VercelSelection } | null>(
    null,
  );
  const [branchName, setBranchName] = useState(() => workTaskBranchName(task));
  const [baseSelection, setBaseSelection] = useState("");
  const branches = useEnvironmentQuery(
    atoms.branches({
      environmentId,
      input: { cwd: project?.workspaceRoot ?? null },
    }),
  );
  const baseBranch =
    branches.data?.find((ref) => ref.name === baseSelection)?.name ??
    branches.data?.find((ref) => ref.isDefault)?.name ??
    branches.data?.find(({ current }) => current)?.name ??
    branches.data?.[0]?.name ??
    "";
  const branchError = workTaskBranchError(branchName);
  const prepared = useRef<WorkTaskThreadInput["worktree"]>(undefined);
  const prepareBranch = useAtomCommand(atoms.prepareBranch, { reportFailure: false });
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
  const start = useAtomCommand(atoms.startThread, { reportFailure: false });
  const fetchDiscussion = useAtomCommand(atoms.discussion, { reportFailure: false });
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
        const failure = Cause.squash(response.cause);
        setError(failure instanceof Error ? failure.message : "Could not load discussion context.");
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

  function openThread(threadId: ThreadId) {
    setComposerDraftText(
      scopedThreadKey(environmentId, threadId),
      workTaskPromptWithDiscussion(prompt, discussions),
    );
    onClose();
    navigation.navigate("Thread", { environmentId, threadId });
  }
  async function submit() {
    if (pending || !provider || !selectedModel || !projectId || !prompt.trim()) return;
    setPending(true);
    setError(null);
    try {
      if (!prepared.current) {
        if (!project || !baseBranch || branchError) return;
        const result = await prepareBranch({
          environmentId,
          input: { task: contextTask, cwd: project.workspaceRoot, baseBranch, branch: branchName },
        });
        if (result._tag !== "Success") {
          const failure = Cause.squash(result.cause);
          setError(failure instanceof Error ? failure.message : "Could not create the branch.");
          return;
        }
        prepared.current = result.value.worktree;
      }
      setHasAttempt(true);
      attempt.current ??= {
        task: contextTask,
        projectId: ProjectId.make(projectId),
        threadId: ThreadId.make(uuidv4()),
        modelSelection: { instanceId: provider.instanceId, model: selectedModel.slug },
        createdAt: new Date().toISOString(),
        ...(prepared.current ? { worktree: prepared.current } : {}),
        branch: branches.data?.find((ref) => ref.current)?.name ?? null,
        ...(vercel?.projectId === projectId && vercel.selection
          ? { vercel: vercel.selection }
          : {}),
      };
      const response = await start({ environmentId, input: attempt.current });
      if (response._tag !== "Success") {
        const error = Cause.squash(response.cause);
        setError(
          error instanceof Error ? error.message : "Could not create the thread. Retry later.",
        );
        return;
      }
      setCreated(response.value.threadId);
      if (response.value.warning) {
        setError(response.value.warning);
        return;
      }
      openThread(response.value.threadId);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Could not create the thread. Retry later.",
      );
    } finally {
      setPending(false);
    }
  }
  return (
    <View className="gap-3">
      <Text className="text-sm text-muted-foreground">
        Choose where to work and review the prompt. The thread opens with this text ready to send.
      </Text>
      {task.agentThreadId && (
        <Text className="text-sm text-muted-foreground">
          The new thread will become this task’s linked thread. The previous thread stays available
          in its project.
        </Text>
      )}
      <WorkRepositoryField
        {...repository}
        disabled={pending || hasAttempt}
        setProjectId={(id) => {
          repository.setProjectId(id);
          setBaseSelection("");
        }}
      />
      <Text className="text-sm text-muted-foreground">
        A new branch will be created locally and on the remote.
      </Text>
      <>
        <Choice
          title="Base branch"
          value={baseBranch}
          options={(branches.data ?? []).map((ref) => ({ id: ref.name, title: ref.name }))}
          disabled={pending || hasAttempt || branches.isPending}
          onChange={setBaseSelection}
        />
        {branches.isPending && <Text>Loading branches…</Text>}
        <Text>New branch name</Text>
        <TextInput
          accessibilityLabel="New branch name"
          value={branchName}
          editable={!pending && !hasAttempt}
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={setBranchName}
          className="rounded-lg border border-border p-3 text-foreground"
        />
        {branchError && <Text className="text-destructive">{branchError}</Text>}
        {branches.error && (
          <Text accessibilityRole="alert" className="text-destructive">
            {branches.error}
          </Text>
        )}
        {!branches.isPending && project && !branches.error && !branches.data?.length && (
          <Text>
            This repository has no base branches. Select another repository or add an initial
            commit.
          </Text>
        )}
      </>

      {project && (
        <VercelProjectField
          key={project.id}
          environmentId={environmentId}
          projectId={project.id}
          value={vercel?.projectId === projectId ? vercel.selection : undefined}
          onChange={(selection) => setVercel({ projectId: project.id, selection })}
          disabled={pending || hasAttempt}
        />
      )}
      <Choice
        title="Agent"
        value={provider?.instanceId ?? ""}
        options={providers.map((provider) => ({
          id: provider.instanceId,
          title: provider.displayName ?? provider.instanceId,
        }))}
        disabled={pending || hasAttempt}
        onChange={(id) => {
          setProviderId(id);
          setModel("");
        }}
      />
      <Choice
        title="Model"
        value={selectedModel?.slug ?? ""}
        options={(provider?.models ?? []).map((model) => ({ id: model.slug, title: model.slug }))}
        disabled={pending || hasAttempt}
        onChange={setModel}
      />
      <Text>Prompt</Text>
      <TextInput
        accessibilityLabel="Task thread prompt"
        className="min-h-64 rounded-lg border border-border p-3 text-foreground"
        multiline
        textAlignVertical="top"
        value={prompt}
        editable={!pending}
        onChangeText={setPrompt}
      />
      {sources.length > 0 && (
        <View className="gap-2">
          <Text className="font-semibold">Discussion context (optional)</Text>
          <Text className="text-sm text-muted-foreground">
            Add comments or thread replies to the prompt. You can review and edit the combined text
            in the chat composer before sending.
          </Text>
          {sources
            .filter(
              (source) => !discussions.some((discussion) => discussion.source.key === source.key),
            )
            .map((source) => (
              <ControlPill
                key={source.key}
                label={`Add ${source.label}`}
                disabled={pending || hasAttempt}
                onPress={() => void addDiscussion(source.key)}
              />
            ))}
          {discussions.map((discussion) => (
            <View key={discussion.source.key} className="gap-2 rounded-lg border border-border p-3">
              <Text className="font-semibold">{discussion.source.label}</Text>
              <TextInput
                accessibilityLabel={discussion.source.label}
                value={discussion.text}
                editable={false}
                multiline
                className="max-h-48 rounded-lg border border-border p-3 text-foreground"
              />
              {discussion.truncated && (
                <Text className="text-sm text-muted-foreground">
                  Discussion shortened. Open the source for the remaining context.
                </Text>
              )}
              {discussion.hasMore && !discussion.truncated && (
                <ControlPill
                  label="Load more replies"
                  disabled={pending || hasAttempt}
                  onPress={() => void addDiscussion(discussion.source.key, true)}
                />
              )}
              <ControlPill
                label="Remove context"
                disabled={pending}
                onPress={() =>
                  setDiscussions((current) =>
                    current.filter((item) => item.source.key !== discussion.source.key),
                  )
                }
              />
            </View>
          ))}
        </View>
      )}
      {!providers.length && <Text>Enable an agent provider before starting a thread.</Text>}
      {task.archivedAt && <Text>Restore this task before starting a linked thread.</Text>}
      {hasAttempt && !created && (
        <Text className="text-sm text-muted-foreground">
          Branch {branchName} is ready. Retry will use it. Closing this dialog keeps the branch and
          worktree.
        </Text>
      )}
      {error && (
        <Text accessibilityRole="alert" className="text-destructive">
          {error}
        </Text>
      )}
      {created ? (
        <ControlPill label="Open created thread" onPress={() => openThread(created)} />
      ) : (
        <ControlPill
          label={
            pending
              ? hasAttempt
                ? "Creating thread…"
                : "Preparing…"
              : hasAttempt
                ? "Retry"
                : "Create thread"
          }
          disabled={
            pending ||
            !projects.some((project) => project.id === projectId) ||
            !baseBranch ||
            !!branchError ||
            !!branches.error ||
            branches.isPending ||
            !selectedModel ||
            !prompt.trim() ||
            !!task.archivedAt
          }
          onPress={() => void submit()}
        />
      )}
      <ControlPill label="Cancel" disabled={pending} onPress={onClose} />
    </View>
  );
}
