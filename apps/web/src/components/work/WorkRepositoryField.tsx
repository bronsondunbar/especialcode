import { Link } from "@tanstack/react-router";
import { useState } from "react";
import {
  workTaskProjectId,
  workTaskGitHubRepository,
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
      projectId: ProjectId.make(randomUUID()),
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
      setError(formatEnvironmentQueryError(result.cause));
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
    <div className="grid gap-2 text-sm">
      <label className="grid gap-1">
        Repository
        <Input
          aria-label="Filter repositories"
          placeholder="Filter local and GitHub repositories"
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
          <optgroup label="Local repositories">
            {projects
              .filter(
                (project) =>
                  project.id === value ||
                  `${project.title} ${project.workspaceRoot}`.toLowerCase().includes(search),
              )
              .map((project) => (
                <option key={project.id} value={project.id}>
                  {project.title} — {project.workspaceRoot}
                </option>
              ))}
          </optgroup>
          <optgroup label={query.data?.login ? `GitHub · @${query.data.login}` : "GitHub"}>
            {remote && !repositories.some((repo) => repo.repository === remote) && (
              <option value={value}>{remote}</option>
            )}
            {repositories
              .filter(
                (repo) =>
                  repo.repository === remote || repo.repository.toLowerCase().includes(search),
              )
              .map((repo) => (
                <option key={repo.repository} value={`github:${repo.repository}`}>
                  {repo.repository}
                  {repo.private ? " · Private" : ""}
                </option>
              ))}
          </optgroup>
        </select>
      </label>
      {query.isPending && (
        <p className="text-muted-foreground" role="status">
          Loading GitHub repositories…
        </p>
      )}
      {query.error && (
        <p className="text-destructive" role="alert">
          {query.error}
        </p>
      )}
      {query.data && !query.data.login && (
        <p className="text-muted-foreground">
          Connect GitHub in Work → GitHub to browse your account’s repositories.
        </p>
      )}
      {query.data?.partialAccess && (
        <p className="text-muted-foreground">
          Some organization repositories are missing. Authorize your token for organization SSO in
          GitHub.
        </p>
      )}
      <div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={query.isPending || pending}
          onClick={query.refresh}
        >
          Refresh repositories
        </Button>
      </div>
      {remote &&
        (matchingLocal.length ? (
          <div className="grid gap-2">
            <p className="text-muted-foreground">
              This repository is already local. Choose a checkout:
            </p>
            {matchingLocal.map((project) => (
              <Button
                type="button"
                key={project.id}
                variant="outline"
                size="sm"
                disabled={disabled || pending}
                onClick={() => change(project.id)}
              >
                Use {project.workspaceRoot}
              </Button>
            ))}
          </div>
        ) : (
          <div className="grid gap-2 rounded-lg border p-3">
            <p className="text-muted-foreground">
              Clone this repository onto the connected server before starting an agent.
            </p>
            <label className="grid gap-1">
              Destination folder on server
              <Input
                placeholder={`~/Projects/${remote}`}
                value={destination}
                disabled={disabled || pending || !!retry}
                onChange={(event) => setDestination(event.target.value)}
              />
            </label>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled || pending || !destination.trim() || !query.data?.login}
              onClick={() => void cloneSelected()}
            >
              {pending
                ? "Preparing repository…"
                : retry
                  ? "Retry adding project"
                  : "Clone and use repository"}
            </Button>
          </div>
        ))}
      {error && (
        <p className="text-destructive" role="alert">
          {error}
        </p>
      )}
      {!value && (
        <p className="text-muted-foreground">Choose the repository the agent should work in.</p>
      )}
      {projectId && (
        <p className="text-muted-foreground">
          <Link to="/settings/projects" className="underline">
            Manage local repositories in Settings
          </Link>
        </p>
      )}
    </div>
  );
}
