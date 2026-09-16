import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { createVercelAtoms } from "@t3tools/client-runtime/state/vercel";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironments } from "../../state/environments";
import { Button } from "../ui/button";
const atoms = createVercelAtoms(connectionAtomRuntime);
export type VercelSelection = { project: string | null } | undefined;
type Props = {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  value: VercelSelection;
  onChange: (value: VercelSelection) => void;
  disabled?: boolean;
};
export function VercelProjectField(props: Props) {
  const { environments } = useEnvironments();
  if (
    !environments.find((env) => env.environmentId === props.environmentId)?.serverConfig
      ?.environment.capabilities.vercel
  )
    return null;
  return <ProjectField {...props} />;
}
function ProjectField({ environmentId, value, onChange, disabled }: Props) {
  const [search, setSearch] = useState("");
  const [queryText, setQueryText] = useState("");
  const query = useEnvironmentQuery(
    atoms.projects({ environmentId, input: { search: queryText } }),
  );
  const projects = query.data?.projects ?? [];
  const current = value?.project ?? "none";
  return (
    <div className="grid gap-2 rounded-lg border p-3">
      <label className="grid gap-1 text-sm">
        Vercel project
        <select
          className="h-9 rounded-lg border bg-background px-2"
          value={current}
          disabled={disabled || !query.data?.connection}
          onChange={(event) =>
            onChange(event.target.value === "none" ? undefined : { project: event.target.value })
          }
        >
          <option value="none">
            {query.data?.connection ? "Do not link to Vercel" : "No Vercel connection"}
          </option>
          {value?.project && !projects.some((project) => project.id === value.project) && (
            <option value={value.project}>{value.project}</option>
          )}
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      </label>
      {query.data?.connection && (
        <>
          <div className="flex gap-2">
            <input
              aria-label="Search Vercel projects"
              className="h-9 min-w-0 flex-1 rounded-lg border bg-background px-2 text-sm"
              placeholder="Search Vercel projects by name"
              value={search}
              disabled={disabled}
              maxLength={200}
              onChange={(event) => setSearch(event.target.value)}
            />
            <Button
              type="button"
              variant="outline"
              disabled={disabled}
              onClick={() => setQueryText(search.trim())}
            >
              Search
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Follows the thread’s branch. Showing up to 20 projects; search for another.
          </p>
        </>
      )}
      {query.isPending && <p className="text-xs text-muted-foreground">Loading Vercel projects…</p>}
      {query.error && (
        <p role="alert" className="text-sm text-destructive">
          {query.error}
        </p>
      )}
      {query.data && !query.data.connection && (
        <Link to="/work" search={{ tab: "vercel" }} className="text-sm underline">
          Connect in Work → Vercel
        </Link>
      )}
    </div>
  );
}
