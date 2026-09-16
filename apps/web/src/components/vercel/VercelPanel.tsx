import { VercelProjectField } from "./VercelProjectField";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { createVercelAtoms } from "@t3tools/client-runtime/state/vercel";
import type {
  EnvironmentId,
  ProjectId,
  ThreadId,
  VercelAdminInput,
  VercelLinkInput,
} from "@t3tools/contracts";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useEnvironmentQuery, formatEnvironmentQueryError } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
const atoms = createVercelAtoms(connectionAtomRuntime);
type Target = { environmentId: EnvironmentId; projectId: ProjectId; threadId?: ThreadId };
export function VercelDialog({ onClose, ...target }: Target & { onClose: () => void }) {
  const [pending, setPending] = useState(false);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogPopup
        className="max-w-3xl overflow-y-auto p-6"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <DialogTitle>Vercel deployments</DialogTitle>
        <VercelPanel {...target} pending={pending} setPending={setPending} />
      </DialogPopup>
    </Dialog>
  );
}
export function VercelPanel({
  environmentId,
  projectId,
  threadId,
  pending,
  setPending,
  settings = false,
}: Omit<Target, "projectId"> & {
  projectId?: ProjectId;
  pending: boolean;
  setPending: (value: boolean) => void;
  settings?: boolean;
}) {
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
        setError(formatEnvironmentQueryError(response.cause));
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
  return (
    <div className="mt-4 grid gap-4">
      <p className="text-sm text-muted-foreground">
        {settings
          ? "Connect Vercel once here. Choose a Vercel project in each thread or when creating one."
          : "Follow deployment status and build logs. Refreshes every 15 seconds while open."}
      </p>
      {(error || query.error || data?.error) && (
        <p role="alert" className="text-sm text-destructive">
          {error ?? query.error ?? data?.error}
        </p>
      )}
      {!data && query.isPending && <p>Loading Vercel…</p>}
      {settings && data?.connection && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm">
            Vercel connected
            {data.connection.teamId ? ` · ${data.connection.teamId}` : ""}
          </p>
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => {
              setEditing(!editing);
              setTeamId(data.connection?.teamId ?? "");
            }}
          >
            Edit connection
          </Button>
        </div>
      )}
      {!settings && data && !data.connection && (
        <Link to="/work" search={{ tab: "vercel" }} className="text-sm underline">
          Connect Vercel in Work → Vercel
        </Link>
      )}
      {settings && data && (!data.connection || editing) && (
        <form
          className="grid gap-3 rounded-lg border p-4"
          onSubmit={(event) => {
            event.preventDefault();
            void save({
              kind: "connect",
              token: token.trim(),
              teamId: teamId.trim() || null,
            });
          }}
        >
          <p className="text-sm text-muted-foreground">
            An environment administrator can connect Vercel here. The token stays on the server.
            Deployment logs are shared with people who can read this environment.
          </p>
          <label className="grid gap-1 text-sm">
            Vercel access token
            <Input
              type="password"
              autoComplete="off"
              value={token}
              disabled={pending}
              onChange={(event) => setToken(event.target.value)}
              required
            />
          </label>
          <label className="grid gap-1 text-sm">
            Team ID (optional)
            <Input
              placeholder="team_…"
              value={teamId}
              disabled={pending}
              onChange={(event) => setTeamId(event.target.value)}
            />
          </label>
          <div className="flex gap-2">
            <Button type="submit" disabled={pending || !token.trim()}>
              {pending ? "Connecting…" : "Connect Vercel"}
            </Button>
            {data.connection && (
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() => void save({ kind: "disconnect" })}
              >
                Disconnect
              </Button>
            )}
          </div>
        </form>
      )}
      {projectId && threadId && data?.connection && (
        <div className="grid gap-3 rounded-lg border p-4">
          <p className="text-sm">
            {data.link
              ? `Following ${data.link.project.name} · ${data.link.branch ?? "Choose a branch"}`
              : "This thread is unlinked from Vercel."}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => {
                setEditingLink(!editingLink);
                setLinkProject(data.link?.project.id ?? "");
                setBranch(data.link?.branch ?? "");
              }}
            >
              {data.link ? "Change project" : "Choose project"}
            </Button>
            {data.link && (
              <Button
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() => void save({ kind: "unlink", projectId, threadId })}
              >
                Unlink thread
              </Button>
            )}
          </div>
          {editingLink && (
            <form
              className="grid gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                void save({
                  kind: "link",
                  projectId,
                  threadId,
                  vercelProject: linkProject.trim(),
                  branch: branch.trim() || null,
                });
              }}
            >
              <VercelProjectField
                environmentId={environmentId}
                projectId={projectId}
                value={linkProject ? { project: linkProject } : undefined}
                onChange={(value) => setLinkProject(value?.project ?? "")}
                disabled={pending}
              />
              <label className="grid gap-1 text-sm">
                Git branch
                <Input
                  value={branch}
                  placeholder="Leave blank to follow the thread's current branch"
                  disabled={pending}
                  onChange={(event) => setBranch(event.target.value)}
                />
              </label>
              <Button type="submit" disabled={pending || !linkProject.trim()}>
                Save thread link
              </Button>
            </form>
          )}
        </div>
      )}
      {!settings && data?.connection && data.link && (
        <>
          <div className="flex items-center justify-between gap-2">
            <h3 className="font-medium">Deployments</h3>
            <Button variant="ghost" size="sm" onClick={query.refresh}>
              Refresh
            </Button>
          </div>
          {data.checkedAt && (
            <p className="text-xs text-muted-foreground">
              Checked {new Date(data.checkedAt).toLocaleTimeString()} · Latest 20 deployments
              {data.link.branch ? ` for ${data.link.branch}` : ""}
            </p>
          )}
          {!data.error && !data.deployments.length && (
            <p className="text-sm text-muted-foreground">
              No deployments yet. Push this branch to your Vercel-connected repository to trigger
              its build.
            </p>
          )}
          {!!data.deployments.length && (
            <select
              aria-label="Deployment"
              className="h-9 rounded-lg border bg-background px-2 text-sm"
              value={deploymentId}
              onChange={(event) => setDeploymentId(event.target.value)}
            >
              <option value="">Follow latest deployment</option>
              {data.deployments.map((deployment) => (
                <option key={deployment.id} value={deployment.id}>
                  {deployment.state} · {new Date(deployment.createdAt).toLocaleString()} ·{" "}
                  {deployment.id}
                </option>
              ))}
            </select>
          )}
          {selected && (
            <div className="grid gap-2 rounded-lg border p-4">
              <p className="font-medium">
                {selected.state.replaceAll("_", " ")}
                {selected.target ? ` · ${selected.target}` : ""}
              </p>
              {selected.commit && (
                <p className="text-xs text-muted-foreground">
                  Commit {selected.commit.slice(0, 8)}
                </p>
              )}
              {selected.url && (
                <a
                  className="break-all text-sm underline"
                  href={selected.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open deployment · {selected.url}
                </a>
              )}
              <Button
                size="sm"
                variant="outline"
                aria-expanded={showLogs}
                onClick={() => setShowLogs(!showLogs)}
              >
                {showLogs ? "Hide build logs" : "Show build logs"}
              </Button>
            </div>
          )}
          {showLogs && (
            <div className="grid gap-2">
              {data.logsError && (
                <p role="alert" className="text-destructive">
                  {data.logsError}
                </p>
              )}
              {data.logsTruncated && (
                <p className="text-xs text-muted-foreground">
                  Showing the latest 200 events, up to 64,000 characters.
                </p>
              )}
              <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted p-3 text-xs">
                {data.logs || "No build logs available yet."}
              </pre>
            </div>
          )}
        </>
      )}
    </div>
  );
}
