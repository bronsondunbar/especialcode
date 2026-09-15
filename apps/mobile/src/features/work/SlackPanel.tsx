import { ExternalSyncStatus } from "./ExternalSyncStatus";
import { useDeferredValue, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { createSlackAtoms, createWorkItemAtoms } from "@t3tools/client-runtime/state/work-items";
import {
  ProjectId,
  type EnvironmentId,
  type SlackAdminInput,
  type SlackChannel,
  type SlackChannelConfig,
  type SlackMessage,
  type SlackMutation,
  type WorkItemId,
  type WorkItemPriority,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { Linking, ScrollView, View, Switch } from "react-native";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { ControlPill, ControlPillMenu } from "../../components/ControlPill";
import { connectionAtomRuntime } from "../../connection/runtime";
import { environmentProjects } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { WorkPlanPanel } from "./WorkPlanPanel";
const atoms = createSlackAtoms(connectionAtomRuntime);
const workItems = createWorkItemAtoms(connectionAtomRuntime);
const errorMessage = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  return error instanceof Error ? error.message : "Request failed. Please retry.";
};
function Choice({
  title,
  value,
  options,
  onChange,
}: {
  title: string;
  value: string;
  options: ReadonlyArray<{ id: string; title: string }>;
  onChange: (id: string) => void;
}) {
  return (
    <ControlPillMenu
      title={title}
      actions={options.map((o) => ({
        ...o,
        state: o.id === value ? ("on" as const) : ("off" as const),
      }))}
      onPressAction={({ nativeEvent }) => onChange(nativeEvent.event)}
    >
      <ControlPill label={`${title}: ${options.find((o) => o.id === value)?.title ?? "Select"}`} />
    </ControlPillMenu>
  );
}
const inputClass = "rounded-lg border border-border px-3 py-2 text-foreground";
export function SlackPanel({
  environmentId,
  planningSupported = false,
  executionSupported = false,
  pullRequestsSupported = false,
  reviewsSupported = false,
}: {
  environmentId: EnvironmentId;
  planningSupported?: boolean;
  executionSupported?: boolean;
  pullRequestsSupported?: boolean;
  reviewsSupported?: boolean;
}) {
  const projects = useAtomValue(environmentProjects.projectsAtom).filter(
    (p) => p.environmentId === environmentId,
  );
  const [workspaceId, setWorkspaceId] = useState("");
  const [ignored, setIgnored] = useState(false);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [authorizeUrl, setAuthorizeUrl] = useState<string | null>(null);
  const [available, setAvailable] = useState<ReadonlyArray<typeof SlackChannel.Type>>([]);
  const [channelCursor, setChannelCursor] = useState("");
  const [channelId, setChannelId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [repository, setRepository] = useState("");
  const [channelMentions, setChannelMentions] = useState(false);
  const [priority, setPriority] = useState<WorkItemPriority>("medium");
  const [messageUrl, setMessageUrl] = useState("");
  const [planningId, setPlanningId] = useState<WorkItemId | null>(null);
  const [attachment, setAttachment] = useState<SlackMessage | null>(null);
  const [taskId, setTaskId] = useState("");
  const [taskSearch, setTaskSearch] = useState("");
  const deferredTaskSearch = useDeferredValue(taskSearch);
  const [detail, setDetail] = useState<SlackMessage | null>(null);
  const [pages, setPages] = useState<Record<string, number>>({});
  const result = useEnvironmentQuery(
    atoms.list({
      environmentId,
      input: { ...(workspaceId ? { workspaceId } : {}), ignored, offset, limit: 25 },
    }),
  );
  const tasks = useEnvironmentQuery(
    workItems.list({ environmentId, input: { limit: 100, query: deferredTaskSearch } }),
  );
  const read = useAtomCommand(atoms.read, { reportFailure: false });
  const mutate = useAtomCommand(atoms.mutate, { reportFailure: false });
  const admin = useAtomCommand(atoms.admin, { reportFailure: false });
  const data = result.data;
  const firstWorkspaceId = data?.workspaces[0]?.id ?? "";
  if (
    data &&
    workspaceId !== firstWorkspaceId &&
    !data.workspaces.some((w) => w.id === workspaceId)
  ) {
    setWorkspaceId(firstWorkspaceId);
    setOffset(0);
  }
  const workspace = data?.workspaces.find((w) => w.id === workspaceId) ?? data?.workspaces[0];
  async function configure(input: SlackAdminInput) {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const response = await admin({ environmentId, input });
      if (response._tag !== "Success") {
        setError(errorMessage(response.cause));
        return;
      }
      if (response.value.authorizeUrl) setAuthorizeUrl(response.value.authorizeUrl);
      if (input.kind === "channels") {
        setAvailable((old) =>
          input.cursor ? [...old, ...response.value.channels] : response.value.channels,
        );
        setChannelCursor(response.value.nextCursor);
      }
      if (input.kind === "disconnect") {
        setWorkspaceId("");
        setAvailable([]);
        setAuthorizeUrl(null);
      }
      result.refresh();
    } finally {
      setPending(false);
    }
  }
  async function send(input: SlackMutation, ask = false) {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const response = await mutate({ environmentId, input });
      if (response._tag !== "Success") {
        setError(errorMessage(response.cause));
        return;
      }
      if (input.kind === "sync")
        setPages((old) => ({
          ...old,
          [`${input.workspaceId}/${input.channelId}`]: response.value.hasMore
            ? (input.page ?? 1) + 1
            : 0,
        }));
      if (input.kind === "attach") setAttachment(null);
      if (input.kind === "thread" || input.kind === "select") {
        const loaded = await read({ environmentId, input });
        if (loaded._tag === "Success") setDetail(loaded.value);
        else setError(errorMessage(loaded.cause));
      }
      if (ask && response.value.workItemId) setPlanningId(response.value.workItemId);
      result.refresh();
      tasks.refresh();
    } finally {
      setPending(false);
    }
  }
  function edit(channel: SlackChannelConfig) {
    setWorkspaceId(channel.workspaceId);
    setChannelId(channel.channelId);
    setProjectId(channel.projectId ?? "");
    setRepository(channel.repository ?? "");
    setChannelMentions(channel.channelMentions);
  }
  function selectMessage() {
    try {
      const url = new URL(messageUrl);
      const match = /^\/archives\/([A-Z][A-Z0-9]+)\/p(\d{10,16})(\d{6})$/.exec(url.pathname);
      if (url.protocol !== "https:" || !url.hostname.endsWith(".slack.com") || !match || !workspace)
        throw new Error();
      void send({
        kind: "select",
        workspaceId: workspace.id,
        channelId: match[1]!,
        ts: `${match[2]}.${match[3]}`,
      });
    } catch {
      setError(
        "Choose the matching workspace and paste a Slack message link from a configured channel.",
      );
    }
  }
  function importMessage(message: SlackMessage, ask: boolean) {
    const config = data?.channels.find(
      (c) => c.workspaceId === message.workspaceId && c.channelId === message.channelId,
    );
    void send(
      {
        kind: "import",
        ...message,
        projectId: projectId ? ProjectId.make(projectId) : (config?.projectId ?? null),
        repository: repository.trim() || config?.repository || null,
        priority,
      },
      ask,
    );
  }
  return (
    <ScrollView className="flex-1" contentContainerClassName="gap-4 p-4 pb-10">
      <Text className="text-xl font-semibold text-foreground">Slack Inbox</Text>
      <Text className="text-sm text-muted-foreground">
        Everyone who can read this environment can read its Slack inbox. Sync finds mentions in
        configured channels from the last seven days. Older messages can be added by link.
      </Text>
      {!data?.configured && (
        <Text className="text-sm text-muted-foreground">
          The environment owner must configure a Slack app and HTTPS callback first. See the Work
          guide.
        </Text>
      )}
      <View className="flex-row flex-wrap gap-2">
        <ControlPill
          label="Connect workspace"
          disabled={pending || !data?.configured}
          onPress={() => void configure({ kind: "connect" })}
        />
        <ControlPill label="Refresh connections" onPress={() => result.refresh()} />
      </View>
      {authorizeUrl && (
        <ControlPill label="Continue to Slack" onPress={() => void Linking.openURL(authorizeUrl)} />
      )}
      {(error || result.error) && (
        <Text accessibilityRole="alert" className="text-sm text-destructive">
          {error ?? result.error}
        </Text>
      )}
      {workspace && (
        <>
          <Choice
            title="Workspace"
            value={workspace.id}
            options={data?.workspaces.map((w) => ({ id: w.id, title: w.name })) ?? []}
            onChange={(id) => {
              setWorkspaceId(id);
              setAvailable([]);
              setChannelId("");
              setOffset(0);
              setPages({});
            }}
          />
          <ControlPill
            label="Disconnect and clear inbox"
            disabled={pending}
            onPress={() => void configure({ kind: "disconnect", workspaceId: workspace.id })}
          />
          <View className="gap-3 rounded-xl border border-border p-3">
            <Text className="font-medium text-foreground">Channel and task defaults</Text>
            <ControlPill
              label="Choose channels"
              disabled={pending}
              onPress={() => void configure({ kind: "channels", workspaceId: workspace.id })}
            />
            {!!channelCursor && (
              <ControlPill
                label="More channels"
                disabled={pending}
                onPress={() =>
                  void configure({
                    kind: "channels",
                    workspaceId: workspace.id,
                    cursor: channelCursor,
                  })
                }
              />
            )}
            <Choice
              title="Channel"
              value={channelId}
              options={[
                ...(channelId && !available.some((c) => c.id === channelId)
                  ? [
                      {
                        id: channelId,
                        title:
                          data?.channels.find((c) => c.channelId === channelId)?.name ?? channelId,
                      },
                    ]
                  : []),
                ...available.map((c) => ({ id: c.id, title: `#${c.name}` })),
              ]}
              onChange={setChannelId}
            />
            <Choice
              title="Project for new tasks"
              value={projectId}
              options={[
                { id: "", title: "Channel default / no project" },
                ...projects.map((p) => ({ id: p.id, title: p.title })),
              ]}
              onChange={setProjectId}
            />
            <TextInput
              accessibilityLabel="Repository for new tasks"
              className={inputClass}
              placeholder="owner/repository (or channel default)"
              value={repository}
              onChangeText={setRepository}
            />
            <Choice
              title="Priority"
              value={priority}
              options={["low", "medium", "high", "urgent"].map((id) => ({ id, title: id }))}
              onChange={(id) => setPriority(id as WorkItemPriority)}
            />
            <View className="flex-row items-center gap-2">
              <Switch
                accessibilityLabel="Include channel mentions"
                value={channelMentions}
                onValueChange={setChannelMentions}
              />
              <Text className="flex-1 text-sm text-foreground">
                Include @channel, @here and @everyone
              </Text>
            </View>
            <ControlPill
              label="Save channel"
              disabled={pending || !channelId}
              onPress={() =>
                void configure({
                  kind: "configure",
                  workspaceId: workspace.id,
                  channelId,
                  name: channelId,
                  projectId: projectId ? ProjectId.make(projectId) : null,
                  repository: repository.trim() || null,
                  channelMentions,
                })
              }
            />
          </View>
          {data?.channels
            .filter((c) => c.workspaceId === workspace.id)
            .map((c) => (
              <View key={c.channelId} className="gap-2 rounded-xl border border-border p-3">
                <Text className="text-sm text-foreground">
                  #{c.name} · {projects.find((p) => p.id === c.projectId)?.title ?? "No project"}
                  {c.repository ? ` · ${c.repository}` : ""}
                </Text>
                <View className="flex-row flex-wrap gap-2">
                  <ControlPill
                    label="Sync mentions"
                    disabled={pending}
                    onPress={() =>
                      void send({
                        kind: "sync",
                        workspaceId: c.workspaceId,
                        channelId: c.channelId,
                      })
                    }
                  />
                  {!!pages[`${c.workspaceId}/${c.channelId}`] && (
                    <ControlPill
                      label="Older results"
                      disabled={pending}
                      onPress={() =>
                        void send({
                          kind: "sync",
                          workspaceId: c.workspaceId,
                          channelId: c.channelId,
                          page: pages[`${c.workspaceId}/${c.channelId}`] ?? 1,
                        })
                      }
                    />
                  )}
                  <ControlPill label="Edit" onPress={() => edit(c)} />
                  <ControlPill
                    label="Stop tracking"
                    disabled={pending}
                    onPress={() =>
                      void configure({
                        kind: "untrack",
                        workspaceId: c.workspaceId,
                        channelId: c.channelId,
                      })
                    }
                  />
                </View>
              </View>
            ))}
          <TextInput
            accessibilityLabel="Slack message link"
            autoCapitalize="none"
            className={inputClass}
            value={messageUrl}
            onChangeText={setMessageUrl}
            placeholder="Paste a Slack message link"
          />
          <ControlPill
            label="Add message"
            disabled={pending || !messageUrl}
            onPress={selectMessage}
          />
        </>
      )}
      <View className="flex-row items-center gap-2">
        <Switch
          accessibilityLabel="Show ignored messages"
          value={ignored}
          onValueChange={(value) => {
            setIgnored(value);
            setOffset(0);
          }}
        />
        <Text className="text-sm text-foreground">Show ignored messages</Text>
      </View>
      {!data?.items.length && (
        <Text className="text-sm text-muted-foreground">
          No messages in this view. Configure a channel and sync mentions, or add a message.
        </Text>
      )}
      {data?.channels
        .filter((c) => !workspaceId || c.workspaceId === workspaceId)
        .map((c) => (
          <View key={`sync:${c.workspaceId}:${c.channelId}`}>
            <Text className="text-xs text-muted-foreground">#{c.name}</Text>
            <ExternalSyncStatus value={c} />
          </View>
        ))}
      {data?.items.map((item) => {
        const m =
          detail &&
          detail.lastSyncedAt === item.lastSyncedAt &&
          detail.workspaceId === item.workspaceId &&
          detail.channelId === item.channelId &&
          detail.ts === item.ts
            ? { ...item, text: detail.text, replies: detail.replies, nextCursor: detail.nextCursor }
            : item;
        const c = data.channels.find(
          (c) => c.workspaceId === m.workspaceId && c.channelId === m.channelId,
        );
        return (
          <View
            key={`${m.workspaceId}/${m.channelId}/${m.ts}`}
            className="gap-3 rounded-xl border border-border p-3"
          >
            <Text className="text-xs text-muted-foreground">
              {m.author} · #{c?.name ?? m.channelId} ·{" "}
              {new Date(Number(m.ts) * 1000).toLocaleString()} ·{" "}
              {projects.find((p) => p.id === c?.projectId)?.title ?? "No project"}
            </Text>
            <ExternalSyncStatus value={m} />
            <Text selectable className="text-sm text-foreground">
              {m.text}
            </Text>
            {m.url && (
              <ControlPill label="Open in Slack" onPress={() => void Linking.openURL(m.url!)} />
            )}
            {!!m.replies.length && (
              <Text className="text-sm font-medium text-foreground">
                Thread context ({m.replies.length})
              </Text>
            )}
            {m.replies.map((r) => (
              <Text key={r.ts} selectable className="text-sm text-muted-foreground">
                {r.author}: {r.text}
              </Text>
            ))}
            <View className="flex-row flex-wrap gap-2">
              <ControlPill
                label="Refresh thread"
                disabled={pending}
                onPress={() => void send({ kind: "thread", ...m })}
              />
              {!!m.nextCursor && (
                <ControlPill
                  label="More replies"
                  disabled={pending}
                  onPress={() => void send({ kind: "thread", ...m, more: true })}
                />
              )}
              <ControlPill
                label={m.ignored ? "Restore" : "Ignore"}
                disabled={pending}
                onPress={() => void send({ kind: "ignore", ...m, ignored: !m.ignored })}
              />
              {m.workItemId ? (
                <ControlPill label="Open task" onPress={() => setPlanningId(m.workItemId)} />
              ) : (
                <>
                  <ControlPill
                    label="Create Task"
                    disabled={pending}
                    onPress={() => importMessage(m, false)}
                  />
                  <ControlPill
                    label="Ask Agent"
                    disabled={pending || !planningSupported}
                    onPress={() => importMessage(m, true)}
                  />
                  <ControlPill
                    label="Attach to existing task"
                    disabled={pending}
                    onPress={() => {
                      setAttachment(m);
                      setTaskId("");
                    }}
                  />
                </>
              )}
            </View>
          </View>
        );
      })}
      {attachment && (
        <View className="gap-2 rounded-xl border border-border p-3">
          <TextInput
            accessibilityLabel="Search existing tasks"
            className={inputClass}
            value={taskSearch}
            onChangeText={setTaskSearch}
            placeholder="Search existing tasks"
          />
          <Choice
            title="Existing task"
            value={taskId}
            options={tasks.data?.items.map((t) => ({ id: t.id, title: t.title })) ?? []}
            onChange={setTaskId}
          />
          <ControlPill
            label="Attach"
            disabled={pending || !taskId}
            onPress={() => {
              const task = tasks.data?.items.find((t) => t.id === taskId);
              if (task)
                void send({
                  kind: "attach",
                  ...attachment,
                  workItemId: task.id,
                  expectedRevision: task.revision,
                });
            }}
          />
          <ControlPill label="Cancel" onPress={() => setAttachment(null)} />
        </View>
      )}
      <View className="flex-row flex-wrap items-center gap-2">
        <ControlPill
          label="Previous"
          disabled={!offset}
          onPress={() => setOffset(Math.max(0, offset - 25))}
        />
        <Text className="text-sm text-muted-foreground">{data?.total ?? 0} messages</Text>
        <ControlPill
          label="Next"
          disabled={offset + 25 >= (data?.total ?? 0)}
          onPress={() => setOffset(offset + 25)}
        />
      </View>
      <Text className="text-xs text-muted-foreground">
        Ask Agent opens a task for planning. Review and approve before execution. Slack messages are
        never sent automatically.
      </Text>
      {planningId && (
        <WorkPlanPanel
          environmentId={environmentId}
          id={planningId}
          onClose={() => setPlanningId(null)}
          executionSupported={executionSupported}
          pullRequestsSupported={pullRequestsSupported}
          reviewsSupported={reviewsSupported}
        />
      )}
    </ScrollView>
  );
}
