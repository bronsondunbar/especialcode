import { useState } from "react";
import type { EnvironmentId, WorkItemId } from "@t3tools/contracts";
import { WorkPlanPanel } from "./WorkPlanPanel";
import { Pressable, View } from "react-native";
import { AppText as Text } from "../../components/AppText";

export function WorkAgentActions({
  executionSupported,
  environmentId,
  id,
}: {
  executionSupported: boolean;
  environmentId: EnvironmentId;
  id: WorkItemId;
}) {
  const [action, setAction] = useState<"plan" | "execute" | null>(null);
  if (action)
    return (
      <WorkPlanPanel
        inline
        environmentId={environmentId}
        id={id}
        initialAction={action}
        executionSupported={executionSupported}
        onClose={() => setAction(null)}
      />
    );
  return (
    <View className="w-full flex-row gap-1 rounded-lg border border-border bg-card p-1">
      {(["plan", ...(executionSupported ? (["execute"] as const) : [])] as const).map((action) => (
        <Pressable
          key={action}
          accessibilityRole="button"
          className="min-h-11 flex-1 items-center justify-center rounded-md px-5 active:bg-subtle-strong"
          onPress={() => setAction(action)}
        >
          <Text className="text-sm font-medium">{action === "plan" ? "Plan" : "Execute"}</Text>
        </Pressable>
      ))}
    </View>
  );
}
