import { toastManager } from "../ui/toast";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import type { DesktopAppNotification, EnvironmentId } from "@t3tools/contracts";
import {
  consumeNotificationPage,
  claimNotificationDelivery,
} from "@t3tools/client-runtime/state/work-items";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useClientSettings, getClientSettings } from "../../hooks/useSettings";
import { useEnvironmentQuery } from "../../state/query";
import { notifications } from "../../state/notifications";
import { useRightPanelStore } from "../../rightPanelStore";
import {
  hasDesktopNotifications,
  hasNotificationSound,
  playNotificationSound,
} from "../../threadNotifications";

export function ApplicationNotificationDelivery({
  environmentId,
  onNotification,
}: {
  environmentId: EnvironmentId;
  onNotification: (
    environmentId: EnvironmentId,
    notification: Pick<Notification, "tag" | "close">,
  ) => void;
}) {
  const [after, setAfter] = useState<number | null>(null);
  const cursor = useRef<number | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const mode = useClientSettings((s) => s.notificationMode);
  const query = useEnvironmentQuery(
    notifications.list({
      environmentId,
      input: {
        channel: "desktop",
        limit: 100,
        ...(after === null ? {} : { afterSequence: after }),
      },
    }),
  );
  const navigate = useNavigate();
  const open = useCallback(
    (payload: DesktopAppNotification) => {
      if (payload.environmentId !== environmentId || !payload.action) return;
      const action = payload.action;
      if (action.kind === "work_item")
        void navigate({
          to: "/notifications",
          search: { environment: environmentId, workItem: action.workItemId },
        });
      else {
        if (action.kind === "changes")
          useRightPanelStore
            .getState()
            .open(scopeThreadRef(environmentId, action.threadId), "diff");
        void navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId, threadId: action.threadId },
        });
      }
    },
    [environmentId, navigate],
  );
  useEffect(() => window.desktopBridge?.onAppNotificationClick?.(open), [open]);
  useEffect(() => {
    if (!query.data) return;
    const batch = consumeNotificationPage(cursor.current, query.data, Date.now());
    cursor.current = batch.cursor;
    setAfter(batch.cursor);
    if (!query.data.preferences?.value.delivery.desktop) return;
    for (const item of batch.items) {
      if (hasNotificationSound(mode)) {
        const sound = () => {
          if (claimDelivery(`t3.notification-sound:${environmentId}`, item.id))
            void playNotificationSound(
              item.type === "agent_execution_completed" ? "completion" : "input",
              () => hasNotificationSound(getClientSettings().notificationMode),
            );
        };
        if (navigator.locks)
          void navigator.locks
            .request(`t3-notification-sound:${environmentId}`, sound)
            .catch(() => undefined);
        else sound();
      }
      if (
        !hasDesktopNotifications(mode) ||
        (document.visibilityState === "visible" && document.hasFocus())
      )
        continue;
      const payload: DesktopAppNotification = {
        id: item.id,
        environmentId,
        title: item.title,
        message: item.message,
        action: item.action,
      };
      const tag = `${environmentId}:${item.id}`;
      if (window.desktopBridge?.showAppNotification) {
        void window.desktopBridge
          .showAppNotification(payload)
          .then((shown) => {
            if (!shown) return;
            if (
              !mounted.current ||
              !hasDesktopNotifications(getClientSettings().notificationMode) ||
              (document.visibilityState === "visible" && document.hasFocus())
            ) {
              void window.desktopBridge?.closeAppNotification?.(tag);
              return;
            }
            onNotification(environmentId, {
              tag,
              close: () => {
                void window.desktopBridge?.closeAppNotification?.(tag);
              },
            });
          })
          .catch(() => undefined);
        continue;
      }
      if (typeof Notification === "undefined" || Notification.permission !== "granted") continue;
      const deliver = () => {
        // The lock and bounded event IDs prevent another tab from presenting the same alert.
        const key = `t3.notification-delivery:${environmentId}`;
        if (!claimDelivery(key, item.id)) return;
        if (
          !mounted.current ||
          !hasDesktopNotifications(getClientSettings().notificationMode) ||
          (document.visibilityState === "visible" && document.hasFocus())
        )
          return;
        try {
          const alert = new Notification(item.title, { body: item.message, tag, silent: true });
          onNotification(environmentId, alert);
          alert.addEventListener("click", () => {
            alert.close();
            window.focus();
            open(payload);
          });
        } catch {
          /* Permission or OS presentation can become unavailable after the check. */
        }
      };
      if (navigator.locks)
        void navigator.locks
          .request(`t3-notifications:${environmentId}`, deliver)
          .catch(() => undefined);
      else deliver();
    }
  }, [environmentId, mode, onNotification, open, query.data]);
  return null;
}

/** Foreground toasts retain the existing device opt-in, using the in-app delivery channel. */
export function ApplicationToastDelivery({ environmentId }: { environmentId: EnvironmentId }) {
  const [after, setAfter] = useState<number | null>(null);
  const cursor = useRef<number | null>(null);
  const enabled = useClientSettings((s) => s.inAppNotificationsEnabled);
  const query = useEnvironmentQuery(
    notifications.list({
      environmentId,
      input: { limit: 100, ...(after === null ? {} : { afterSequence: after }) },
    }),
  );
  const navigate = useNavigate();
  const active = useParams({ strict: false });
  useEffect(() => {
    if (!query.data) return;
    const batch = consumeNotificationPage(cursor.current, query.data, Date.now());
    cursor.current = batch.cursor;
    setAfter(batch.cursor);
    if (
      !enabled ||
      !query.data.preferences?.value.delivery.inApp ||
      !document.hasFocus() ||
      document.visibilityState !== "visible"
    )
      return;
    for (const item of batch.items) {
      const action = item.action;
      if (
        action &&
        action.kind !== "work_item" &&
        active.environmentId === environmentId &&
        active.threadId === action.threadId
      )
        continue;
      const id = toastManager.add({
        type:
          item.priority === "urgent"
            ? "error"
            : item.priority === "attention"
              ? "warning"
              : "success",
        title: item.title,
        description: item.message,
        data: { hideCopyButton: true },
        ...(action
          ? {
              actionProps: {
                children: "Open details",
                onClick: () => {
                  toastManager.close(id);
                  if (action.kind === "work_item")
                    void navigate({
                      to: "/notifications",
                      search: { environment: environmentId, workItem: action.workItemId },
                    });
                  else {
                    if (action.kind === "changes")
                      useRightPanelStore
                        .getState()
                        .open(scopeThreadRef(environmentId, action.threadId), "diff");
                    void navigate({
                      to: "/$environmentId/$threadId",
                      params: { environmentId, threadId: action.threadId },
                    });
                  }
                },
              },
            }
          : {}),
      });
    }
  }, [active.environmentId, active.threadId, enabled, environmentId, navigate, query.data]);
  return null;
}

function claimDelivery(key: string, id: string): boolean {
  try {
    return claimNotificationDelivery(window.localStorage, key, id);
  } catch {
    return true;
  }
}
