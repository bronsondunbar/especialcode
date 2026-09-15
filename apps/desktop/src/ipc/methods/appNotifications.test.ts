import { beforeEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId, type DesktopAppNotification } from "@t3tools/contracts";
const native = vi.hoisted(() => ({
  supported: true,
  focused: false,
  destroyed: false,
  minimized: true,
  throws: false,
  restore: vi.fn(),
  show: vi.fn(),
  focus: vi.fn(),
  send: vi.fn(),
  alerts: [] as {
    show: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    listeners: Map<string, () => void>;
  }[],
}));
vi.mock("electron", () => ({
  webContents: { fromId: (id: number) => (id === 1 ? {} : null) },
  BrowserWindow: {
    getFocusedWindow: () => (native.focused ? {} : null),
    fromWebContents: () => ({
      isDestroyed: () => native.destroyed,
      isMinimized: () => native.minimized,
      restore: native.restore,
      show: native.show,
      focus: native.focus,
      webContents: { send: native.send },
    }),
  },
  Notification: class {
    static isSupported() {
      return native.supported;
    }
    listeners = new Map<string, () => void>();
    show = vi.fn(() => {
      if (native.throws) throw new Error("OS rejected");
    });
    close = vi.fn(() => this.listeners.get("close")?.());
    on(name: string, listener: () => void) {
      this.listeners.set(name, listener);
      return this;
    }
    constructor() {
      native.alerts.push(this);
    }
  },
}));
import { createAppNotificationPresenter } from "./appNotifications.ts";
const payload: DesktopAppNotification = {
  id: "event",
  environmentId: EnvironmentId.make("env"),
  title: "Input needed",
  message: "Choose",
  action: { kind: "agent", threadId: ThreadId.make("thread") },
};
beforeEach(() => {
  vi.clearAllMocks();
  native.supported = true;
  native.focused = false;
  native.destroyed = false;
  native.minimized = true;
  native.throws = false;
  native.alerts.length = 0;
});
it("restores the owning window and forwards the exact typed action on click", () => {
  const presenter = createAppNotificationPresenter();
  expect(presenter.show(payload, 1)).toBe(true);
  native.alerts[0]!.listeners.get("click")!();
  expect(native.restore).toHaveBeenCalledOnce();
  expect(native.show).toHaveBeenCalledOnce();
  expect(native.focus).toHaveBeenCalledOnce();
  expect(native.send).toHaveBeenCalledWith("desktop:app-notification-click", payload);
});
it("deduplicates by environment and event even after the OS alert closes", () => {
  const presenter = createAppNotificationPresenter();
  expect(presenter.show(payload, 1)).toBe(true);
  presenter.clear();
  expect(presenter.show(payload, 1)).toBe(false);
  expect(presenter.show({ ...payload, environmentId: EnvironmentId.make("other") }, 1)).toBe(true);
});
it("ignores unsupported, focused, destroyed, and unknown renderer windows", () => {
  const presenter = createAppNotificationPresenter();
  expect(presenter.show(payload, 2)).toBe(false);
  native.supported = false;
  expect(presenter.show(payload, 1)).toBe(false);
  native.supported = true;
  native.focused = true;
  expect(presenter.show(payload, 1)).toBe(false);
  native.focused = false;
  native.destroyed = true;
  expect(presenter.show(payload, 1)).toBe(false);
  expect(native.alerts).toHaveLength(0);
});
it("contains OS failures and limits closing to the originating renderer", () => {
  const presenter = createAppNotificationPresenter();
  native.throws = true;
  expect(presenter.show(payload, 1)).toBe(false);
  native.throws = false;
  expect(presenter.show(payload, 1)).toBe(true);
  presenter.close("env:event", 2);
  expect(native.alerts[1]!.close).not.toHaveBeenCalled();
  presenter.close("env:event", 1);
  expect(native.alerts[1]!.close).toHaveBeenCalledOnce();
});
