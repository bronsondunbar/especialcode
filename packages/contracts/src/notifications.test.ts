import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  NotificationAction,
  NotificationListInput,
  NotificationMutation,
} from "./notifications.ts";
describe("notification wire boundaries", () => {
  it("bounds pages and rejects invalid cursors", () => {
    const list = Schema.is(NotificationListInput);
    expect(list({ limit: 100, offset: 0, filter: "attention" })).toBe(true);
    for (const input of [
      { limit: 101 },
      { limit: 0 },
      { offset: -1 },
      { offset: Infinity },
      { filter: "unknown" },
    ])
      expect(list(input)).toBe(false);
    const mutate = Schema.is(NotificationMutation);
    expect(mutate({ kind: "read_all", throughSequence: 0 })).toBe(true);
    expect(mutate({ kind: "read_all", throughSequence: NaN })).toBe(false);
    expect(mutate({ kind: "read", id: "", read: true })).toBe(false);
  });
  it("accepts only typed navigation targets", () => {
    const action = Schema.is(NotificationAction);
    expect(action({ kind: "agent", threadId: "thread" })).toBe(true);
    expect(action({ kind: "work_item", workItemId: "task" })).toBe(true);
    expect(action({ kind: "changes", threadId: "thread" })).toBe(true);
    expect(action({ kind: "url", url: "javascript:alert(1)" })).toBe(false);
    expect(action({ kind: "command", command: "run" })).toBe(false);
  });
});
