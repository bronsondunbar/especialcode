import { WorkDashboardPanel } from "./WorkDashboardPanel";
import { WorkAutomationPanel } from "./WorkAutomationPanel";
import { WorkActivityPanel } from "./WorkActivityPanel";
import { SafeAreaView } from "react-native-safe-area-context";
import { SlackPanel } from "./SlackPanel";
import { WorkPlanPanel } from "./WorkPlanPanel";
import { GitHubIssuesPanel } from "./GitHubIssuesPanel";
import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import { createWorkItemAtoms } from "@t3tools/client-runtime/state/work-items";
import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WorkItemId,
  WORK_ITEM_MANUAL_STATUSES,
  WORK_ITEM_VIEWS,
  type EnvironmentId,
  type WorkItem,
  type WorkItemSummary,
  type WorkItemMutation,
  type WorkItemPatch,
  type WorkItemPriority,
  type WorkItemSource,
  type WorkItemStatus,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { useDeferredValue, useRef, useState } from "react";
import { Modal, Platform, Pressable, RefreshControl, ScrollView, View } from "react-native";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { ControlPill, ControlPillMenu } from "../../components/ControlPill";
import { connectionAtomRuntime } from "../../connection/runtime";
import { uuidv4 } from "../../lib/uuid";
import { useEnvironments, type EnvironmentPresentation } from "../../state/environments";
import { environmentProjects } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";

const atoms = createWorkItemAtoms(connectionAtomRuntime);
type Command = WorkItemMutation extends infer T
  ? T extends WorkItemMutation
    ? Omit<T, "commandId">
    : never
  : never;
const label = (value: string) => value.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase());

function Choice({
  title,
  value,
  options,
  onChange,
}: {
  title: string;
  value: string;
  options: ReadonlyArray<{ id: string; title: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <ControlPillMenu
      title={title}
      actions={options.map((option) => ({
        ...option,
        state: option.id === value ? ("on" as const) : ("off" as const),
      }))}
      onPressAction={({ nativeEvent }) => onChange(nativeEvent.event)}
    >
      <ControlPill
        variant="pill"
        label={`${title}: ${options.find((option) => option.id === value)?.title ?? value}`}
        accessibilityLabel={title}
      />
    </ControlPillMenu>
  );
}

export function AutomationSettingsRouteScreen() {
  return <WorkRouteScreen initialTab="automations" />;
}

export function WorkRouteScreen({ initialTab = "queue" }: { initialTab?: string }) {
  const navigation = useNavigation();
  const { environments } = useEnvironments();
  const supported = environments.filter(
    (environment) => environment.serverConfig?.environment.capabilities.workItems === true,
  );
  const [tab, setTab] = useState(initialTab);
  const [selected, setSelected] = useState<string>("");
  const environment = supported.find((item) => item.environmentId === selected) ?? supported[0];
  return (
    <View className="flex-1 bg-background">
      {Platform.OS === "android" && (
        <AndroidScreenHeader title="Work" onBack={() => navigation.goBack()} />
      )}
      {supported.length > 1 && (
        <View className="p-3">
          <Choice
            title="Environment"
            value={environment?.environmentId ?? ""}
            options={supported.map((item) => ({ id: item.environmentId, title: item.label }))}
            onChange={setSelected}
          />
        </View>
      )}
      {environment && (
        <View className="flex-row flex-wrap gap-2 px-4 py-2">
          {environment.serverConfig?.environment.capabilities.workDashboard && (
            <ControlPill variant="pill" label="Dashboard" onPress={() => setTab("dashboard")} />
          )}
          {environment.serverConfig?.environment.capabilities.workAutomations && (
            <ControlPill variant="pill" label="Automations" onPress={() => setTab("automations")} />
          )}
          <ControlPill label="Work Queue" onPress={() => setTab("queue")} />
          {environment.serverConfig?.environment.capabilities.slack && (
            <ControlPill label="Slack" onPress={() => setTab("slack")} />
          )}
          {environment.serverConfig?.environment.capabilities.githubIssues && (
            <ControlPill label="GitHub Issues" onPress={() => setTab("github")} />
          )}
        </View>
      )}
      {environment &&
      tab === "dashboard" &&
      environment.serverConfig?.environment.capabilities.workDashboard ? (
        <WorkDashboardPanel key={environment.environmentId} environment={environment} />
      ) : environment &&
        tab === "automations" &&
        environment.serverConfig?.environment.capabilities.workAutomations ? (
        <WorkAutomationPanel
          autonomousSupported={
            environment.serverConfig?.environment.capabilities.autonomousWork === true
          }
          key={environment.environmentId}
          environmentId={environment.environmentId}
          providers={environment.serverConfig?.providers ?? []}
        />
      ) : environment &&
        tab === "slack" &&
        environment.serverConfig?.environment.capabilities.slack ? (
        <SlackPanel
          key={environment.environmentId}
          environmentId={environment.environmentId}
          planningSupported={environment.serverConfig?.environment.capabilities.workPlans === true}
          executionSupported={
            environment.serverConfig?.environment.capabilities.workExecutions === true
          }
          pullRequestsSupported={
            environment.serverConfig?.environment.capabilities.workPullRequests === true
          }
          reviewsSupported={environment.serverConfig?.environment.capabilities.workReviews === true}
        />
      ) : environment &&
        tab === "github" &&
        environment.serverConfig?.environment.capabilities.githubIssues ? (
        <GitHubIssuesPanel
          key={environment.environmentId}
          environmentId={environment.environmentId}
        />
      ) : environment ? (
        <Queue key={environment.environmentId} environment={environment} />
      ) : (
        <Text className="p-6 text-muted-foreground">
          Connect to an environment with Work support. Older servers need the project-management
          update.
        </Text>
      )}
    </View>
  );
}

function Queue({ environment }: { environment: EnvironmentPresentation }) {
  const environmentId: EnvironmentId = environment.environmentId;
  const projects = useAtomValue(environmentProjects.projectsAtom).filter(
    (project) => project.environmentId === environmentId,
  );
  const [activityId, setActivityId] = useState<WorkItemId | null>(null);
  const [planningId, setPlanningId] = useState<WorkItemId | null>(null);
  const [view, setView] = useState("inbox");
  const [search, setSearch] = useState("");
  const query = useDeferredValue(search);
  const [project, setProject] = useState("");
  const [priority, setPriority] = useState("");
  const [source, setSource] = useState("");
  const [archived, setArchived] = useState(false);
  const [offset, setOffset] = useState(0);
  const [editor, setEditor] = useState<{ id: WorkItemId; item: WorkItem | null } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const previous = useRef<{ key: string; command: WorkItemMutation } | null>(null);
  const read = useAtomCommand(atoms.read, { reportFailure: false });
  const mutate = useAtomCommand(atoms.mutate, { reportFailure: false });
  const result = useEnvironmentQuery(
    atoms.list({
      environmentId,
      input: {
        ...(archived
          ? {}
          : { statuses: [...(WORK_ITEM_VIEWS.find((tab) => tab.id === view)?.statuses ?? [])] }),
        ...(project
          ? { projectId: project === "unassigned" ? null : ProjectId.make(project) }
          : {}),
        ...(priority ? { priority: priority as WorkItemPriority } : {}),
        ...(source ? { source: source as WorkItemSource } : {}),
        query,
        archived,
        offset,
        limit: 50,
      },
    }),
  );
  async function send(command: Command): Promise<boolean> {
    if (pending) return false;
    setPending(true);
    setError(null);
    const key = JSON.stringify(command);
    const request =
      previous.current?.key === key
        ? previous.current.command
        : { ...command, commandId: uuidv4() };
    previous.current = { key, command: request };
    try {
      const outcome = await mutate({ environmentId, input: request });
      if (outcome._tag === "Success") {
        previous.current = null;
        result.refresh();
        return true;
      }
      const failure = Cause.squash(outcome.cause);
      setError(failure instanceof Error ? failure.message : "Could not save this task. Try again.");
      return false;
    } finally {
      setPending(false);
    }
  }
  async function edit(id: WorkItemId) {
    setPending(true);
    setError(null);
    try {
      const outcome = await read({ environmentId, input: { id } });
      if (outcome._tag === "Success") setEditor({ id, item: outcome.value });
      else {
        const failure = Cause.squash(outcome.cause);
        setError(failure instanceof Error ? failure.message : "Could not load task.");
      }
    } finally {
      setPending(false);
    }
  }
  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerClassName="gap-4 p-4 pb-12"
      refreshControl={<RefreshControl refreshing={result.isPending} onRefresh={result.refresh} />}
    >
      {activityId && (
        <Modal visible animationType="slide" onRequestClose={() => setActivityId(null)}>
          <SafeAreaView className="flex-1 bg-background">
            <ScrollView contentContainerClassName="gap-4 p-4">
              <ControlPill label="Close activity" onPress={() => setActivityId(null)} />
              <WorkActivityPanel
                environmentId={environmentId}
                id={activityId}
                onNavigate={() => setActivityId(null)}
              />
            </ScrollView>
          </SafeAreaView>
        </Modal>
      )}
      {planningId && (
        <WorkPlanPanel
          reviewsSupported={environment.serverConfig?.environment.capabilities.workReviews === true}
          pullRequestsSupported={
            environment.serverConfig?.environment.capabilities.workPullRequests === true
          }
          executionSupported={
            environment.serverConfig?.environment.capabilities.workExecutions === true
          }
          key={planningId}
          environmentId={environmentId}
          id={planningId}
          onClose={() => setPlanningId(null)}
        />
      )}
      <View className="flex-row items-center justify-between">
        <Text className="text-xl font-semibold">Your work queue</Text>
        <ControlPill
          variant="primary"
          label="Create task"
          disabled={pending}
          onPress={() => {
            setError(null);
            setEditor({ id: WorkItemId.make(uuidv4()), item: null });
          }}
        />
      </View>
      <View className="flex-row flex-wrap gap-2">
        {WORK_ITEM_VIEWS.map((tab) => (
          <ControlPill
            key={tab.id}
            variant={!archived && view === tab.id ? "primary" : "pill"}
            label={tab.label}
            onPress={() => {
              setOffset(0);
              setArchived(false);
              setView(tab.id);
            }}
          />
        ))}
        <ControlPill
          variant={archived ? "primary" : "pill"}
          label="Archived"
          onPress={() => {
            setOffset(0);
            setArchived(!archived);
          }}
        />
      </View>
      <TextInput
        accessibilityLabel="Search work items"
        placeholder="Search tasks…"
        className="rounded-xl border border-border p-3 text-foreground"
        value={search}
        onChangeText={(value) => {
          setSearch(value);
          setOffset(0);
        }}
      />
      <View pointerEvents={pending ? "none" : "auto"} className="flex-row flex-wrap gap-2">
        <Choice
          title="Project"
          value={project}
          options={[
            { id: "", title: "All" },
            { id: "unassigned", title: "Unassigned" },
            ...projects.map((item) => ({ id: item.id, title: item.title })),
          ]}
          onChange={(value) => {
            setProject(value);
            setOffset(0);
          }}
        />
        <Choice
          title="Priority"
          value={priority}
          options={[
            { id: "", title: "All" },
            ...["urgent", "high", "medium", "low"].map((id) => ({ id, title: label(id) })),
          ]}
          onChange={(value) => {
            setPriority(value);
            setOffset(0);
          }}
        />
        <Choice
          title="Source"
          value={source}
          options={[
            { id: "", title: "All" },
            ...["manual", "github_issue", "github_pr", "slack", "automation"].map((id) => ({
              id,
              title: label(id),
            })),
          ]}
          onChange={(value) => {
            setSource(value);
            setOffset(0);
          }}
        />
      </View>
      {(error || result.error) && (
        <Text accessibilityRole="alert" className="text-destructive">
          {error ?? result.error}
        </Text>
      )}
      {editor && (
        <Editor
          key={`${editor.id}:${editor.item?.revision ?? "new"}`}
          item={editor.item}
          projectOptions={projects.map((item) => ({ id: item.id, title: item.title }))}
          providerOptions={(environment.serverConfig?.providers ?? []).map((provider) => ({
            id: provider.instanceId,
            title: provider.displayName ?? provider.instanceId,
          }))}
          pending={pending}
          onCancel={() => {
            setEditor(null);
            setError(null);
          }}
          onSave={async (fields) => {
            if (
              await send(
                editor.item
                  ? {
                      kind: "update",
                      id: editor.id,
                      expectedRevision: editor.item.revision,
                      patch: fields,
                    }
                  : {
                      kind: "create",
                      id: editor.id,
                      source: "manual",
                      title: fields.title ?? "",
                      fields,
                    },
              )
            )
              setEditor(null);
          }}
        />
      )}
      {result.data?.items.length === 0 && (
        <Text className="py-8 text-center text-muted-foreground">
          {view === "running" && !archived
            ? "No active planning work. Open a Ready task to plan with an agent."
            : "No tasks here. Create a task or adjust your filters."}
        </Text>
      )}
      {result.data?.items.map((item) => (
        <View key={item.id} className="gap-3 rounded-xl border border-border p-4">
          <Text className="text-lg font-semibold">{item.title}</Text>
          {environment.serverConfig?.environment.capabilities.workActivity && (
            <ControlPill label="Activity" onPress={() => setActivityId(item.id)} />
          )}
          {environment.serverConfig?.environment.capabilities.workPlans && (
            <ControlPill label="Plan / Execution" onPress={() => setPlanningId(item.id)} />
          )}
          <Text className="text-sm text-muted-foreground">
            {label(item.source)} ·{" "}
            {projects.find((project) => project.id === item.projectId)?.title ??
              (item.projectId ? "Unavailable project" : "Unassigned")}{" "}
            · {label(item.priority)} · {label(item.status)}
          </Text>
          {item.repository && (
            <Text>
              {item.repository}
              {item.branch ? ` · ${item.branch}` : ""}
            </Text>
          )}
          {item.assignedAgent && (
            <Text className="text-sm">
              Agent:{" "}
              {environment.serverConfig?.providers.find(
                (provider) => provider.instanceId === item.assignedAgent,
              )?.displayName ?? item.assignedAgent}
            </Text>
          )}
          {item.bodyPreview && (
            <Text numberOfLines={4} className="text-muted-foreground">
              {item.bodyPreview}
            </Text>
          )}
          {item.failureReason && <Text className="text-destructive">{item.failureReason}</Text>}
          {!item.archivedAt && (
            <Move
              key={`${item.id}:${item.revision}`}
              item={item}
              pending={pending}
              onMove={(status, reason) =>
                send({
                  kind: "status",
                  id: item.id,
                  expectedRevision: item.revision,
                  status,
                  ...(reason.trim() ? { reason: reason.trim() } : {}),
                })
              }
            />
          )}
          <View className="flex-row gap-2">
            <ControlPill
              label="Edit"
              variant="pill"
              disabled={pending || item.archivedAt !== null}
              onPress={() => void edit(item.id)}
            />
            <ControlPill
              variant="pill"
              label={item.archivedAt ? "Restore" : "Archive"}
              disabled={pending}
              onPress={() =>
                void send({
                  kind: "archive",
                  id: item.id,
                  expectedRevision: item.revision,
                  archived: item.archivedAt === null,
                })
              }
            />
          </View>
          <Text selectable className="text-xs text-muted-foreground">
            Task ID: {item.id}
          </Text>
        </View>
      ))}
      {result.data && (
        <View className="flex-row items-center justify-between">
          <Text>{result.data.total} tasks</Text>
          <ControlPill
            variant="pill"
            label="Previous"
            disabled={offset === 0}
            onPress={() => setOffset(Math.max(0, offset - 50))}
          />
          <ControlPill
            variant="pill"
            label="Next"
            disabled={offset + 50 >= result.data.total}
            onPress={() => setOffset(offset + 50)}
          />
        </View>
      )}
    </ScrollView>
  );
}

function Move({
  item,
  pending,
  onMove,
}: {
  item: WorkItemSummary;
  pending: boolean;
  onMove: (status: WorkItemStatus, reason: string) => Promise<boolean>;
}) {
  const [status, setStatus] = useState(item.status);
  const [reason, setReason] = useState(item.failureReason ?? "");
  const active = !WORK_ITEM_MANUAL_STATUSES.some((value) => value === item.status);
  return (
    <View className="gap-2">
      <View className="flex-row gap-2">
        <Choice
          title="Status"
          value={status}
          options={WORK_ITEM_MANUAL_STATUSES.map((id) => ({ id, title: label(id) }))}
          onChange={(value) => setStatus(value as WorkItemStatus)}
        />
        <ControlPill
          variant="pill"
          label="Move"
          disabled={
            pending || active || status === item.status || (status === "blocked" && !reason.trim())
          }
          onPress={() => void onMove(status, reason)}
        />
      </View>
      {status === "blocked" && (
        <TextInput
          accessibilityLabel="Blocked reason"
          placeholder="Why is this blocked?"
          className="rounded-xl border border-border p-3 text-foreground"
          value={reason}
          maxLength={500}
          onChangeText={setReason}
        />
      )}
    </View>
  );
}

function Editor({
  item,
  projectOptions,
  providerOptions,
  pending,
  onSave,
  onCancel,
}: {
  item: WorkItem | null;
  projectOptions: ReadonlyArray<{ id: string; title: string }>;
  providerOptions: ReadonlyArray<{ id: string; title: string }>;
  pending: boolean;
  onSave: (fields: WorkItemPatch) => Promise<void>;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(item?.title ?? "");
  const [body, setBody] = useState(item?.body ?? "");
  const [project, setProject] = useState<string>(item?.projectId ?? "");
  const [agent, setAgent] = useState<string>(item?.assignedAgent ?? "");
  const [priority, setPriority] = useState<WorkItemPriority>(item?.priority ?? "medium");
  const [repository, setRepository] = useState(item?.repository ?? "");
  const [branch, setBranch] = useState(item?.branch ?? "");
  const [parent, setParent] = useState<string>(item?.parentWorkItemId ?? "");
  const [thread, setThread] = useState<string>(item?.agentThreadId ?? "");
  return (
    <View className="gap-3 rounded-xl border border-border p-4">
      <Text className="font-semibold">{item ? "Edit task" : "Create task"}</Text>
      <TextInput
        accessibilityLabel="Task title"
        placeholder="Title"
        className="rounded-lg border border-border p-3 text-foreground"
        value={title}
        maxLength={500}
        onChangeText={setTitle}
        editable={!pending}
      />
      <TextInput
        accessibilityLabel="Task description"
        placeholder="Description"
        multiline
        className="min-h-24 rounded-lg border border-border p-3 text-foreground"
        value={body}
        maxLength={100000}
        onChangeText={setBody}
        editable={!pending}
      />
      <View pointerEvents={pending ? "none" : "auto"} className="flex-row flex-wrap gap-2">
        <Choice
          title="Project"
          value={project}
          options={[{ id: "", title: "Unassigned" }, ...projectOptions]}
          onChange={(value) => {
            setProject(value);
            setThread("");
          }}
        />
        <Choice
          title="Agent"
          value={agent}
          options={[{ id: "", title: "Unassigned" }, ...providerOptions]}
          onChange={setAgent}
        />
        <Choice
          title="Priority"
          value={priority}
          options={["low", "medium", "high", "urgent"].map((id) => ({ id, title: label(id) }))}
          onChange={(value) => setPriority(value as WorkItemPriority)}
        />
      </View>
      {(
        [
          ["Repository", repository, setRepository],
          ["Branch", branch, setBranch],
          ["Parent task ID", parent, setParent],
          ["Agent thread ID", thread, setThread],
        ] as const
      ).map(([name, value, update]) => (
        <TextInput
          key={name}
          accessibilityLabel={name}
          placeholder={`${name} (optional)`}
          className="rounded-lg border border-border p-3 text-foreground"
          value={value}
          onChangeText={update}
          maxLength={500}
          editable={!pending}
        />
      ))}
      <View className="flex-row gap-2">
        <ControlPill
          variant="primary"
          label={pending ? "Saving…" : "Save task"}
          disabled={pending || !title.trim()}
          onPress={() =>
            void onSave({
              title: title.trim(),
              body,
              projectId: project ? ProjectId.make(project) : null,
              priority,
              assignedAgent: agent ? ProviderInstanceId.make(agent) : null,
              repository: repository.trim() || null,
              branch: branch.trim() || null,
              parentWorkItemId: parent.trim() ? WorkItemId.make(parent.trim()) : null,
              agentThreadId: thread.trim() ? ThreadId.make(thread.trim()) : null,
            })
          }
        />
        <Pressable
          accessibilityRole="button"
          disabled={pending}
          onPress={onCancel}
          className="justify-center p-2"
        >
          <Text>Cancel</Text>
        </Pressable>
      </View>
    </View>
  );
}
