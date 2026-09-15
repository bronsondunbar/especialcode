import * as DateTime from "effect/DateTime";
import { expect, it } from "vite-plus/test";
import type { AppNotification } from "@t3tools/contracts";
import { consumeNotificationPage, claimNotificationDelivery } from "./notificationDelivery.ts";
const now = Date.parse("2026-09-15T12:00:00.000Z");
const item = (sequence: number, createdAt = now): AppNotification => ({
  id: String(sequence),
  sequence,
  source: "agents",
  type: "agent_input_required",
  title: "Input",
  message: "Choose",
  userId: null,
  projectId: null,
  workItemId: null,
  action: null,
  priority: "attention",
  readAt: null,
  createdAt: DateTime.formatIso(DateTime.makeUnsafe(createdAt)),
});
const page = (items: AppNotification[], latestSequence = 500) => ({
  items,
  latestSequence,
  total: items.length,
  unreadCount: items.length,
});
it("baselines initial history and ignores read, stale, and previously delivered alerts", () => {
  expect(consumeNotificationPage(null, page([item(1)]), now)).toEqual({ cursor: 500, items: [] });
  const result = consumeNotificationPage(
    10,
    page([
      item(9),
      item(11, now - 121000),
      { ...item(12), readAt: DateTime.formatIso(DateTime.makeUnsafe(now)) },
      item(13),
    ]),
    now,
  );
  expect(result.items.map((row) => row.sequence)).toEqual([13]);
  expect(result.cursor).toBe(500);
});
it("drains full pages without skipping events and never moves its cursor backwards", () => {
  const result = consumeNotificationPage(
    0,
    page(Array.from({ length: 100 }, (_, i) => item(i + 1))),
    now,
  );
  expect(result.cursor).toBe(100);
  expect(result.items).toHaveLength(100);
  expect(consumeNotificationPage(100, page([item(101)], 500), now).cursor).toBe(500);
  expect(consumeNotificationPage(500, page([item(1)], 1), now)).toEqual({ cursor: 500, items: [] });
});

it("deduplicates browser claims without silencing a restored database's new event IDs", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  expect(claimNotificationDelivery(storage, "env", "old-id")).toBe(true);
  expect(claimNotificationDelivery(storage, "env", "old-id")).toBe(false);
  expect(claimNotificationDelivery(storage, "env", "restored-id")).toBe(true);
  expect(claimNotificationDelivery(storage, "other-env", "old-id")).toBe(true);
  values.set("env", "broken");
  expect(claimNotificationDelivery(storage, "env", "new-id")).toBe(true);
  for (let i = 0; i < 250; i++) claimNotificationDelivery(storage, "env", String(i));
  expect(JSON.parse(values.get("env")!)).toHaveLength(200);
});
