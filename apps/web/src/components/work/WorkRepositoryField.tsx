import { RepositoryFolderPicker } from "./RepositoryFolderPicker";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import {
  workTaskProjectId,
  workTaskGitHubRepository,
  workRepositoryValue,
  workRepositoryProjectId,
  workRepositoryChoices,
} from "@t3tools/client-runtime/state/work-items";
import { ProjectId, type EnvironmentId, type WorkItem } from "@t3tools/contracts";
import { useProjects } from "../../state/entities";
import { useEnvironmentQuery, formatEnvironmentQueryError } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { githubIssues, workItems } from "../../state/workItems";
import { randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

export function useWorkTaskRepository(environmentId: EnvironmentId, item: WorkItem | undefined) {
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
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
      projectId: ProjectId.make(randomUUID()),
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
      setError(formatEnvironmentQueryError(result.cause));
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
    <div className="grid gap-2 text-sm">
      <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">Repository</p>
          <p className="truncate font-medium">
            {choices.find((choice) => choice.value === value)?.label ?? "Choose a repository"}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || pending}
          onClick={() => setChanging((open) => !open)}
        >
          {changing ? "Done" : "Change"}
        </Button>
      </div>
      {(changing || !value) && (
        <div className="grid gap-2">
          <Input
            aria-label="Filter repositories"
            placeholder="Find a repository"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            disabled={disabled || pending}
          />
          <select
            aria-label="Repository"
            className="h-9 min-w-0 rounded-lg border bg-background px-2"
            value={value}
            disabled={disabled || pending}
            onChange={(event) => change(event.target.value)}
          >
            <option value="">Choose a repository</option>
            {choices
              .filter(
                (choice) => choice.value === value || choice.label.toLowerCase().includes(search),
              )
              .map((choice) => (
                <option key={choice.value} value={choice.value}>
                  {choice.label}
                </option>
              ))}
          </select>
          <div className="flex items-center justify-between gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={query.isPending || pending}
              onClick={query.refresh}
            >
              Refresh repositories
            </Button>
            <Link to="/settings/projects" className="text-muted-foreground underline">
              Manage local repositories
            </Link>
          </div>
        </div>
      )}
      {query.isPending && (changing || !value) && (
        <p className="text-muted-foreground" role="status">
          Loading repositories…
        </p>
      )}
      {query.error && !project && (changing || locationMode === "clone") && (
        <p className="text-destructive" role="alert">
          {query.error}
        </p>
      )}
      {query.data && !query.data.login && !project && locationMode === "clone" && (
        <p className="text-muted-foreground">
          Connect GitHub in Work → GitHub to clone this repository.
        </p>
      )}
      {query.data?.partialAccess && changing && (
        <p className="text-muted-foreground">
          Some repositories need organization SSO authorization for your token.
        </p>
      )}
      {project && (
        <p className="break-all text-xs text-muted-foreground">
          {changing ? `Saved checkout: ${project.workspaceRoot}` : "Saved checkout will be reused."}
        </p>
      )}
      {remote && !project && (
        <div className="grid gap-3">
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant={locationMode === "existing" ? "secondary" : "outline"}
              aria-pressed={locationMode === "existing"}
              disabled={disabled || pending || !!retry}
              onClick={() => {
                setLocationMode("existing");
                setError(null);
              }}
            >
              Use existing repository
            </Button>
            <Button
              type="button"
              variant={locationMode === "clone" ? "secondary" : "outline"}
              aria-pressed={locationMode === "clone"}
              disabled={disabled || pending || !!retry}
              onClick={() => {
                setLocationMode("clone");
                setError(null);
              }}
            >
              Clone new
            </Button>
          </div>
          <p className="text-muted-foreground">
            Choose a checkout anywhere on the connected server. It will be remembered for future
            issues.
          </p>
          {locationMode === "existing" ? (
            <RepositoryFolderPicker
              environmentId={environmentId}
              value={existingPath}
              disabled={disabled || pending || !!retry}
              onSelect={setExistingPath}
            />
          ) : (
            <details>
              <summary className="cursor-pointer text-muted-foreground">Clone location</summary>
              <label className="mt-2 grid gap-1">
                Folder on this server
                <Input
                  value={destinationPath}
                  disabled={disabled || pending || !!retry}
                  onChange={(event) => setDestination(event.target.value)}
                />
              </label>
            </details>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={
              disabled ||
              pending ||
              (locationMode === "existing"
                ? !existingPath.trim()
                : !destinationPath.trim() || !query.data?.login)
            }
            onClick={() => void cloneSelected()}
          >
            {pending
              ? "Preparing repository…"
              : retry
                ? "Retry adding project"
                : locationMode === "existing"
                  ? "Use this repository"
                  : "Clone and use repository"}
          </Button>
        </div>
      )}
      {error && (
        <p className="text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
