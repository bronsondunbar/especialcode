import { useState } from "react";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  NOTIFICATION_PREFERENCE_GROUPS,
  type EnvironmentId,
  type NotificationPreferences,
} from "@t3tools/contracts";
import { notifications } from "../../state/notifications";
import { useEnvironmentQuery, formatEnvironmentQueryError } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import { unlockNotificationAudio, hasNotificationSound } from "../../threadNotifications";
export function NotificationPreferencesPanel({ environmentId }: { environmentId: EnvironmentId }) {
  const query = useEnvironmentQuery(notifications.list({ environmentId, input: { limit: 1 } }));
  const command = useAtomCommand(notifications.mutate, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const state = query.data?.preferences;
  async function save(value: NotificationPreferences) {
    if (!state || pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await command({
        environmentId,
        input: { kind: "preferences", expectedRevision: state.revision, value },
      });
      if (result._tag !== "Success") setError(formatEnvironmentQueryError(result.cause));
    } finally {
      setPending(false);
    }
  }
  return (
    <details className="rounded-xl border p-4">
      <summary className="cursor-pointer font-medium">Notification preferences</summary>
      <p className="my-3 text-sm text-muted-foreground">
        Applies to future events across this environment. Existing inbox history stays available.
        Slack options take effect when Slack integration is connected.
      </p>
      {(error || query.error) && (
        <p role="alert" className="text-destructive">
          {error ?? query.error}
        </p>
      )}
      {state ? (
        <fieldset disabled={pending} className="grid gap-5 sm:grid-cols-2">
          {NOTIFICATION_PREFERENCE_GROUPS.map((group) => (
            <div key={group.title} className="grid content-start gap-2">
              <h3 className="font-medium">{group.title}</h3>
              {group.entries.map((entry) => (
                <label key={entry.key} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={state.value.events[entry.key]}
                    onChange={(event) =>
                      void save({
                        ...state.value,
                        events: { ...state.value.events, [entry.key]: event.target.checked },
                      })
                    }
                  />
                  {entry.label}
                </label>
              ))}
            </div>
          ))}
          <div className="grid content-start gap-2">
            <h3 className="font-medium">Delivery</h3>
            {(
              [
                ["inApp", "In-app"],
                ["desktop", "Desktop"],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={state.value.delivery[key]}
                  onChange={(event) =>
                    void save({
                      ...state.value,
                      delivery: { ...state.value.delivery, [key]: event.target.checked },
                    })
                  }
                />
                {label}
              </label>
            ))}
            <p className="text-xs text-muted-foreground">
              Desktop alerts focus on input, completion, failures, and review decisions.
            </p>
            <Button variant="outline" onClick={() => void save(DEFAULT_NOTIFICATION_PREFERENCES)}>
              Restore defaults
            </Button>
          </div>
        </fieldset>
      ) : (
        <p>Loading preferences…</p>
      )}
      <DeviceNotificationControl />
    </details>
  );
}
function DeviceNotificationControl() {
  const mode = useClientSettings((s) => s.notificationMode);
  const update = useUpdateClientSettings();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  async function change(next: typeof mode) {
    setError(null);
    if (hasNotificationSound(next)) unlockNotificationAudio();
    if (
      (next === "notifications" || next === "notifications-and-sound") &&
      !window.desktopBridge?.showAppNotification
    ) {
      if (typeof Notification === "undefined" || !window.isSecureContext) {
        setError("Desktop alerts require a supported browser over HTTPS or the desktop app.");
        return;
      }
      setPending(true);
      try {
        if ((await Notification.requestPermission()) !== "granted") {
          setError(
            "Allow notifications in your browser or system settings to enable desktop alerts.",
          );
          return;
        }
      } catch {
        setError("Desktop notifications are unavailable on this device.");
        return;
      } finally {
        setPending(false);
      }
    }
    update({ notificationMode: next });
  }
  return (
    <div className="mt-5 grid gap-2 border-t pt-4">
      <label className="text-sm font-medium" htmlFor="device-notifications">
        Alerts on this device
      </label>
      <select
        id="device-notifications"
        className="rounded-lg border bg-background p-2 text-sm"
        value={mode}
        disabled={pending}
        onChange={(event) => void change(event.target.value as typeof mode)}
      >
        <option value="off">Off</option>
        <option value="notifications">Notifications only</option>
        <option value="sound">Sound only</option>
        <option value="notifications-and-sound">Notifications with sound</option>
      </select>
      <p className="text-xs text-muted-foreground">
        Desktop alerts appear while this client is connected and in the background. Your system may
        suppress them in Focus or Do Not Disturb mode.
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
