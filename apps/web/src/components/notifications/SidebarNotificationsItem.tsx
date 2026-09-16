import { useAtomValue } from "@effect/atom-react";
import { BellIcon } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import type { EnvironmentId } from "@t3tools/contracts";
import { useMemo } from "react";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { notifications } from "../../state/notifications";
import { SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";

export function SidebarNotificationsItem({
  active,
  onOpen,
}: {
  active: boolean;
  onOpen: () => void;
}) {
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const key = JSON.stringify(
    environments
      .filter((env) => env.serverConfig?.environment.capabilities.notifications)
      .map((env) => env.environmentId),
  );
  const countsAtom = useMemo(
    () =>
      Atom.make((get) => {
        const ids = JSON.parse(key) as EnvironmentId[];
        return ids.map((environmentId) => {
          const result = get(notifications.list({ environmentId, input: { limit: 1 } }));
          return {
            environmentId,
            count: Option.getOrNull(AsyncResult.value(result))?.unreadCount ?? 0,
            unavailable: result._tag === "Failure",
          };
        });
      }),
    [key],
  );
  const counts = useAtomValue(countsAtom);
  const navigate = useNavigate();
  const count = counts.reduce((total, entry) => total + entry.count, 0);
  const unavailable = counts.some((entry) => entry.unavailable);
  const target =
    counts.find((entry) => entry.count > 0) ??
    counts.find((entry) => entry.environmentId === primaryEnvironmentId) ??
    counts[0];
  if (!target) return null;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={active}
        aria-current={active ? "page" : undefined}
        aria-label={`Notifications, ${count} unread${unavailable ? ", some servers unavailable" : ""}`}
        onClick={() => {
          onOpen();
          void navigate({ to: "/notifications", search: { environment: target.environmentId } });
        }}
      >
        <BellIcon />
        <span>Notifications</span>
        {count > 0 && (
          <span
            aria-hidden
            className="ml-auto rounded-full bg-primary px-1.5 text-xs text-primary-foreground tabular-nums"
          >
            {count > 99 ? "99+" : count}
          </span>
        )}
        {unavailable && (
          <span aria-hidden className="text-muted-foreground">
            !
          </span>
        )}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
