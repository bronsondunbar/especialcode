import { RepositoryFolderPicker } from "./RepositoryFolderPicker";
import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import {
  createGitHubIssueAtoms,
  createWorkItemAtoms,
  workTaskProjectId,
  workTaskGitHubRepository,
  workRepositoryValue,
  workRepositoryProjectId,
  workRepositoryChoices,
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
  const savedProject = projects.find((project) => project.id === item?.projectId);
  const inferredProject = projects.find(
    (project) => project.id === (item ? workTaskProjectId(item, projects) : ""),
  );
  const selectedProject = projects.find((project) => project.id === selection);
  const value =
    (selectedProject ? workRepositoryValue(selectedProject) : selection) ??
    (savedProject
      ? workRepositoryValue(savedProject)
      : githubRepository
        ? `github:${githubRepository.toLowerCase()}`
        : inferredProject
          ? workRepositoryValue(inferredProject)
          : "");
  const projectId = workRepositoryProjectId(value, projects, item?.projectId);
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
  const [locationMode, setLocationMode] = useState<"existing" | "clone">("existing");
  const [existingPath, setExistingPath] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState<{
    cwd: string;
    projectId: ProjectId;
    createdAt: string;
  } | null>(null);
  const remote = value.startsWith("github:") ? value.slice(7) : null;
  const repositories = query.data?.repositories ?? [];
  const project = projects.find((project) => project.id === projectId);
  const choices = workRepositoryChoices(projects, repositories, value);
  const [changing, setChanging] = useState(false);
  const search = filter.trim().toLowerCase();
  const destinationPath = destination || (remote ? `~/Projects/${remote}` : "");
  const change = (next: string) => {
    const local = projects.find((project) => project.id === next);
    setProjectId(local ? workRepositoryValue(local) : next);
    setChanging(false);
    setDestination("");
    setExistingPath("");
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
        destinationPath: locationMode === "existing" ? existingPath.trim() : destinationPath.trim(),
        useExisting: locationMode === "existing",
        projects: projects.map(({ id, workspaceRoot }) => ({ id, workspaceRoot })),
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
      setError(
        `Repository found at ${result.value.cwd}, but could not add the project. Retry adding it.`,
      );
      return;
    }
    change(result.value.projectId);
  };
  return (
    <View className="gap-2">
      <View className="flex-row items-center justify-between gap-3 rounded-lg border border-border p-3">
        <View className="min-w-0 flex-1">
          <Text className="text-xs text-muted-foreground">Repository</Text>
          <Text numberOfLines={1} className="font-medium">
            {choices.find((choice) => choice.value === value)?.label ?? "Choose a repository"}
          </Text>
        </View>
        <ControlPill
          label={changing ? "Done" : "Change"}
          disabled={disabled || pending}
          onPress={() => setChanging((open) => !open)}
        />
      </View>
      {(changing || !value) && (
        <View className="gap-2">
          <TextInput
            accessibilityLabel="Filter repositories"
            className="rounded-lg border border-border p-3 text-foreground"
            placeholder="Find a repository"
            value={filter}
            onChangeText={setFilter}
            editable={!disabled && !pending}
          />
          <ControlPillMenu
            title="Repository"
            actions={choices
              .filter(
                (choice) => choice.value === value || choice.label.toLowerCase().includes(search),
              )
              .map((choice) => ({
                id: choice.value,
                title: choice.label,
                state: choice.value === value ? ("on" as const) : ("off" as const),
              }))}
            onPressAction={({ nativeEvent }) => {
              if (!disabled && !pending) change(nativeEvent.event);
            }}
          >
            <ControlPill label="Choose a repository" disabled={disabled || pending} />
          </ControlPillMenu>
          <ControlPill
            label="Refresh repositories"
            disabled={query.isPending || pending}
            onPress={query.refresh}
          />
        </View>
      )}
      {query.isPending && (changing || !value) && (
        <Text className="text-sm text-muted-foreground">Loading repositories…</Text>
      )}
      {query.error && !project && (changing || locationMode === "clone") && (
        <Text className="text-sm text-destructive">{query.error}</Text>
      )}
      {query.data && !query.data.login && !project && locationMode === "clone" && (
        <Text className="text-sm text-muted-foreground">
          Connect GitHub in Work → GitHub to clone this repository.
        </Text>
      )}
      {query.data?.partialAccess && changing && (
        <Text className="text-sm text-muted-foreground">
          Some repositories need organization SSO authorization for your token.
        </Text>
      )}
      {project && (
        <Text className="text-xs text-muted-foreground">
          {changing ? `Saved checkout: ${project.workspaceRoot}` : "Saved checkout will be reused."}
        </Text>
      )}
      {remote && !project && (
        <View className="gap-3">
          <View className="flex-row flex-wrap gap-2">
            <ControlPill
              label={
                locationMode === "existing"
                  ? "✓ Use existing repository"
                  : "Use existing repository"
              }
              disabled={disabled || pending || !!retry}
              onPress={() => {
                setLocationMode("existing");
                setError(null);
              }}
            />
            <ControlPill
              label={locationMode === "clone" ? "✓ Clone new" : "Clone new"}
              disabled={disabled || pending || !!retry}
              onPress={() => {
                setLocationMode("clone");
                setError(null);
              }}
            />
          </View>
          <Text className="text-sm text-muted-foreground">
            Choose a checkout anywhere on the connected server. It will be remembered for future
            issues.
          </Text>
          {locationMode === "existing" ? (
            <RepositoryFolderPicker
              environmentId={environmentId}
              value={existingPath}
              disabled={disabled || pending || !!retry}
              onSelect={setExistingPath}
            />
          ) : (
            <View className="gap-2">
              <Text>Clone folder on this server</Text>
              <TextInput
                accessibilityLabel="Clone folder on this server"
                className="rounded-lg border border-border p-3 text-foreground"
                value={destinationPath}
                editable={!disabled && !pending && !retry}
                onChangeText={setDestination}
              />
            </View>
          )}
          <ControlPill
            disabled={
              disabled ||
              pending ||
              (locationMode === "existing"
                ? !existingPath.trim()
                : !destinationPath.trim() || !query.data?.login)
            }
            onPress={() => void cloneSelected()}
            label={
              pending
                ? "Preparing repository…"
                : retry
                  ? "Retry adding project"
                  : locationMode === "existing"
                    ? "Use this repository"
                    : "Clone and use repository"
            }
          />
        </View>
      )}
      {error && <Text className="text-sm text-destructive">{error}</Text>}
    </View>
  );
}
