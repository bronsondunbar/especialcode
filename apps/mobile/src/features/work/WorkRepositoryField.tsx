import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import {
  createGitHubIssueAtoms,
  createWorkItemAtoms,
  workTaskProjectId,
  workTaskGitHubRepository,
} from "@t3tools/client-runtime/state/work-items";
import { ProjectId, type EnvironmentId, type WorkItem } from "@t3tools/contracts";
import { View } from "react-native";
import { environmentProjects } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { connectionAtomRuntime } from "../../connection/runtime";
import { uuidv4 } from "../../lib/uuid";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { ControlPill, ControlPillMenu } from "../../components/ControlPill";
const githubIssues = createGitHubIssueAtoms(connectionAtomRuntime);
const workItems = createWorkItemAtoms(connectionAtomRuntime);
export function useWorkTaskRepository(environmentId: EnvironmentId, item: WorkItem | undefined) {
  const projects = useAtomValue(environmentProjects.projectsAtom).filter(
    (project) => project.environmentId === environmentId,
  );
  const [selection, setProjectId] = useState<string | null>(null);
  const githubRepository = workTaskGitHubRepository(item);
  const chosen = item ? workTaskProjectId(item, projects) : "";
  const value = selection ?? (chosen || (githubRepository ? `github:${githubRepository}` : ""));
  const projectId = projects.find((project) => project.id === value)?.id ?? null;
  return { environmentId, projects, projectId, value, setProjectId };
}

export function WorkRepositoryField({
  environmentId,
  projects,
  projectId,
  value,
  setProjectId,
  disabled,
}: ReturnType<typeof useWorkTaskRepository> & { disabled?: boolean }) {
  const query = useEnvironmentQuery(githubIssues.repositories({ environmentId, input: {} }));
  const clone = useAtomCommand(workItems.cloneRepository, { reportFailure: false });
  const [filter, setFilter] = useState("");
  const [destination, setDestination] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState<{
    cwd: string;
    projectId: ProjectId;
    createdAt: string;
  } | null>(null);
  const remote = value.startsWith("github:") ? value.slice(7) : null;
  const repositories = query.data?.repositories ?? [];
  const matchingLocal = remote
    ? projects.filter(
        (project) =>
          project.repositoryIdentity?.canonicalKey.toLowerCase() ===
          `github.com/${remote}`.toLowerCase(),
      )
    : [];
  const search = filter.trim().toLowerCase();
  const change = (next: string) => {
    setProjectId(next);
    setDestination("");
    setRetry(null);
    setError(null);
  };
  const cloneSelected = async () => {
    if (!remote || pending) return;
    setPending(true);
    setError(null);
    const project = retry ?? {
      projectId: ProjectId.make(uuidv4()),
      createdAt: new Date().toISOString(),
    };
    const result = await clone({
      environmentId,
      input: {
        repository: remote,
        destinationPath: destination.trim(),
        ...project,
        ...(retry ? { clonedCwd: retry.cwd } : {}),
      },
    });
    setPending(false);
    if (result._tag === "Failure") {
      setError(String(Cause.squash(result.cause)));
      return;
    }
    if (!result.value.registered) {
      setRetry({ ...project, cwd: result.value.cwd });
      setError(`Cloned to ${result.value.cwd}, but could not add the project. Retry adding it.`);
      return;
    }
    change(result.value.projectId);
  };
  return (
    <View className="gap-2">
      <TextInput
        accessibilityLabel="Filter repositories"
        className="rounded-lg border border-border p-3 text-foreground"
        placeholder="Filter local and GitHub repositories"
        value={filter}
        onChangeText={setFilter}
        editable={!disabled && !pending}
      />
      <ControlPillMenu
        title="Repository"
        actions={[
          ...projects
            .filter(
              (project) =>
                project.id === value ||
                `${project.title} ${project.workspaceRoot}`.toLowerCase().includes(search),
            )
            .map((project) => ({
              id: project.id,
              title: `Local: ${project.title} — ${project.workspaceRoot}`,
              state: project.id === value ? ("on" as const) : ("off" as const),
            })),
          ...repositories
            .filter(
              (repo) =>
                repo.repository === remote || repo.repository.toLowerCase().includes(search),
            )
            .map((repo) => ({
              id: `github:${repo.repository}`,
              title: `GitHub: ${repo.repository}${repo.private ? " · Private" : ""}`,
              state: repo.repository === remote ? ("on" as const) : ("off" as const),
            })),
        ]}
        onPressAction={({ nativeEvent }) => {
          if (!disabled && !pending) change(nativeEvent.event);
        }}
      >
        <ControlPill
          disabled={disabled || pending}
          label={`Repository: ${remote ?? projects.find((project) => project.id === projectId)?.title ?? "Choose"}`}
        />
      </ControlPillMenu>
      {query.isPending && (
        <Text className="text-sm text-muted-foreground">Loading GitHub repositories…</Text>
      )}
      {query.error && <Text className="text-sm text-destructive">{query.error}</Text>}
      {query.data && !query.data.login && (
        <Text className="text-sm text-muted-foreground">
          Connect GitHub in Work → GitHub to browse your account’s repositories.
        </Text>
      )}
      {query.data?.partialAccess && (
        <Text className="text-sm text-muted-foreground">
          Some organization repositories are missing. Authorize your token for organization SSO in
          GitHub.
        </Text>
      )}
      <ControlPill
        label="Refresh repositories"
        disabled={query.isPending || pending}
        onPress={query.refresh}
      />
      {remote &&
        (matchingLocal.length ? (
          <View className="gap-2">
            <Text className="text-sm text-muted-foreground">
              This repository is already local. Choose a checkout:
            </Text>
            {matchingLocal.map((project) => (
              <ControlPill
                key={project.id}
                label={`Use ${project.workspaceRoot}`}
                disabled={disabled || pending}
                onPress={() => change(project.id)}
              />
            ))}
          </View>
        ) : (
          <View className="gap-2 rounded-lg border border-border p-3">
            <Text className="text-sm text-muted-foreground">
              Clone this repository onto the connected server before starting an agent.
            </Text>
            <Text>Destination folder on server</Text>
            <TextInput
              accessibilityLabel="Destination folder on server"
              className="rounded-lg border border-border p-3 text-foreground"
              placeholder={`~/Projects/${remote}`}
              value={destination}
              editable={!disabled && !pending && !retry}
              onChangeText={setDestination}
            />
            <ControlPill
              disabled={disabled || pending || !destination.trim() || !query.data?.login}
              onPress={() => void cloneSelected()}
              label={
                pending
                  ? "Preparing repository…"
                  : retry
                    ? "Retry adding project"
                    : "Clone and use repository"
              }
            />
          </View>
        ))}
      {error && <Text className="text-sm text-destructive">{error}</Text>}
      {!value && (
        <Text className="text-sm text-muted-foreground">
          Choose the repository the agent should work in.
        </Text>
      )}
      {projectId && (
        <Text className="text-sm text-muted-foreground">
          Manage local entries in the web or desktop app under Settings → Projects. Removing a
          project also removes its threads, but keeps files on disk.
        </Text>
      )}
    </View>
  );
}
