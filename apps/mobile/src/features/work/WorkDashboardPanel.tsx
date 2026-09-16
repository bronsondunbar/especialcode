import { ClearWorkQueueButton } from "./ClearWorkQueueButton";
import { WorkTaskThreadButton } from "./WorkTaskThreadButton";
import { useDeferredValue, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import { Modal, ScrollView, View, Pressable, RefreshControl } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { createWorkDashboardAtoms } from "@t3tools/client-runtime/state/work-items";
import {
  WORK_DASHBOARD_SECTIONS,
  ProjectId,
  ProviderInstanceId,
  type WorkDashboardInput,
  type WorkItemId,
  type WorkItemSource,
  type WorkItemStatus,
  type WorkItemPriority,
} from "@t3tools/contracts";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useEnvironmentQuery } from "../../state/query";
import { environmentProjects } from "../../state/projects";
import type { EnvironmentPresentation } from "../../state/environments";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { ControlPill, ControlPillMenu } from "../../components/ControlPill";
import { WorkPlanPanel } from "./WorkPlanPanel";
import { WorkActivityPanel } from "./WorkActivityPanel";
const atoms = createWorkDashboardAtoms(connectionAtomRuntime);
const label = (s: string) => s.replaceAll("_", " ");
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
      actions={options.map((o) => ({
        ...o,
        state: o.id === value ? ("on" as const) : ("off" as const),
      }))}
      onPressAction={({ nativeEvent }) => onChange(nativeEvent.event)}
    >
      <ControlPill
        variant="pill"
        label={`${title}: ${options.find((o) => o.id === value)?.title ?? value}`}
        accessibilityLabel={title}
      />
    </ControlPillMenu>
  );
}
export function WorkDashboardPanel({ environment }: { environment: EnvironmentPresentation }) {
  const environmentId = environment.environmentId;
  const capabilities = environment.serverConfig?.environment.capabilities;
  const providers = environment.serverConfig?.providers ?? [];
  const projects = useAtomValue(environmentProjects.projectsAtom).filter(
    (p) => p.environmentId === environmentId,
  );
  const navigation = useNavigation();
  const [filters, setFilters] = useState<WorkDashboardInput>({});
  const [task, setTask] = useState<WorkItemId | null>(null);
  const [activity, setActivity] = useState<WorkItemId | null>(null);
  const input = useDeferredValue(filters);
  const query = useEnvironmentQuery(atoms.list({ environmentId, input }));
  return (
    <>
      {task && (
        <WorkPlanPanel
          key={task}
          environmentId={environmentId}
          id={task}
          onClose={() => setTask(null)}
          executionSupported={capabilities?.workExecutions === true}
          pullRequestsSupported={capabilities?.workPullRequests === true}
          reviewsSupported={capabilities?.workReviews === true}
        />
      )}
      {activity && (
        <Modal visible animationType="slide" onRequestClose={() => setActivity(null)}>
          <SafeAreaView className="flex-1 bg-background">
            <ScrollView contentContainerClassName="gap-4 p-4">
              <ControlPill
                variant="pill"
                label="Close activity"
                onPress={() => setActivity(null)}
              />
              <WorkActivityPanel
                environmentId={environmentId}
                id={activity}
                onNavigate={() => setActivity(null)}
              />
            </ScrollView>
          </SafeAreaView>
        </Modal>
      )}
      <ScrollView
        contentContainerClassName="gap-4 p-4 pb-10"
        refreshControl={<RefreshControl refreshing={false} onRefresh={query.refresh} />}
      >
        <Text className="text-2xl font-semibold text-foreground">Developer dashboard</Text>
        <ClearWorkQueueButton
          key={environmentId}
          environmentId={environmentId}
          onCleared={query.refresh}
        />
        <Text className="text-sm text-muted-foreground">
          Attention, execution, and review across your projects.
        </Text>
        <View className="flex-row flex-wrap gap-2">
          <Choice
            title="Project"
            value={filters.projectId ?? ""}
            options={[
              { id: "", title: "All projects" },
              ...projects.map((p) => ({ id: p.id, title: p.title })),
            ]}
            onChange={(value) => {
              const { projectId: _, ...rest } = filters;
              setFilters(
                value
                  ? { ...rest, projectId: ProjectId.make(value), offset: 0 }
                  : { ...rest, offset: 0 },
              );
            }}
          />
          <Choice
            title="Agent"
            value={filters.agent ?? ""}
            options={[
              { id: "", title: "All agents" },
              ...providers.map((p) => ({ id: p.instanceId, title: p.displayName ?? p.driver })),
            ]}
            onChange={(value) => {
              const { agent: _, ...rest } = filters;
              setFilters(
                value
                  ? { ...rest, agent: ProviderInstanceId.make(value), offset: 0 }
                  : { ...rest, offset: 0 },
              );
            }}
          />
          <Choice
            title="Source"
            value={filters.source ?? ""}
            options={[
              { id: "", title: "All sources" },
              ...["manual", "github_issue", "github_pr", "slack", "automation"].map((s) => ({
                id: s,
                title: label(s),
              })),
            ]}
            onChange={(value) => {
              const { source: _, ...rest } = filters;
              setFilters(
                value
                  ? { ...rest, source: value as WorkItemSource, offset: 0 }
                  : { ...rest, offset: 0 },
              );
            }}
          />
          <Choice
            title="Status"
            value={filters.status ?? ""}
            options={[
              { id: "", title: "All statuses" },
              ...[
                "inbox",
                "backlog",
                "ready",
                "planning",
                "awaiting_approval",
                "running",
                "blocked",
                "review",
                "done",
                "cancelled",
              ].map((s) => ({ id: s, title: label(s) })),
            ]}
            onChange={(value) => {
              const { status: _, ...rest } = filters;
              setFilters(
                value
                  ? { ...rest, status: value as WorkItemStatus, offset: 0 }
                  : { ...rest, offset: 0 },
              );
            }}
          />
          <Choice
            title="Priority"
            value={filters.priority ?? ""}
            options={[
              { id: "", title: "All priorities" },
              ...["urgent", "high", "medium", "low"].map((s) => ({ id: s, title: label(s) })),
            ]}
            onChange={(value) => {
              const { priority: _, ...rest } = filters;
              setFilters(
                value
                  ? { ...rest, priority: value as WorkItemPriority, offset: 0 }
                  : { ...rest, offset: 0 },
              );
            }}
          />
        </View>
        <TextInput
          accessibilityLabel="Filter by repository"
          className="rounded-lg border border-border p-3 text-foreground"
          autoCapitalize="none"
          placeholder="Repository: owner/repository"
          value={filters.repository ?? ""}
          onChangeText={(value) => {
            const { repository: _, ...rest } = filters;
            setFilters(value ? { ...rest, repository: value, offset: 0 } : { ...rest, offset: 0 });
          }}
        />
        <View className="flex-row flex-wrap gap-2">
          <Choice
            title="Section"
            value={filters.section ?? ""}
            options={[{ id: "", title: "Overview" }, ...WORK_DASHBOARD_SECTIONS]}
            onChange={(value) => {
              const { section: _, ...rest } = filters;
              const selected = WORK_DASHBOARD_SECTIONS.find((s) => s.id === value);
              setFilters(
                selected ? { ...rest, section: selected.id, offset: 0 } : { ...rest, offset: 0 },
              );
            }}
          />
          <ControlPill variant="pill" label="Clear filters" onPress={() => setFilters({})} />
          <ControlPill variant="pill" label="Refresh" onPress={query.refresh} />
        </View>
        {query.error && (
          <Text accessibilityRole="alert" className="text-destructive">
            {query.error}
          </Text>
        )}
        {!query.data && !query.error && (
          <Text className="text-muted-foreground">Loading dashboard…</Text>
        )}
        {query.data?.sections.map((section) => (
          <View key={section.id} className="gap-3 rounded-xl border border-border p-4">
            <Text className="text-lg font-semibold text-foreground">
              {WORK_DASHBOARD_SECTIONS.find((s) => s.id === section.id)?.title} · {section.total}
            </Text>
            {section.items.length === 0 && (
              <Text className="text-muted-foreground">No matching tasks.</Text>
            )}
            {section.items.map((item) => (
              <View key={item.id} className="gap-2 border-t border-border pt-3">
                <Pressable accessibilityRole="button" onPress={() => setTask(item.id)}>
                  <Text className="font-semibold text-foreground">{item.title}</Text>
                </Pressable>
                <WorkTaskThreadButton environmentId={environmentId} id={item.id} />
                <Text className="text-xs text-muted-foreground">
                  {item.project ?? "Unassigned project"} · {label(item.priority)} ·{" "}
                  {label(item.status)}
                </Text>
                <Text className="text-xs text-muted-foreground">
                  {item.repository ?? label(item.source)}
                  {item.agent &&
                    ` · ${item.agentName ?? providers.find((p) => p.instanceId === item.agent)?.displayName ?? item.agent}`}
                </Text>
                {item.activity && <Text className="text-sm text-foreground">{item.activity}</Text>}
                {item.reasons.length > 0 && (
                  <Text className="text-sm text-foreground">{item.reasons.join(" · ")}</Text>
                )}
                <View className="flex-row flex-wrap gap-2">
                  <ControlPill
                    variant="pill"
                    label="Plan / execution"
                    onPress={() => setTask(item.id)}
                  />
                  <ControlPill
                    variant="pill"
                    label="Activity"
                    onPress={() => setActivity(item.id)}
                  />
                  {item.threadId && (
                    <ControlPill
                      variant="pill"
                      label="Open agent"
                      onPress={() => {
                        if (item.threadId)
                          navigation.navigate("Thread", { environmentId, threadId: item.threadId });
                      }}
                    />
                  )}
                </View>
              </View>
            ))}
            {filters.section ? (
              <View className="flex-row items-center justify-between gap-2">
                <ControlPill
                  variant="pill"
                  label="Previous"
                  disabled={!(filters.offset ?? 0)}
                  onPress={() =>
                    setFilters({ ...filters, offset: Math.max(0, (filters.offset ?? 0) - 8) })
                  }
                />
                <Text className="text-xs text-muted-foreground">
                  {section.items.length
                    ? `${(filters.offset ?? 0) + 1}–${(filters.offset ?? 0) + section.items.length} / ${section.total}`
                    : `${section.total} matching tasks`}
                </Text>
                <ControlPill
                  variant="pill"
                  label="Next"
                  disabled={(filters.offset ?? 0) + section.items.length >= section.total}
                  onPress={() => setFilters({ ...filters, offset: (filters.offset ?? 0) + 8 })}
                />
              </View>
            ) : (
              section.total > section.items.length && (
                <ControlPill
                  variant="pill"
                  label={`View all ${section.total}`}
                  onPress={() => setFilters({ ...filters, section: section.id, offset: 0 })}
                />
              )
            )}
          </View>
        ))}
        <View className="gap-3 rounded-xl border border-border p-4">
          <Text className="text-lg font-semibold text-foreground">Recent Activity</Text>
          <Text className="text-xs text-muted-foreground">
            Latest 12 events for the current filters. PR information reflects the latest sync.
          </Text>
          {query.data?.activity.length === 0 && (
            <Text className="text-muted-foreground">No matching activity.</Text>
          )}
          {query.data?.activity.map((event) => (
            <Pressable
              key={event.id}
              accessibilityRole="button"
              onPress={() => setActivity(event.workItemId)}
              className="gap-1 border-t border-border pt-3"
            >
              <Text className="text-sm text-foreground">
                {event.workItemTitle} · {event.title}
              </Text>
              <Text className="text-xs text-muted-foreground">
                {new Date(event.occurredAt).toLocaleString()}
              </Text>
            </Pressable>
          ))}
        </View>
      </ScrollView>
    </>
  );
}
