import { ExternalSyncStatus } from "./ExternalSyncStatus";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAtomValue } from "@effect/atom-react";
import { createGitHubIssueAtoms } from "@t3tools/client-runtime/state/work-items";
import {
  ProjectId,
  type EnvironmentId,
  type GitHubIssueDetail,
  type GitHubIssueReference,
  type GitHubIssuesMutation,
  type GitHubTrackedRepository,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { useDeferredValue, useState } from "react";
import { Modal, Linking, Pressable, RefreshControl, ScrollView, View } from "react-native";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { ControlPill, ControlPillMenu } from "../../components/ControlPill";
import { connectionAtomRuntime } from "../../connection/runtime";
import { environmentProjects } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";

const atoms = createGitHubIssueAtoms(connectionAtomRuntime);
const key = (repo: { host: string; repository: string }) => `${repo.host}/${repo.repository}`;
const errorMessage = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  return error instanceof Error ? error.message : "The request failed. Please retry.";
};
const inputClass = "rounded-lg border border-border px-3 py-2 text-foreground";
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
      actions={options.map((option) => ({
        ...option,
        state: option.id === value ? ("on" as const) : ("off" as const),
      }))}
      onPressAction={({ nativeEvent }) => onChange(nativeEvent.event)}
    >
      <ControlPill
        variant="pill"
        label={`${title}: ${options.find((option) => option.id === value)?.title ?? value}`}
        accessibilityLabel={title}
      />
    </ControlPillMenu>
  );
}
export function GitHubIssuesPanel({ environmentId }: { environmentId: EnvironmentId }) {
  const projects = useAtomValue(environmentProjects.projectsAtom).filter(
    (project) => project.environmentId === environmentId,
  );
  const [repository, setRepository] = useState("");
  const [label, setLabel] = useState("");
  const [assignee, setAssignee] = useState("");
  const [state, setState] = useState<"open" | "closed" | "all">("open");
  const [offset, setOffset] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<GitHubIssueDetail | null>(null);
  const [editing, setEditing] = useState<GitHubTrackedRepository | null>(null);
  const [showConfig, setShowConfig] = useState(false);
  const [host, setHost] = useState("github.com");
  const [repoName, setRepoName] = useState("");
  const [projectId, setProjectId] = useState("");
  const [importLabels, setImportLabels] = useState("");
  const [number, setNumber] = useState("");
  const deferredLabel = useDeferredValue(label);
  const deferredAssignee = useDeferredValue(assignee);
  const result = useEnvironmentQuery(
    atoms.list({
      environmentId,
      input: {
        ...(repository ? { repository } : {}),
        ...(deferredLabel.trim() ? { label: deferredLabel.trim() } : {}),
        ...(deferredAssignee.trim() ? { assignee: deferredAssignee.trim() } : {}),
        state,
        offset,
        limit: 50,
      },
    }),
  );
  const mutate = useAtomCommand(atoms.mutate, { reportFailure: false });
  const read = useAtomCommand(atoms.read, { reportFailure: false });
  async function load(ref: GitHubIssueReference) {
    const response = await read({ environmentId, input: ref });
    if (response._tag === "Success") setDetail(response.value);
    else setError(errorMessage(response.cause));
  }
  async function send(input: GitHubIssuesMutation, showDetail = false) {
    if (pending) return false;
    setPending(true);
    setError(null);
    try {
      const response = await mutate({ environmentId, input });
      result.refresh();
      if (response._tag !== "Success") {
        setError(errorMessage(response.cause));
        return false;
      }
      if (showDetail && (input.kind === "import" || input.kind === "refresh")) await load(input);
      if (input.kind === "sync" && detail && key(detail) === key(input)) await load(detail);
      if (input.kind === "untrack") {
        setRepository("");
        setDetail(null);
        setOffset(0);
      }
      return true;
    } finally {
      setPending(false);
    }
  }
  function configure(repo: GitHubTrackedRepository | null) {
    setEditing(repo);
    setHost(repo?.host ?? "github.com");
    setRepoName(repo?.repository ?? "");
    setProjectId(repo?.projectId ?? "");
    setImportLabels(repo?.importLabels.join(", ") ?? "");
    setShowConfig(true);
  }
  const repos = result.data?.repositories ?? [];
  const selected = repos.find((repo) => key(repo) === repository);
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
      <Text className="text-xl font-semibold">GitHub Issues</Text>
      <Text className="text-sm text-muted-foreground">
        Sync using this environment’s GitHub sign-in. Imports start in Inbox and never start agents.
      </Text>
      <ControlPill label="Track repository" onPress={() => configure(null)} />
      {showConfig && (
        <View className="gap-3 rounded-xl border border-border p-4">
          <Text>GitHub host</Text>
          <TextInput
            className={inputClass}
            accessibilityLabel="GitHub host"
            value={host}
            onChangeText={setHost}
            editable={!editing}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Text>Repository</Text>
          <TextInput
            className={inputClass}
            accessibilityLabel="Repository"
            placeholder="owner/repository"
            value={repoName}
            onChangeText={setRepoName}
            editable={!editing}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Choice
            title="Project for imports"
            value={projectId}
            options={[
              { id: "", title: "No project" },
              ...projects.map((project) => ({ id: project.id, title: project.title })),
            ]}
            onChange={setProjectId}
          />
          <Text>Import labels, separated by commas</Text>
          <TextInput
            className={inputClass}
            accessibilityLabel="Import labels"
            placeholder="ready, agent"
            value={importLabels}
            onChangeText={setImportLabels}
            autoCapitalize="none"
          />
          <Text className="text-xs text-muted-foreground">
            Matching open issues import when you sync. Leave empty for manual import only.
          </Text>
          <View className="flex-row flex-wrap gap-2">
            <ControlPill
              label="Save"
              disabled={pending}
              onPress={() =>
                void send({
                  kind: "configure",
                  host: host.trim(),
                  repository: repoName.trim(),
                  projectId: projectId ? ProjectId.make(projectId) : null,
                  importLabels: importLabels
                    .split(",")
                    .map((value) => value.trim())
                    .filter(Boolean),
                }).then((ok) => {
                  if (ok) setShowConfig(false);
                })
              }
            />
            <ControlPill label="Cancel" onPress={() => setShowConfig(false)} />
          </View>
        </View>
      )}
      {repos.map((repo) => (
        <View key={key(repo)} className="gap-2 rounded-xl border border-border p-3">
          <Text className="font-semibold">{key(repo)}</Text>
          <Text className="text-xs text-muted-foreground">
            {repo.lastSyncedAt
              ? `Synced ${new Date(repo.lastSyncedAt).toLocaleString()}`
              : "Not synced yet"}{" "}
            ·{" "}
            {repo.importLabels.length
              ? `Import labels: ${repo.importLabels.join(", ")}`
              : "Manual imports"}
          </Text>
          {repo.syncError && <Text className="text-sm text-destructive">{repo.syncError}</Text>}
          <View className="flex-row flex-wrap gap-2">
            <ControlPill
              label="Sync"
              disabled={pending}
              onPress={() => void send({ ...repo, kind: "sync" })}
            />
            <ControlPill label="Configure" disabled={pending} onPress={() => configure(repo)} />
            <ControlPill
              label="Untrack"
              disabled={pending}
              onPress={() => void send({ ...repo, kind: "untrack" })}
            />
          </View>
        </View>
      ))}
      {repos.length === 0 && !result.isPending && (
        <Text className="text-muted-foreground">
          Track a repository, then sync to browse issues. Untracking clears its issue cache and
          keeps imported work.
        </Text>
      )}
      <Choice
        title="Repository"
        value={repository}
        options={[
          { id: "", title: "All repositories" },
          ...repos.map((repo) => ({ id: key(repo), title: key(repo) })),
        ]}
        onChange={(value) => {
          setRepository(value);
          setOffset(0);
        }}
      />
      <TextInput
        className={inputClass}
        accessibilityLabel="Label filter"
        placeholder="Exact label"
        value={label}
        onChangeText={(value) => {
          setLabel(value);
          setOffset(0);
        }}
        autoCapitalize="none"
      />
      <TextInput
        className={inputClass}
        accessibilityLabel="Assignee filter"
        placeholder="Assignee username"
        value={assignee}
        onChangeText={(value) => {
          setAssignee(value);
          setOffset(0);
        }}
        autoCapitalize="none"
      />
      <Choice
        title="GitHub state"
        value={state}
        options={[
          { id: "open", title: "Open" },
          { id: "closed", title: "Closed" },
          { id: "all", title: "All states" },
        ]}
        onChange={(value) => {
          setState(value as typeof state);
          setOffset(0);
        }}
      />
      {selected && (
        <View className="gap-2">
          <TextInput
            className={inputClass}
            accessibilityLabel="Issue number"
            placeholder="Issue number"
            keyboardType="number-pad"
            value={number}
            onChangeText={setNumber}
          />
          <ControlPill
            label="Import to Work Queue"
            disabled={pending || !number}
            onPress={() => void send({ ...selected, kind: "import", number: Number(number) }, true)}
          />
        </View>
      )}
      {pending && (
        <Text accessibilityRole="text" className="text-muted-foreground">
          Updating GitHub issues…
        </Text>
      )}
      {(error || result.error) && (
        <Text accessibilityRole="alert" className="text-destructive">
          {error ?? result.error}
        </Text>
      )}
      {result.isPending && !result.data && <Text>Loading issues…</Text>}
      {result.data?.items.length === 0 && (
        <Text className="text-muted-foreground">
          No saved issues match these filters. Sync to fetch issues.
        </Text>
      )}
      {result.data?.items.map((issue) => (
        <View
          key={`${key(issue)}:${issue.externalId}`}
          className="gap-2 rounded-xl border border-border p-4"
        >
          <Text className="text-xs text-muted-foreground">
            {issue.repository} #{issue.number} · GitHub: {issue.state} · Work:{" "}
            {issue.localStatus ?? "Not imported"}
          </Text>
          <Pressable accessibilityRole="button" onPress={() => void load(issue)}>
            <Text className="text-lg font-semibold">{issue.title}</Text>
            <ExternalSyncStatus value={issue} />
          </Pressable>
          <Text className="text-sm text-muted-foreground">
            {issue.labels.join(", ") || "No labels"} · {issue.assignees.join(", ") || "Unassigned"}
            {issue.milestone ? ` · ${issue.milestone}` : ""}
          </Text>
          <View className="flex-row flex-wrap gap-2">
            <ControlPill
              label={issue.workItemId ? "In Work Queue" : "Import to Work Queue"}
              disabled={pending || !!issue.workItemId}
              onPress={() => void send({ ...issue, kind: "import" }, true)}
            />
            <ControlPill
              label="Refresh details"
              disabled={pending}
              onPress={() => void send({ ...issue, kind: "refresh" }, true)}
            />
            <ControlPill label="Open GitHub" onPress={() => void open(issue.url)} />
          </View>
        </View>
      ))}
      <View className="flex-row items-center gap-2">
        <ControlPill
          label="Previous"
          disabled={offset === 0}
          onPress={() => setOffset(Math.max(0, offset - 50))}
        />
        <Text>{result.data?.total ?? 0} issues</Text>
        <ControlPill
          label="Next"
          disabled={offset + 50 >= (result.data?.total ?? 0)}
          onPress={() => setOffset(offset + 50)}
        />
      </View>
      {detail && (
        <Modal visible presentationStyle="pageSheet" onRequestClose={() => setDetail(null)}>
          <SafeAreaView className="flex-1 bg-background" edges={["top", "bottom"]}>
            <ScrollView contentContainerClassName="gap-3 p-4">
              <ControlPill label="Close details" onPress={() => setDetail(null)} />
              {error && (
                <Text accessibilityRole="alert" className="text-destructive">
                  {error}
                </Text>
              )}
              {pending && <Text className="text-muted-foreground">Updating issue…</Text>}
              <Text className="text-lg font-semibold">
                {detail.repository} #{detail.number}: {detail.title}
              </Text>
              <Text className="text-sm text-muted-foreground">
                GitHub: {detail.state} · Work: {detail.localStatus ?? "Not imported"}
              </Text>
              <Text selectable>{detail.body || "No description."}</Text>
              <ControlPill
                label="Refresh issue and comments"
                disabled={pending}
                onPress={() => void send({ ...detail, kind: "refresh" }, true)}
              />
              <Text className="font-semibold">Comments</Text>
              <Text className="text-xs text-muted-foreground">
                {detail.commentsFetchedAt
                  ? `Updated ${new Date(detail.commentsFetchedAt).toLocaleString()}`
                  : "Refresh details to load comments."}
              </Text>
              {detail.commentsFetchedAt && !detail.comments.length && <Text>No comments.</Text>}
              {detail.comments.map((comment) => (
                <View key={comment.id} className="gap-1 border-t border-border pt-3">
                  <Pressable accessibilityRole="link" onPress={() => void open(comment.url)}>
                    <Text className="font-medium underline">{comment.author}</Text>
                  </Pressable>
                  <Text selectable>{comment.body}</Text>
                </View>
              ))}
            </ScrollView>
          </SafeAreaView>
        </Modal>
      )}
    </ScrollView>
  );
}
