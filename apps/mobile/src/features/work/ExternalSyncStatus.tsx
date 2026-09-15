import { View } from "react-native";
import { AppText as Text } from "../../components/AppText";
export function ExternalSyncStatus({
  value,
}: {
  value: { syncStatus?: string; syncError?: string | null; lastSyncedAt?: string | null };
}) {
  if (!value.syncStatus && !value.syncError) return null;
  return (
    <View className="gap-1">
      <Text className="text-xs text-muted-foreground">
        {value.syncStatus === "ready"
          ? "Synced"
          : value.syncStatus === "partial"
            ? "Partially synced"
            : "Cached copy"}
        {value.lastSyncedAt
          ? ` · Last success ${new Date(value.lastSyncedAt).toLocaleString()}`
          : " · No successful refresh recorded"}
      </Text>
      {value.syncError && <Text className="text-sm text-destructive">{value.syncError}</Text>}
    </View>
  );
}
