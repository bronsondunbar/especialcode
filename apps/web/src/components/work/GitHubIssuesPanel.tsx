import { useState } from "react";
import type { EnvironmentId, GitHubAccountInput } from "@t3tools/contracts";
import { useEnvironments } from "../../state/environments";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { githubIssues } from "../../state/workItems";
import { ExternalSyncStatus } from "./ExternalSyncStatus";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
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
  const result = useEnvironmentQuery(githubIssues.list({ environmentId, input: { limit: 1 } }));
  const accountCommand = useAtomCommand(githubIssues.account, { reportFailure: false });
  async function manageAccount(input: GitHubAccountInput) {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const response = await accountCommand({ environmentId, input });
      setToken("");
      result.refresh();
      if (response._tag !== "Success") setError(formatEnvironmentQueryError(response.cause));
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
      <div className="mx-auto flex max-w-5xl flex-col gap-5">
        <div>
          <h2 className="text-xl font-semibold">GitHub</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Connect your account. Assigned issues appear automatically in your Work queue.
          </p>
        </div>
        {!accountSupported && <p>Update this environment to connect a GitHub account.</p>}
        {result.isPending && !result.data && <p role="status">Loading GitHub connection…</p>}
        {accountSupported && (
          <section className="grid gap-3 rounded-xl border p-4" aria-label="GitHub account">
            <h3 className="font-semibold">GitHub account</h3>
            <p className="text-sm text-muted-foreground">
              Open issues assigned to you across accessible repositories and organizations become
              tasks in your Work queue’s Inbox. Sync runs every five minutes while this environment
              is running. No agents start automatically.
            </p>
            {result.data?.account && (
              <>
                <p>
                  Connected as <strong>@{result.data.account.login}</strong>
                </p>
                <ExternalSyncStatus value={result.data.account} />
                <div className="flex flex-wrap gap-2">
                  <Button disabled={pending} onClick={() => void manageAccount({ kind: "sync" })}>
                    Sync assigned issues
                  </Button>
                  <Button
                    variant="outline"
                    disabled={pending}
                    onClick={() => void manageAccount({ kind: "disconnect" })}
                  >
                    Disconnect account
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Disconnecting stops sync and removes the saved token. Existing Work tasks are
                  kept.
                </p>
              </>
            )}
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void manageAccount({ kind: "connect", token: token.trim() });
              }}
            >
              <label className="grid flex-1 gap-1 text-sm">
                Personal access token
                <Input
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  required
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                  placeholder="GitHub personal access token"
                />
              </label>
              <Button type="submit" disabled={pending || !token.trim()}>
                {result.data?.account ? "Update token" : "Connect GitHub account"}
              </Button>
            </form>
            <p className="text-sm text-muted-foreground">
              For private repositories across organizations, use a classic token with repo scope and
              authorize any required organization SSO. Organization policies may restrict access.
              The token stays on this environment; tasks are visible to clients connected to it.
            </p>
            <a
              className="text-sm underline"
              href="https://github.com/settings/tokens/new?description=EspecialCode%20assigned%20issues&amp;scopes=repo"
              target="_blank"
              rel="noreferrer"
            >
              Create a GitHub token
            </a>
          </section>
        )}
        {pending && (
          <p role="status" className="text-sm text-muted-foreground">
            Updating GitHub…
          </p>
        )}
        {(error || result.error) && (
          <p role="alert" className="text-sm text-destructive">
            {error ?? result.error}
          </p>
        )}
      </div>
    </div>
  );
}
