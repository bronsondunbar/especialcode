import { createFileRoute } from "@tanstack/react-router";
import { BellIcon } from "lucide-react";
import { EnvironmentId, WorkItemId } from "@t3tools/contracts";
import { NotificationCenter } from "../components/notifications/NotificationCenter";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { useEnvironments } from "../state/environments";
import { isElectron } from "../env";
export const Route = createFileRoute("/_chat/notifications")({
  validateSearch: (
    search: Record<string, unknown>,
  ): { environment?: string; workItem?: string } => ({
    ...(typeof search.environment === "string" ? { environment: search.environment } : {}),
    ...(typeof search.workItem === "string" ? { workItem: search.workItem } : {}),
  }),
  component: NotificationsPage,
});
function NotificationsPage() {
  const { environments } = useEnvironments();
  const search = Route.useSearch();
  const selected = search.environment;
  const navigate = Route.useNavigate();
  const supported = environments.filter(
    (env) => env.serverConfig?.environment.capabilities.notifications,
  );
  const environment = supported.find((env) => env.environmentId === selected) ?? supported[0];
  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <WorkspacePageHeader electron={isElectron}>
        <BellIcon className="size-4" />
        <h1 className="font-medium">Notifications</h1>
        {supported.length > 1 && (
          <select
            className="no-drag ml-auto rounded-lg border bg-background p-2 text-sm"
            aria-label="Notifications environment"
            value={environment?.environmentId ?? ""}
            onChange={(event) =>
              void navigate({ search: { environment: EnvironmentId.make(event.target.value) } })
            }
          >
            {supported.map((env) => (
              <option key={env.environmentId} value={env.environmentId}>
                {env.label}
              </option>
            ))}
          </select>
        )}
      </WorkspacePageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {environment ? (
          <NotificationCenter
            key={`${environment.environmentId}:${search.workItem ?? ""}`}
            initialWorkItemId={search.workItem ? WorkItemId.make(search.workItem) : null}
            onCloseWorkItem={() =>
              void navigate({ search: { environment: environment.environmentId } })
            }
            environmentId={environment.environmentId}
          />
        ) : (
          <p className="p-6 text-muted-foreground">
            Connect to an environment with notification support. Older servers need an update.
          </p>
        )}
      </div>
    </main>
  );
}
