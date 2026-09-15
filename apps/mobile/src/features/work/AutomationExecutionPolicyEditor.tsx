import { View, Switch } from "react-native";
import type { AutomationExecutionPolicy, ServerProvider } from "@t3tools/contracts";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { ControlPill, ControlPillMenu } from "../../components/ControlPill";
const inputClass = "rounded-lg border border-border p-3 text-foreground";
export function AutomationExecutionPolicyEditor({
  value,
  onChange,
  providers,
}: {
  value: AutomationExecutionPolicy;
  onChange: (value: AutomationExecutionPolicy) => void;
  providers: ReadonlyArray<ServerProvider>;
}) {
  return (
    <View className="gap-3 rounded-lg border border-border p-4">
      <Text className="font-semibold text-foreground">Execution safeguards</Text>
      <View className="flex-row items-center gap-2">
        <Text className="flex-1 text-sm text-foreground">
          Trust this rule to execute explicitly approved plans
        </Text>
        <Switch
          accessibilityLabel="Trust execution rule"
          value={value.trusted}
          onValueChange={(trusted) => onChange({ ...value, trusted })}
        />
      </View>
      <Text className="text-sm text-foreground">
        Allowed repositories (one host/owner/repository per line)
      </Text>
      <TextInput
        accessibilityLabel="Allowed repositories"
        multiline
        autoCapitalize="none"
        className={inputClass}
        defaultValue={value.allowedRepositories.map((r) => `${r.host}/${r.repository}`).join("\n")}
        placeholder="github.com/owner/repository"
        onChangeText={(text) =>
          onChange({
            ...value,
            allowedRepositories: text
              .split("\n")
              .map((s) => s.trim())
              .filter(Boolean)
              .map((s) => {
                const [host, ...parts] = s.split("/");
                return { host: host ?? "", repository: parts.join("/") };
              }),
          })
        }
      />
      <Text className="text-sm text-foreground">
        Allowed labels (one per line; at least one must match)
      </Text>
      <TextInput
        accessibilityLabel="Allowed labels"
        multiline
        autoCapitalize="none"
        className={inputClass}
        defaultValue={value.allowedLabels.join("\n")}
        onChangeText={(text) =>
          onChange({
            ...value,
            allowedLabels: text
              .split("\n")
              .map((s) => s.trim())
              .filter(Boolean),
          })
        }
      />
      <Text className="text-sm font-medium text-foreground">Allowed providers</Text>
      {providers.map((p) => (
        <View key={p.instanceId} className="flex-row items-center justify-between gap-2">
          <Text className="flex-1 text-sm text-foreground">{p.displayName ?? p.driver}</Text>
          <Switch
            accessibilityLabel={`Allow ${p.displayName ?? p.driver}`}
            value={value.allowedProviders.includes(p.instanceId)}
            onValueChange={(enabled) =>
              onChange({
                ...value,
                allowedProviders: enabled
                  ? [...value.allowedProviders, p.instanceId]
                  : value.allowedProviders.filter((id) => id !== p.instanceId),
              })
            }
          />
        </View>
      ))}
      <Text className="text-sm text-foreground">
        Maximum simultaneous executions for this rule (1–10)
      </Text>
      <TextInput
        accessibilityLabel="Maximum executions"
        keyboardType="number-pad"
        className={inputClass}
        value={String(value.maxConcurrentRuns)}
        onChangeText={(text) => onChange({ ...value, maxConcurrentRuns: Number(text) })}
      />
      <ControlPillMenu
        title="Permission mode"
        actions={[
          { id: "approval-required", title: "Approval required" },
          { id: "auto-accept-edits", title: "Accept edits; keep other approvals" },
        ]}
        onPressAction={({ nativeEvent }) => {
          const mode = nativeEvent.event;
          if (mode === "approval-required" || mode === "auto-accept-edits")
            onChange({ ...value, permissionMode: mode });
        }}
      >
        <ControlPill
          variant="pill"
          label={
            value.permissionMode === "approval-required"
              ? "Approval required"
              : "Accept edits; keep other approvals"
          }
        />
      </ControlPillMenu>
      <View className="flex-row items-center justify-between">
        <Text className="flex-1 text-sm text-foreground">Require validation commands</Text>
        <Switch
          accessibilityLabel="Require validation"
          value={value.requireTests}
          onValueChange={(requireTests) => onChange({ ...value, requireTests })}
        />
      </View>
      <View className="flex-row items-center justify-between">
        <Text className="flex-1 text-sm text-foreground">
          Create a PR after successful execution
        </Text>
        <Switch
          accessibilityLabel="Require PR"
          value={value.requirePullRequest}
          onValueChange={(requirePullRequest) => onChange({ ...value, requirePullRequest })}
        />
      </View>
      <Text className="text-xs text-muted-foreground">
        The server checks synced labels and the checkout’s origin. T3 Code and provider approvals
        remain in force. PRs are never merged automatically.
      </Text>
    </View>
  );
}
