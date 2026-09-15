import { useState } from "react";
import { View, Switch } from "react-native";
import * as Cause from "effect/Cause";
import { createNotificationAtoms } from "@t3tools/client-runtime/state/work-items";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  NOTIFICATION_PREFERENCE_GROUPS,
  type EnvironmentId,
  type NotificationPreferences,
} from "@t3tools/contracts";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { AppText as Text } from "../../components/AppText";
import { ControlPill } from "../../components/ControlPill";
const notifications = createNotificationAtoms(connectionAtomRuntime);
export function NotificationPreferencesPanel({ environmentId }: { environmentId: EnvironmentId }) {
  const [expanded, setExpanded] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const query = useEnvironmentQuery(notifications.list({ environmentId, input: { limit: 1 } }));
  const command = useAtomCommand(notifications.mutate, { reportFailure: false });
  const state = query.data?.preferences;
  async function save(value: NotificationPreferences) {
    if (!state || pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await command({
        environmentId,
        input: { kind: "preferences", expectedRevision: state.revision, value },
      });
      if (result._tag !== "Success") setError(String(Cause.squash(result.cause)));
    } finally {
      setPending(false);
    }
  }
  return (
    <View className="gap-3 rounded-xl border border-border p-4">
      <ControlPill
        label={expanded ? "Hide notification preferences" : "Notification preferences"}
        onPress={() => setExpanded(!expanded)}
      />
      {expanded && (
        <>
          <Text className="text-sm text-muted-foreground">
            Applies to future events across this environment. Existing inbox history stays
            available. Desktop delivery controls connected web and desktop clients. Mobile push
            settings are unchanged. Slack options apply once Slack integration is connected.
          </Text>
          {(error || query.error) && (
            <Text accessibilityRole="alert" className="text-destructive">
              {error ?? query.error}
            </Text>
          )}
          {state && (
            <>
              {NOTIFICATION_PREFERENCE_GROUPS.map((group) => (
                <View key={group.title} className="gap-2">
                  <Text className="font-semibold text-foreground">{group.title}</Text>
                  {group.entries.map((entry) => (
                    <View key={entry.key} className="flex-row items-center justify-between gap-2">
                      <Text className="flex-1 text-foreground">{entry.label}</Text>
                      <Switch
                        accessibilityLabel={entry.label}
                        value={state.value.events[entry.key]}
                        disabled={pending}
                        onValueChange={(value) =>
                          void save({
                            ...state.value,
                            events: { ...state.value.events, [entry.key]: value },
                          })
                        }
                      />
                    </View>
                  ))}
                </View>
              ))}
              <Text className="font-semibold text-foreground">Delivery</Text>
              {(
                [
                  ["inApp", "In-app"],
                  ["desktop", "Desktop"],
                ] as const
              ).map(([key, label]) => (
                <View key={key} className="flex-row items-center justify-between">
                  <Text className="text-foreground">{label}</Text>
                  <Switch
                    accessibilityLabel={label}
                    value={state.value.delivery[key]}
                    disabled={pending}
                    onValueChange={(value) =>
                      void save({
                        ...state.value,
                        delivery: { ...state.value.delivery, [key]: value },
                      })
                    }
                  />
                </View>
              ))}
              <ControlPill
                label="Restore defaults"
                disabled={pending}
                onPress={() => void save(DEFAULT_NOTIFICATION_PREFERENCES)}
              />
            </>
          )}
        </>
      )}
    </View>
  );
}
