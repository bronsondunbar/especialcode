import { VercelProjectField } from "./VercelProjectField";
import { useState } from "react";
import { Modal, ScrollView, View, Linking } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import * as Cause from "effect/Cause";
import { createVercelAtoms } from "@t3tools/client-runtime/state/vercel";
import type {
  EnvironmentId,
  ProjectId,
  ThreadId,
  VercelAdminInput,
  VercelLinkInput,
} from "@t3tools/contracts";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironments } from "../../state/environments";
import { ControlPill, ControlPillMenu } from "../../components/ControlPill";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
const atoms = createVercelAtoms(connectionAtomRuntime);
type Target = { environmentId: EnvironmentId; projectId: ProjectId; threadId?: ThreadId };
export function VercelButton(props: Target) {
  const [open, setOpen] = useState(false);
  const { environments } = useEnvironments();
  if (
    !environments.find((environment) => environment.environmentId === props.environmentId)
      ?.serverConfig?.environment.capabilities.vercel
  )
    return null;
  return (
    <>
      <View className="px-4 py-1">
        <ControlPill label="Vercel" onPress={() => setOpen(true)} />
      </View>
      {open && <VercelPanel {...props} onClose={() => setOpen(false)} />}
    </>
  );
}
export function VercelPanel({
  environmentId,
  projectId,
  threadId,
  onClose,
  settings = false,
}: Omit<Target, "projectId"> & { projectId?: ProjectId; onClose: () => void; settings?: boolean }) {
  const [pending, setPending] = useState(false);
  const [deploymentId, setDeploymentId] = useState("");
  const [showLogs, setShowLogs] = useState(false);
  const query = useEnvironmentQuery(
    (settings ? atoms.configuration : atoms.read)({
      environmentId,
      input: {
        ...(projectId ? { projectId } : {}),
        ...(threadId ? { threadId } : {}),
        ...(deploymentId ? { deploymentId } : {}),
        includeLogs: showLogs,
        configurationOnly: settings,
      },
    }),
  );
  const admin = useAtomCommand(atoms.admin, { reportFailure: false });
  const link = useAtomCommand(atoms.link, { reportFailure: false });
  const [editing, setEditing] = useState(false);
  const [token, setToken] = useState("");
  const [teamId, setTeamId] = useState("");
  const [linkProject, setLinkProject] = useState("");
  const [branch, setBranch] = useState("");
  const [editingLink, setEditingLink] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const data = query.data;
  async function save(input: VercelAdminInput | VercelLinkInput) {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const response =
        input.kind === "connect" || input.kind === "disconnect"
          ? await admin({ environmentId, input })
          : await link({ environmentId, input });
      if (response._tag !== "Success") {
        const failure = Cause.squash(response.cause);
        setError(failure instanceof Error ? failure.message : "Could not update Vercel.");
        return;
      }
      setToken("");
      setEditing(false);
      setEditingLink(false);
      setDeploymentId("");
      query.refresh();
    } finally {
      setPending(false);
    }
  }
  const selected = data?.deployments.find(
    (deployment) => deployment.id === data.selectedDeploymentId,
  );
  const inputClass = "rounded-lg border border-border p-3 text-foreground";
  const content = (
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerClassName="gap-4 p-4">
      <Text className="text-xl font-semibold">{settings ? "Vercel" : "Vercel deployments"}</Text>
      {!settings && <ControlPill label="Close" disabled={pending} onPress={onClose} />}
      <Text className="text-sm text-muted-foreground">
        {settings
          ? "Connect Vercel once here. Choose a Vercel project in each thread or when creating one."
          : "Refreshes every 15 seconds while open. Load build logs when needed."}
      </Text>
      {(error || query.error || data?.error) && (
        <Text accessibilityRole="alert" className="text-destructive">
          {error ?? query.error ?? data?.error}
        </Text>
      )}
      {!data && query.isPending && <Text>Loading Vercel…</Text>}
      {settings && data?.connection && (
        <View className="gap-2">
          <Text>
            Vercel connected
            {data.connection.teamId ? ` · ${data.connection.teamId}` : ""}
          </Text>
          <ControlPill
            label="Edit connection"
            disabled={pending}
            onPress={() => {
              setEditing(!editing);
              setTeamId(data.connection?.teamId ?? "");
            }}
          />
        </View>
      )}
      {!settings && data && !data.connection && <Text>Connect Vercel in Work → Vercel.</Text>}
      {settings && data && (!data.connection || editing) && (
        <View className="gap-3 rounded-lg border border-border p-3">
          <Text className="text-sm text-muted-foreground">
            An environment administrator can connect Vercel here. The token stays on the server.
            Logs are shared with people who can read this environment.
          </Text>
          <Text>Vercel access token</Text>
          <TextInput
            accessibilityLabel="Vercel access token"
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            value={token}
            editable={!pending}
            onChangeText={setToken}
            className={inputClass}
          />
          <Text>Team ID (optional)</Text>
          <TextInput
            accessibilityLabel="Team ID"
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="team_…"
            value={teamId}
            editable={!pending}
            onChangeText={setTeamId}
            className={inputClass}
          />
          <ControlPill
            label={pending ? "Connecting…" : "Connect Vercel"}
            disabled={pending || !token.trim()}
            onPress={() =>
              void save({
                kind: "connect",
                token: token.trim(),
                teamId: teamId.trim() || null,
              })
            }
          />
          {data.connection && (
            <ControlPill
              label="Disconnect"
              disabled={pending}
              onPress={() => void save({ kind: "disconnect" })}
            />
          )}
        </View>
      )}
      {projectId && threadId && data?.connection && (
        <View className="gap-3 rounded-lg border border-border p-3">
          <Text>
            {data.link
              ? `Following ${data.link.project.name} · ${data.link.branch ?? "Choose a branch"}`
              : "This thread is unlinked from Vercel."}
          </Text>
          <View className="flex-row flex-wrap gap-2">
            <ControlPill
              label={data.link ? "Change project" : "Choose project"}
              disabled={pending}
              onPress={() => {
                setEditingLink(!editingLink);
                setLinkProject(data.link?.project.id ?? "");
                setBranch(data.link?.branch ?? "");
              }}
            />
            {data.link && (
              <ControlPill
                label="Unlink thread"
                disabled={pending}
                onPress={() => void save({ kind: "unlink", projectId, threadId })}
              />
            )}
          </View>
          {editingLink && (
            <View className="gap-3">
              <VercelProjectField
                environmentId={environmentId}
                projectId={projectId}
                value={linkProject ? { project: linkProject } : undefined}
                onChange={(value) => setLinkProject(value?.project ?? "")}
                disabled={pending}
              />
              <Text>Git branch (blank follows the thread’s current branch)</Text>
              <TextInput
                accessibilityLabel="Git branch"
                autoCapitalize="none"
                autoCorrect={false}
                value={branch}
                editable={!pending}
                onChangeText={setBranch}
                className={inputClass}
              />
              <ControlPill
                label="Save thread link"
                disabled={pending || !linkProject.trim()}
                onPress={() =>
                  void save({
                    kind: "link",
                    projectId,
                    threadId,
                    vercelProject: linkProject.trim(),
                    branch: branch.trim() || null,
                  })
                }
              />
            </View>
          )}
        </View>
      )}
      {!settings && data?.connection && data.link && (
        <>
          <Text className="font-semibold">Deployments</Text>
          <ControlPill label="Refresh" onPress={query.refresh} />
          {data.checkedAt && (
            <Text className="text-xs text-muted-foreground">
              Checked {new Date(data.checkedAt).toLocaleTimeString()} · Latest 20 deployments
              {data.link.branch ? ` for ${data.link.branch}` : ""}
            </Text>
          )}
          {!data.error && !data.deployments.length && (
            <Text>
              No deployments yet. Push this branch to your Vercel-connected repository to trigger
              its build.
            </Text>
          )}
          {!!data.deployments.length && (
            <ControlPillMenu
              title="Deployment"
              actions={[
                { id: "latest", title: "Follow latest deployment" },
                ...data.deployments.map((deployment) => ({
                  id: deployment.id,
                  title: `${deployment.state} · ${new Date(deployment.createdAt).toLocaleString()}`,
                })),
              ]}
              onPressAction={({ nativeEvent }) =>
                setDeploymentId(nativeEvent.event === "latest" ? "" : nativeEvent.event)
              }
            >
              <ControlPill label={deploymentId || "Follow latest deployment"} />
            </ControlPillMenu>
          )}
          {selected && (
            <View className="gap-2 rounded-lg border border-border p-3">
              <Text className="font-semibold">
                {selected.state.replaceAll("_", " ")}
                {selected.target ? ` · ${selected.target}` : ""}
              </Text>
              {selected.commit && <Text>Commit {selected.commit.slice(0, 8)}</Text>}
              {selected.url && (
                <Text
                  accessibilityRole="link"
                  className="underline"
                  onPress={() => {
                    if (selected.url) void Linking.openURL(selected.url);
                  }}
                >
                  Open deployment · {selected.url}
                </Text>
              )}
              <ControlPill
                label={showLogs ? "Hide build logs" : "Show build logs"}
                onPress={() => setShowLogs(!showLogs)}
              />
            </View>
          )}
          {showLogs && (
            <View className="gap-2">
              {data.logsError && (
                <Text accessibilityRole="alert" className="text-destructive">
                  {data.logsError}
                </Text>
              )}
              {data.logsTruncated && (
                <Text className="text-xs text-muted-foreground">
                  Showing the latest 200 events, up to 64,000 characters.
                </Text>
              )}
              <ScrollView className="max-h-96 rounded-lg bg-muted p-3" nestedScrollEnabled>
                <Text selectable className="font-mono text-xs">
                  {data.logs || "No build logs available yet."}
                </Text>
              </ScrollView>
            </View>
          )}
        </>
      )}
    </ScrollView>
  );
  return settings ? (
    content
  ) : (
    <Modal
      visible
      animationType="slide"
      onRequestClose={() => {
        if (!pending) onClose();
      }}
    >
      <SafeAreaView className="flex-1 bg-background">{content}</SafeAreaView>
    </Modal>
  );
}
