import { NotificationPreferencesPanel } from "./NotificationPreferencesPanel";
import { useState } from "react";
import { useNavigation } from "@react-navigation/native";
import { Platform, ScrollView, View } from "react-native";
import * as Cause from "effect/Cause";
import {
  createNotificationAtoms,
  notificationActionLabel,
} from "@t3tools/client-runtime/state/work-items";
import {
  NOTIFICATION_FILTERS,
  type AppNotification,
  type EnvironmentId,
  type NotificationListInput,
  type NotificationMutation,
  type WorkItemId,
} from "@t3tools/contracts";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useEnvironments, type EnvironmentPresentation } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { AppText as Text } from "../../components/AppText";
import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { ControlPill, ControlPillMenu } from "../../components/ControlPill";
import { WorkPlanPanel } from "../work/WorkPlanPanel";
const notifications = createNotificationAtoms(connectionAtomRuntime);

export function NotificationBells() {
  const { environments } = useEnvironments();
  return (
    <View className="flex-row flex-wrap gap-2">
      {environments
        .filter((env) => env.serverConfig?.environment.capabilities.notifications)
        .map((env) => (
          <NotificationBell
            key={env.environmentId}
            environmentId={env.environmentId}
            label={env.label}
          />
        ))}
    </View>
  );
}
function NotificationBell({
  environmentId,
  label,
}: {
  environmentId: EnvironmentId;
  label: string;
}) {
  const query = useEnvironmentQuery(notifications.list({ environmentId, input: { limit: 1 } }));
  const navigation = useNavigation();
  const count = query.data?.unreadCount;
  return (
    <ControlPill
      icon="bell"
      label={count === undefined ? "…" : String(count)}
      accessibilityLabel={`${label}: Notifications${count !== undefined ? `, ${count} unread` : ", unavailable"}`}
      onPress={() =>
        navigation.navigate("SettingsSheet", {
          screen: "SettingsContent",
          params: { screen: "SettingsNotifications", params: { environmentId } },
        })
      }
    />
  );
}
export function NotificationsRouteScreen({
  route,
}: {
  route: { params?: { environmentId?: EnvironmentId } };
}) {
  const navigation = useNavigation();
  const { environments } = useEnvironments();
  const selected = route.params?.environmentId;
  const supported = environments.filter(
    (env) => env.serverConfig?.environment.capabilities.notifications,
  );
  const environment = supported.find((env) => env.environmentId === selected) ?? supported[0];
  return (
    <View className="flex-1 bg-background">
      {Platform.OS === "android" && (
        <AndroidScreenHeader title="Notifications" onBack={() => navigation.goBack()} />
      )}
      {supported.length > 1 && (
        <View className="p-3">
          <ControlPillMenu
            title="Environment"
            actions={supported.map((env) => ({
              id: env.environmentId,
              title: env.label,
              state: env.environmentId === environment?.environmentId ? "on" : "off",
            }))}
            onPressAction={({ nativeEvent }) =>
              navigation.navigate("SettingsSheet", {
                screen: "SettingsContent",
                params: {
                  screen: "SettingsNotifications",
                  params: { environmentId: nativeEvent.event as EnvironmentId },
                },
              })
            }
          >
            <ControlPill label={environment?.label ?? "Select environment"} />
          </ControlPillMenu>
        </View>
      )}
      {environment ? (
        <NotificationCenter key={environment.environmentId} environment={environment} />
      ) : (
        <Text className="p-6 text-muted-foreground">
          Connect to an environment with notification support. Older servers need an update.
        </Text>
      )}
    </View>
  );
}
function NotificationCenter({ environment }: { environment: EnvironmentPresentation }) {
  const environmentId = environment.environmentId;
  const capabilities = environment.serverConfig?.environment.capabilities;
  const navigation = useNavigation();
  const [filter, setFilter] = useState<NonNullable<NotificationListInput["filter"]>>("all");
  const [offset, setOffset] = useState(0);
  const [workItemId, setWorkItemId] = useState<WorkItemId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const query = useEnvironmentQuery(
    notifications.list({ environmentId, input: { filter, offset, limit: 50 } }),
  );
  const mutate = useAtomCommand(notifications.mutate, { reportFailure: false });
  const data = query.data;
  async function change(input: NotificationMutation) {
    setPending(true);
    setError(null);
    try {
      const result = await mutate({ environmentId, input });
      if (result._tag !== "Success") setError(String(Cause.squash(result.cause)));
    } finally {
      setPending(false);
    }
  }
  function open(item: AppNotification) {
    const action = item.action;
    if (!action) return;
    if (action.kind === "work_item") setWorkItemId(action.workItemId);
    else
      navigation.navigate(action.kind === "changes" ? "ThreadReview" : "Thread", {
        environmentId,
        threadId: action.threadId,
      });
  }
  return (
    <ScrollView contentContainerClassName="gap-4 p-4 pb-12">
      {capabilities?.notificationPreferences && (
        <NotificationPreferencesPanel environmentId={environmentId} />
      )}
      <Text className="text-sm text-muted-foreground">
        Notifications and read state are shared across this environment.
      </Text>
      <View className="flex-row flex-wrap gap-2">
        {NOTIFICATION_FILTERS.map((entry) => (
          <ControlPill
            key={entry.id}
            variant={filter === entry.id ? "primary" : "pill"}
            label={entry.label}
            onPress={() => {
              setFilter(entry.id);
              setOffset(0);
            }}
          />
        ))}
      </View>
      <View className="flex-row flex-wrap gap-2">
        <ControlPill
          label={`Mark all read${data ? ` (${data.unreadCount})` : ""}`}
          disabled={pending || !data?.unreadCount}
          onPress={() =>
            data && void change({ kind: "read_all", throughSequence: data.latestSequence })
          }
        />
        <ControlPill label="Refresh" onPress={() => query.refresh()} />
      </View>
      {(error || query.error) && (
        <Text accessibilityRole="alert" className="text-destructive">
          {error ?? query.error}
        </Text>
      )}
      {!data && !query.error && <Text>Loading notifications…</Text>}
      {data && !data.items.length && (
        <Text className="py-8 text-center text-muted-foreground">
          No notifications in this view.
        </Text>
      )}
      {data?.items.map((item) => (
        <View
          key={item.id}
          className={`gap-3 rounded-xl border p-4 ${item.readAt ? "border-border" : "border-primary bg-subtle"}`}
        >
          <Text className="font-semibold text-foreground">
            {item.readAt ? "" : "● "}
            {item.title}
          </Text>
          <Text
            className={item.priority === "urgent" ? "text-destructive" : "text-muted-foreground"}
          >
            {item.priority} · {new Date(item.createdAt).toLocaleString()}
          </Text>
          <Text className="text-foreground">{item.message}</Text>
          {item.action && (
            <ControlPill label={notificationActionLabel(item.type)} onPress={() => open(item)} />
          )}
          <ControlPill
            label={`Mark ${item.readAt ? "unread" : "read"}`}
            disabled={pending}
            onPress={() => void change({ kind: "read", id: item.id, read: !item.readAt })}
          />
        </View>
      ))}
      {data && data.total > 50 && (
        <View className="flex-row items-center justify-between">
          <ControlPill
            label="Previous"
            disabled={!offset}
            onPress={() => setOffset(Math.max(0, offset - 50))}
          />
          <Text>
            {offset + 1}–{Math.min(offset + 50, data.total)} of {data.total}
          </Text>
          <ControlPill
            label="Next"
            disabled={offset + 50 >= data.total}
            onPress={() => setOffset(offset + 50)}
          />
        </View>
      )}
      {workItemId && (
        <WorkPlanPanel
          environmentId={environmentId}
          id={workItemId}
          onClose={() => setWorkItemId(null)}
          reviewsSupported={capabilities?.workReviews}
          executionSupported={capabilities?.workExecutions}
          pullRequestsSupported={capabilities?.workPullRequests}
        />
      )}
    </ScrollView>
  );
}
