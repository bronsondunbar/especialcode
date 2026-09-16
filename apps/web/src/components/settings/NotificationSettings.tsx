import { Link } from "@tanstack/react-router";
import { useState } from "react";
import type { EnvironmentId } from "@t3tools/contracts";

import {
  hasDesktopNotifications,
  hasNotificationSound,
  NOTIFICATION_MODE_LABELS,
  unlockNotificationAudio,
} from "../../threadNotifications";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { NotificationPreferencesPanel } from "./NotificationPreferencesPanel";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

export function NotificationSettings() {
  const mode = useScopedSettings((settings) => settings.notificationMode);
  const updateSettings = useUpdateScopedSettings();
  const [permissionMessage, setPermissionMessage] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);

  return (
    <>
      <SettingsRow
        {...searchableSetting("notification-inbox")}
        description="View saved alerts and manage which notifications are read."
        control={
          <Button variant="outline" size="sm" render={<Link to="/notifications" />}>
            Open inbox
          </Button>
        }
      />
      <NotificationPreferencesSetting />
      <SettingsRow
        {...searchableSetting("thread-notifications")}
        description={
          permissionMessage ??
          "System alerts when a thread finishes, fails, or needs input or approval. Applies to this device while T3 Code is open."
        }
        control={
          <Select
            value={mode}
            disabled={requesting}
            onValueChange={async (value) => {
              if (
                value !== "off" &&
                value !== "notifications" &&
                value !== "sound" &&
                value !== "notifications-and-sound"
              )
                return;
              setPermissionMessage(null);
              if (hasNotificationSound(value)) unlockNotificationAudio();
              if (hasDesktopNotifications(value) && !window.desktopBridge?.showAppNotification) {
                if (typeof Notification === "undefined" || !window.isSecureContext) {
                  setPermissionMessage(
                    "Notifications need a supported browser over HTTPS, or the desktop app. Sound only is still available.",
                  );
                  return;
                }
                setRequesting(true);
                try {
                  const permission = await Notification.requestPermission();
                  if (permission !== "granted") {
                    setPermissionMessage(
                      "Allow notifications in your browser or system settings, then choose this option again. Sound only is still available.",
                    );
                    return;
                  }
                } catch {
                  setPermissionMessage(
                    "Notifications are unavailable in this browser. Sound only is still available.",
                  );
                  return;
                } finally {
                  setRequesting(false);
                }
              }
              updateSettings({ notificationMode: value });
            }}
          >
            <SelectTrigger size="sm" className="w-full sm:w-56" aria-label="Thread notifications">
              <SelectValue>{NOTIFICATION_MODE_LABELS[mode]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {Object.entries(NOTIFICATION_MODE_LABELS).map(([value, label]) => (
                <SelectItem key={value} hideIndicator value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
    </>
  );
}

function NotificationPreferencesSetting() {
  const { environment, connectedEnvironments } = useSettingsScope();
  const supported = connectedEnvironments.filter(
    (entry) => entry.serverConfig?.environment.capabilities.notificationPreferences === true,
  );
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<EnvironmentId | null>(null);
  const selected =
    supported.find((entry) => entry.environmentId === selectedId) ??
    supported.find((entry) => entry.environmentId === environment?.environmentId) ??
    supported[0];
  return (
    <>
      <SettingsRow
        {...searchableSetting("notification-preferences")}
        description={
          selected
            ? "Choose agent, GitHub, and Slack alerts and how this server delivers them."
            : "Connect to a server with notification preferences to manage alerts."
        }
        control={
          <Button variant="outline" size="sm" disabled={!selected} onClick={() => setOpen(true)}>
            Manage preferences
          </Button>
        }
      />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup className="max-w-2xl">
          <DialogTitle>Notification preferences</DialogTitle>
          {supported.length > 1 && selected ? (
            <div className="mt-4">
              <Select
                value={selected.environmentId}
                onValueChange={(value) => {
                  const next = supported.find((entry) => entry.environmentId === value);
                  if (next) setSelectedId(next.environmentId);
                }}
              >
                <SelectTrigger aria-label="Notification server">
                  <SelectValue>{selected.label}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {supported.map((entry) => (
                    <SelectItem key={entry.environmentId} value={entry.environmentId}>
                      {entry.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
          ) : null}
          {open && selected ? (
            <NotificationPreferencesPanel
              key={selected.environmentId}
              environmentId={selected.environmentId}
            />
          ) : null}
        </DialogPopup>
      </Dialog>
    </>
  );
}
