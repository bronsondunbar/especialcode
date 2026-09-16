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
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
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
    <div>
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
                  <Checkbox
                    disabled={pending}
                    checked={state.value.events[entry.key]}
                    onCheckedChange={(checked) =>
                      void save({
                        ...state.value,
                        events: { ...state.value.events, [entry.key]: checked },
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
                <Checkbox
                  disabled={pending}
                  checked={state.value.delivery[key]}
                  onCheckedChange={(checked) =>
                    void save({
                      ...state.value,
                      delivery: { ...state.value.delivery, [key]: checked },
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
        !query.error && <p>Loading preferences…</p>
      )}
    </div>
  );
}
