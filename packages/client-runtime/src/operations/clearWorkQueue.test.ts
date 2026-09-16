import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  WorkItemId,
  WorkItemSummary,
  WorkItemError,
  WS_METHODS,
  type WorkItemListInput,
  type WorkItemDeleteInput,
  type WorkItemMutation,
  type WorkItemStatus,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { clearWorkQueue, previewClearWorkQueue } from "./clearWorkQueue.ts";

function item(index: number, status: WorkItemStatus = "inbox") {
  return WorkItemSummary.make({
    id: WorkItemId.make(`task-${index}`),
    title: `Task ${index}`,
    bodyPreview: "",
    projectId: null,
    priority: "medium",
    repository: null,
    branch: null,
    assignedAgent: null,
    agentThreadId: null,
    parentWorkItemId: null,
    failureReason: null,
    source: "manual",
    externalId: null,
    externalUrl: null,
    resources: [],
    status,
    revision: 1,
    createdAt: "2026-09-16T00:00:00Z",
    updatedAt: "2026-09-16T00:00:00Z",
    completedAt: null,
    archivedAt: null,
  });
}
const setup = Effect.fn("TestClearWorkQueue.setup")(function* (
  initial: WorkItemSummary[],
  failPage?: number,
) {
  const items = new Map(initial.map((item) => [item.id, item]));
  const reads: WorkItemListInput[] = [];
  const mutations: WorkItemMutation[] = [];
  const deletions: WorkItemDeleteInput[] = [];
  const receipts = new Set<string>();
  const client = {
    [WS_METHODS.workItemsList]: (input: WorkItemListInput) =>
      Effect.gen(function* () {
        reads.push(input);
        if (input.offset === failPage)
          return yield* new WorkItemError({ code: "storage", message: "Offline" });
        const active = [...items.values()].filter((item) => !!item.archivedAt === !!input.archived);
        return {
          items: active.slice(input.offset ?? 0, (input.offset ?? 0) + (input.limit ?? 100)),
          total: active.length,
        };
      }),
    [WS_METHODS.workItemsDelete]: (input: WorkItemDeleteInput) =>
      Effect.gen(function* () {
        deletions.push(input);
        const current = items.get(input.id)!;
        if (!current.archivedAt || current.revision !== input.expectedRevision)
          return yield* new WorkItemError({ code: "conflict", message: "Task changed" });
        // A parent deleted too early would change a confirmed child's revision.
        for (const child of items.values())
          if (child.parentWorkItemId === current.id)
            items.set(child.id, { ...child, parentWorkItemId: null, revision: child.revision + 1 });
        items.delete(input.id);
      }),
    [WS_METHODS.workItemsMutate]: (input: WorkItemMutation) =>
      Effect.gen(function* () {
        mutations.push(input);
        const current = items.get(input.id)!;
        if (receipts.has(input.commandId)) return current;
        if (input.kind !== "archive" || input.expectedRevision !== current.revision)
          return yield* new WorkItemError({ code: "conflict", message: "Task changed" });
        const archived = {
          ...current,
          archivedAt: "2026-09-16T01:00:00Z",
          revision: current.revision + 1,
        };
        items.set(input.id, archived);
        receipts.add(input.commandId);
        return archived;
      }),
  } as unknown as WsRpcProtocolClient;
  const session: RpcSession = {
    client,
    initialConfig: Effect.never,
    subscribeServerConfig: (input) => client.subscribeServerConfig(input),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
  const supervisor = EnvironmentSupervisor.of({
    target: new PrimaryConnectionTarget({
      environmentId: EnvironmentId.make("remote"),
      label: "Remote",
      httpBaseUrl: "https://remote.example.test",
      wsBaseUrl: "wss://remote.example.test",
    }),
    state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
    session: yield* SubscriptionRef.make(Option.some(session)),
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  return {
    items,
    reads,
    mutations,
    deletions,
    provide: Effect.provideService(EnvironmentSupervisor, supervisor),
  };
});

describe("clear work queue", () => {
  it.effect("deletes only confirmed archived tasks, children before parents across pages", () =>
    Effect.gen(function* () {
      const parent = { ...item(0), archivedAt: "now" };
      const child = { ...item(101), archivedAt: "now", parentWorkItemId: parent.id };
      const harness = yield* setup([
        parent,
        ...Array.from({ length: 100 }, (_, i) => ({ ...item(i + 1), archivedAt: "now" })),
        child,
        item(102),
      ]);
      const preview = yield* previewClearWorkQueue({ archived: true }).pipe(harness.provide);
      const arrived = { ...item(103), archivedAt: "later" };
      harness.items.set(arrived.id, arrived);
      expect(preview.tasks).toHaveLength(102);
      expect(
        yield* clearWorkQueue({ preview, commandId: "delete", archived: true }).pipe(
          harness.provide,
        ),
      ).toEqual({ cleared: 102, error: null });
      expect(harness.mutations).toHaveLength(0);
      expect(harness.deletions).toHaveLength(102);
      expect(harness.items.has(item(102).id)).toBe(true);
      expect(harness.items.has(arrived.id)).toBe(true);
    }),
  );

  it.effect(
    "reads all pages before clearing and leaves active workflows and archived tasks alone",
    () =>
      Effect.gen(function* () {
        const existingArchived = { ...item(200), archivedAt: "2026-09-15T00:00:00Z" };
        const harness = yield* setup([
          ...Array.from({ length: 105 }, (_, i) => item(i)),
          item(105, "planning"),
          item(106, "running"),
          item(107, "awaiting_approval"),
          existingArchived,
        ]);
        const preview = yield* previewClearWorkQueue().pipe(harness.provide);
        expect(preview.tasks).toHaveLength(105);
        expect(preview.active).toBe(3);
        expect(harness.mutations).toHaveLength(0);
        expect(harness.reads).toEqual([
          { archived: false, offset: 0, limit: 100 },
          { archived: false, offset: 100, limit: 100 },
        ]);
        const result = yield* clearWorkQueue({ preview, commandId: "clear-1" }).pipe(
          harness.provide,
        );
        expect(result).toEqual({ cleared: 105, error: null });
        expect([...harness.items.values()].filter((item) => !item.archivedAt)).toHaveLength(3);
        expect(harness.items.get(existingArchived.id)).toEqual(existingArchived);
        expect(
          harness.mutations.every((command) => command.kind === "archive" && command.archived),
        ).toBe(true);
      }),
  );
  it.effect("does not clear newly arrived tasks that were not in the confirmation", () =>
    Effect.gen(function* () {
      const harness = yield* setup([item(1)]);
      const preview = yield* previewClearWorkQueue().pipe(harness.provide);
      const added = item(2);
      harness.items.set(added.id, added);
      yield* clearWorkQueue({ preview, commandId: "clear-1" }).pipe(harness.provide);
      expect(harness.items.get(added.id)).toEqual(added);
    }),
  );
  it.effect("stops on a changed task and reports the partial result without overwriting it", () =>
    Effect.gen(function* () {
      const harness = yield* setup([item(1), item(2), item(3)]);
      const preview = yield* previewClearWorkQueue().pipe(harness.provide);
      const changed = { ...item(2, "running"), revision: 2 };
      harness.items.set(changed.id, changed);
      const result = yield* clearWorkQueue({ preview, commandId: "clear-1" }).pipe(harness.provide);
      expect(result).toEqual({ cleared: 1, error: "Task changed" });
      expect(harness.items.get(changed.id)).toEqual(changed);
      expect(harness.items.get(item(3).id)?.archivedAt).toBeNull();
    }),
  );
  it.effect("does not offer a partial preview if a later page fails", () =>
    Effect.gen(function* () {
      const harness = yield* setup(
        Array.from({ length: 101 }, (_, i) => item(i)),
        100,
      );
      expect((yield* previewClearWorkQueue().pipe(harness.provide, Effect.result))._tag).toBe(
        "Failure",
      );
      expect(harness.mutations).toHaveLength(0);
    }),
  );
  it.effect("supports an empty queue and idempotent replay of a confirmed clear", () =>
    Effect.gen(function* () {
      const empty = yield* setup([]);
      const preview = yield* previewClearWorkQueue().pipe(empty.provide);
      expect(yield* clearWorkQueue({ preview, commandId: "empty" }).pipe(empty.provide)).toEqual({
        cleared: 0,
        error: null,
      });
      expect(empty.mutations).toHaveLength(0);
      const harness = yield* setup([item(1)]);
      const confirmed = yield* previewClearWorkQueue().pipe(harness.provide);
      yield* clearWorkQueue({ preview: confirmed, commandId: "retry" }).pipe(harness.provide);
      expect(
        yield* clearWorkQueue({ preview: confirmed, commandId: "retry" }).pipe(harness.provide),
      ).toEqual({ cleared: 1, error: null });
      expect(harness.mutations[0]).toEqual(harness.mutations[1]);
    }),
  );
});
