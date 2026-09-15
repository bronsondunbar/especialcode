import { useState } from "react";
import { useNavigation } from "@react-navigation/native";
import { Linking, View } from "react-native";
import { createWorkActivityAtoms } from "@t3tools/client-runtime/state/work-items";
import type {
  EnvironmentId,
  WorkItemId,
  WorkActivityInput,
  WorkActivityEvent,
} from "@t3tools/contracts";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironments } from "../../state/environments";
import { AppText as Text } from "../../components/AppText";
import { ControlPill } from "../../components/ControlPill";
const atoms = createWorkActivityAtoms(connectionAtomRuntime);
export function WorkActivityPanel(props: {
  environmentId: EnvironmentId;
  id: WorkItemId;
  onNavigate?: () => void;
}) {
  const { environments } = useEnvironments();
  return environments.find((e) => e.environmentId === props.environmentId)?.serverConfig
    ?.environment.capabilities.workActivity ? (
    <Timeline key={props.id} {...props} />
  ) : null;
}
function Timeline({
  environmentId,
  id,
  onNavigate,
}: {
  environmentId: EnvironmentId;
  id: WorkItemId;
  onNavigate?: () => void;
}) {
  const navigation = useNavigation();
  const [pages, setPages] = useState<ReadonlyArray<WorkActivityInput>>([]);
  const result = useEnvironmentQuery(
    atoms.list({ environmentId, input: pages.at(-1) ?? { id, limit: 25 } }),
  );
  function open(event: WorkActivityEvent) {
    if (!event.threadId) return;
    onNavigate?.();
    navigation.navigate(event.kind === "files_changed" ? "ThreadReview" : "Thread", {
      environmentId,
      threadId: event.threadId,
    });
  }
  return (
    <View className="gap-3 border-t border-border pt-4">
      <Text className="font-semibold text-foreground">Activity</Text>
      <Text className="text-xs text-muted-foreground">
        Newest first · {result.data?.total ?? 0} events
      </Text>
      <ControlPill
        label="Latest activity"
        onPress={() => {
          setPages([]);
          result.refresh();
        }}
      />
      {result.error && (
        <Text accessibilityRole="alert" className="text-sm text-destructive">
          {result.error}
        </Text>
      )}
      {!result.data && !result.error && (
        <Text className="text-sm text-muted-foreground">Loading activity…</Text>
      )}
      {result.data?.items.length === 0 && (
        <Text className="text-sm text-muted-foreground">No recorded activity yet.</Text>
      )}
      {result.data?.items.map((event) => (
        <View key={event.id} className="gap-2 border-l border-border pl-3">
          <Text className="text-sm font-medium text-foreground">{event.title}</Text>
          <Text className="text-xs text-muted-foreground">
            {event.source} · {new Date(event.occurredAt).toLocaleString()}
          </Text>
          {!!event.summary && (
            <Text selectable className="text-sm text-foreground">
              {event.summary}
            </Text>
          )}
          {event.details.map((detail) => (
            <Text key={detail.label} className="text-xs text-muted-foreground">
              {detail.label}: {detail.value}
            </Text>
          ))}
          <View className="flex-row flex-wrap gap-2">
            {event.threadId && (
              <ControlPill
                label={event.kind === "files_changed" ? "Open changes" : "Open agent thread"}
                onPress={() => open(event)}
              />
            )}
            {event.url && (
              <ControlPill label="Open source" onPress={() => void Linking.openURL(event.url!)} />
            )}
          </View>
        </View>
      ))}
      <View className="flex-row gap-2">
        <ControlPill
          label="Newer"
          disabled={!pages.length}
          onPress={() => setPages((previous) => previous.slice(0, -1))}
        />
        <ControlPill
          label="Older"
          disabled={!result.data?.nextCursor}
          onPress={() => {
            const data = result.data;
            if (data?.nextCursor)
              setPages((previous) => [
                ...previous,
                { id, limit: 25, before: data.nextCursor!, throughSequence: data.throughSequence },
              ]);
          }}
        />
      </View>
    </View>
  );
}
