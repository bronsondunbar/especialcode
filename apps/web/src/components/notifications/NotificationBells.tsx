import { BellIcon } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { notifications } from "../../state/notifications";
import { Button } from "../ui/button";
export function NotificationBells() {
  const { environments } = useEnvironments();
  return environments
    .filter((env) => env.serverConfig?.environment.capabilities.notifications)
    .map((env) => (
      <NotificationBell
        key={env.environmentId}
        environmentId={env.environmentId}
        label={env.label}
      />
    ));
}
function NotificationBell({
  environmentId,
  label,
}: {
  environmentId: EnvironmentId;
  label: string;
}) {
  const result = useEnvironmentQuery(notifications.list({ environmentId, input: { limit: 1 } }));
  const navigate = useNavigate();
  const count = result.data?.unreadCount;
  return (
    <Button
      variant="ghost"
      className="no-drag relative shrink-0"
      aria-label={`${label}: Notifications${count !== undefined ? `, ${count} unread` : ", unavailable"}`}
      title={`${label}: Notifications`}
      onClick={() =>
        void navigate({ to: "/notifications", search: { environment: environmentId } })
      }
    >
      <BellIcon className="size-4" />
      {count !== undefined && count > 0 && (
        <span className="rounded-full bg-primary px-1 text-xs text-primary-foreground">
          {count > 99 ? "99+" : count}
        </span>
      )}
      {result.error && <span aria-label="Disconnected">!</span>}
    </Button>
  );
}
