import * as Electron from "electron";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { DesktopAppNotification } from "@t3tools/contracts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as ElectronApp from "../../electron/ElectronApp.ts";
import {
  SHOW_APP_NOTIFICATION_CHANNEL,
  CLOSE_APP_NOTIFICATION_CHANNEL,
  APP_NOTIFICATION_CLICK_CHANNEL,
} from "../channels.ts";

/** Keeps OS notifications alive and deduplicates delivery across renderer windows. */
export function createAppNotificationPresenter() {
  const pending = new Map<string, { notification: Electron.Notification; owner: number }>();
  const delivered = new Set<string>();
  const close = (key: string, owner?: number) => {
    const entry = pending.get(key);
    if (!entry || (owner !== undefined && entry.owner !== owner)) return;
    pending.delete(key);
    entry.notification.close();
  };
  return {
    close,
    clear: () => {
      for (const key of pending.keys()) close(key);
    },
    show: (payload: DesktopAppNotification, senderId: number): boolean => {
      const key = `${payload.environmentId}:${payload.id}`;
      const contents = Electron.webContents.fromId(senderId);
      const window = contents ? Electron.BrowserWindow.fromWebContents(contents) : null;
      if (
        !window ||
        window.isDestroyed() ||
        Electron.BrowserWindow.getFocusedWindow() ||
        !Electron.Notification.isSupported() ||
        delivered.has(key)
      )
        return false;
      try {
        const notification = new Electron.Notification({
          title: payload.title,
          body: payload.message,
          silent: true,
        });
        notification.on("click", () => {
          close(key);
          if (window.isDestroyed()) return;
          if (window.isMinimized()) window.restore();
          window.show();
          window.focus();
          window.webContents.send(APP_NOTIFICATION_CLICK_CHANNEL, payload);
        });
        notification.on("close", () => {
          if (pending.get(key)?.notification === notification) pending.delete(key);
        });
        notification.on("failed", () => {
          if (pending.get(key)?.notification === notification) {
            pending.delete(key);
            delivered.delete(key);
          }
        });
        pending.set(key, { notification, owner: senderId });
        delivered.add(key);
        while (pending.size > 100) close(pending.keys().next().value!);
        while (delivered.size > 1000) delivered.delete(delivered.values().next().value!);
        notification.show();
        return true;
      } catch {
        pending.delete(key);
        delivered.delete(key);
        return false;
      }
    },
  };
}
export const installAppNotifications = Effect.fn("desktop.ipc.installAppNotifications")(
  function* () {
    const ipc = yield* DesktopIpc.DesktopIpc;
    const app = yield* ElectronApp.ElectronApp;
    const presenter = createAppNotificationPresenter();
    yield* ipc.handle(
      DesktopIpc.makeIpcMethod({
        channel: SHOW_APP_NOTIFICATION_CHANNEL,
        payload: DesktopAppNotification,
        result: Schema.Boolean,
        handler: (payload, event) =>
          Effect.sync(() => (event ? presenter.show(payload, event.sender.id) : false)),
      }),
    );
    yield* ipc.handle(
      DesktopIpc.makeIpcMethod({
        channel: CLOSE_APP_NOTIFICATION_CHANNEL,
        payload: Schema.String.check(Schema.isMaxLength(1100)),
        result: Schema.Void,
        handler: (key, event) =>
          Effect.sync(() => {
            if (event) presenter.close(key, event.sender.id);
          }),
      }),
    );
    yield* app.on("browser-window-focus", presenter.clear);
    yield* app.on("before-quit", presenter.clear);
    yield* Effect.addFinalizer(() => Effect.sync(presenter.clear));
  },
);
