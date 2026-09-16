import { useState } from "react";
import { Linking, RefreshControl, ScrollView, View } from "react-native";
import * as Cause from "effect/Cause";
import type { EnvironmentId, GitHubAccountInput } from "@t3tools/contracts";
import { createGitHubIssueAtoms } from "@t3tools/client-runtime/state/work-items";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { ControlPill } from "../../components/ControlPill";
import { ExternalSyncStatus } from "./ExternalSyncStatus";
const atoms = createGitHubIssueAtoms(connectionAtomRuntime);
const errorMessage = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  return error instanceof Error ? error.message : "The request failed. Please retry.";
};
const inputClass = "rounded-lg border border-border px-3 py-2 text-foreground";
export function GitHubIssuesPanel(props: { environmentId: EnvironmentId }) {
  return <GitHubIssuesPanelContent key={props.environmentId} {...props} />;
}
function GitHubIssuesPanelContent({ environmentId }: { environmentId: EnvironmentId }) {
  const { environments } = useEnvironments();
  const accountSupported =
    environments.find((e) => e.environmentId === environmentId)?.serverConfig?.environment
      .capabilities.githubAccount === true;
  const [token, setToken] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const result = useEnvironmentQuery(atoms.list({ environmentId, input: { limit: 1 } }));
  const accountCommand = useAtomCommand(atoms.account, { reportFailure: false });
  async function manageAccount(input: GitHubAccountInput) {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const response = await accountCommand({ environmentId, input });
      setToken("");
      result.refresh();
      if (response._tag !== "Success") setError(errorMessage(response.cause));
    } finally {
      setPending(false);
    }
  }
  async function open(url: string) {
    try {
      await Linking.openURL(url);
    } catch {
      setError("Could not open this GitHub link.");
    }
  }
  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerClassName="gap-4 p-4 pb-12"
      refreshControl={<RefreshControl refreshing={result.isPending} onRefresh={result.refresh} />}
    >
      <Text className="text-xl font-semibold">GitHub</Text>
      <Text className="text-sm text-muted-foreground">
        Connect your account for assigned issues, the PRs tab, and creating PRs from threads.
      </Text>
      {!accountSupported && <Text>Update this environment to connect a GitHub account.</Text>}
      {result.isPending && !result.data && <Text>Loading GitHub connection…</Text>}
      {accountSupported && (
        <View className="gap-3 rounded-xl border border-border p-3">
          <Text className="font-semibold">GitHub account</Text>
          <Text className="text-sm text-muted-foreground">
            Open issues assigned to you across accessible repositories and organizations become
            tasks in your Work queue’s Inbox. Sync runs every five minutes while this environment is
            running. No agents start automatically.
          </Text>
          {result.data?.account && (
            <>
              <Text>Connected as @{result.data.account.login}</Text>
              <ExternalSyncStatus value={result.data.account} />
              <ControlPill
                disabled={pending}
                label="Sync assigned issues"
                onPress={() => void manageAccount({ kind: "sync" })}
              />
              <ControlPill
                disabled={pending}
                label="Disconnect account"
                onPress={() => void manageAccount({ kind: "disconnect" })}
              />
              <Text className="text-xs text-muted-foreground">
                Disconnecting removes the saved token and keeps existing Work tasks.
              </Text>
            </>
          )}
          <TextInput
            accessibilityLabel="GitHub personal access token"
            className={inputClass}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            value={token}
            onChangeText={setToken}
            placeholder="GitHub personal access token"
          />
          <ControlPill
            disabled={pending || !token.trim()}
            label={result.data?.account ? "Update token" : "Connect GitHub account"}
            onPress={() => void manageAccount({ kind: "connect", token: token.trim() })}
          />
          <Text className="text-sm text-muted-foreground">
            For private repositories across organizations, use a classic token with repo scope, then
            authorize required organization SSO. Add read:org for team reviewer information; PR
            details work without it. Organization policies may restrict access. The token stays on
            this environment; tasks are visible to clients connected to it.
          </Text>
          <ControlPill
            label="Create a GitHub token"
            onPress={() =>
              void open(
                "https://github.com/settings/tokens/new?description=EspecialCode%20GitHub&scopes=repo,read:org",
              )
            }
          />
        </View>
      )}
      {pending && (
        <Text accessibilityRole="text" className="text-muted-foreground">
          Updating GitHub…
        </Text>
      )}
      {(error || result.error) && (
        <Text accessibilityRole="alert" className="text-destructive">
          {error ?? result.error}
        </Text>
      )}
    </ScrollView>
  );
}
