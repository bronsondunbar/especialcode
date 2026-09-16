import {
  WorkItem,
  WorkItemError,
  WorkItemListInput,
  WorkItemMutation,
  WorkItemDeleteInput,
  WORK_ITEM_MANUAL_STATUSES,
  type WorkItemExternalResource,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { makeWorkItemRepository } from "../persistence/WorkItems.ts";

const decodeWorkItem = Schema.decodeUnknownEffect(WorkItem);
const decodeDelete = Schema.decodeUnknownEffect(WorkItemDeleteInput);
const decodeMutation = Schema.decodeUnknownEffect(WorkItemMutation);
const decodeList = Schema.decodeUnknownEffect(WorkItemListInput);
const isWorkItemError = Schema.is(WorkItemError);
const encodeMetadata = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const invalid = (message: string) => new WorkItemError({ code: "invalid", message });
const conflict = (message: string) => new WorkItemError({ code: "conflict", message });
const sameResource = (a: WorkItemExternalResource, b: WorkItemExternalResource) =>
  a.source === b.source && a.namespace === b.namespace && a.externalId === b.externalId;

/** Object property order must not change the meaning of a retried command. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => {
    if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
      return Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)));
    }
    return entry;
  });
}

export const make = Effect.gen(function* () {
  const repository = yield* makeWorkItemRepository;
  const changes = yield* SubscriptionRef.make(0);
  const mapError = (error: unknown) =>
    isWorkItemError(error)
      ? error
      : new WorkItemError({
          code: "storage",
          message: "Could not access work items. Please retry.",
        });
  const validate = Effect.fn("WorkItemService.validate")(function* (
    item: WorkItem,
    current: WorkItem | null,
  ) {
    if (item.agentThreadId && !item.projectId)
      return yield* invalid("Assign a project before attaching a thread.");
    if (
      item.projectId &&
      (current?.projectId !== item.projectId || current?.agentThreadId !== item.agentThreadId) &&
      !(yield* repository.referenceExists(item.projectId, item.agentThreadId))
    ) {
      return yield* invalid(
        "The project or thread is unavailable, or the thread belongs to another project.",
      );
    }
    const visited = new Set<string>([item.id]);
    let parentId = item.parentWorkItemId;
    while (parentId !== null) {
      if (visited.has(parentId)) return yield* invalid("A work item cannot be its own ancestor.");
      visited.add(parentId);
      const parent = yield* repository.get(parentId);
      if (
        !parent ||
        (parent.archivedAt !== null && current?.parentWorkItemId !== item.parentWorkItemId) ||
        parent.projectId !== item.projectId
      ) {
        return yield* invalid("The parent must be an active work item in the same project.");
      }
      parentId = parent.parentWorkItemId;
    }
    const children = yield* repository.children(item.id);
    if (children.some((child) => child.project_id !== item.projectId)) {
      return yield* invalid("Reassign or detach child work items before changing this project.");
    }
    for (const resource of item.resources) {
      const owner = yield* repository.resourceOwner(resource);
      if (owner && owner !== item.id)
        return yield* conflict("This external resource is already attached to another work item.");
    }
  });
  const mutate = Effect.fn("WorkItemService.mutate")(
    function* (raw: WorkItemMutation) {
      const input = yield* decodeMutation(raw).pipe(
        Effect.mapError(() => invalid("Invalid work item command.")),
      );
      const request = canonicalJson(input);
      const result = yield* repository.transaction(
        Effect.gen(function* () {
          if (yield* repository.isDeleted(input.id))
            return yield* invalid("This task was permanently deleted.");
          if (
            (input.kind === "create" || input.kind === "attachResource") &&
            input.resource &&
            (yield* repository.isResourceDeleted(input.resource))
          )
            return yield* invalid("This source belonged to a permanently deleted task.");
          const receipt = yield* repository.receipt(input.commandId);
          if (receipt) {
            if (receipt.request !== request)
              return yield* conflict("This command ID was already used for a different change.");
            return { item: receipt.item, changed: false };
          }
          const current = yield* repository.get(input.id);
          const now = DateTime.formatIso(yield* DateTime.now);
          let item: WorkItem;
          if (input.kind === "create") {
            if (current) return yield* conflict("A work item with this ID already exists.");
            if (
              ["github_issue", "github_pr", "slack"].includes(input.source) &&
              input.resource?.source !== input.source
            ) {
              return yield* invalid("External work items require a matching source reference.");
            }
            item = {
              id: input.id,
              title: input.title,
              body: "",
              projectId: null,
              priority: "medium",
              repository: null,
              branch: null,
              assignedAgent: null,
              agentThreadId: null,
              parentWorkItemId: null,
              failureReason: null,
              ...input.fields,
              source: input.source,
              resources: input.resource ? [input.resource] : [],
              externalId: input.resource?.externalId ?? null,
              externalUrl: input.resource?.url ?? null,
              status: "inbox",
              revision: 1,
              createdAt: now,
              updatedAt: now,
              completedAt: null,
              archivedAt: null,
            };
          } else {
            if (!current)
              return yield* new WorkItemError({
                code: "not_found",
                message: "Work item not found.",
              });
            if (current.revision !== input.expectedRevision)
              return yield* conflict(
                "This work item changed on another client. Refresh it before saving.",
              );
            if (current.archivedAt && input.kind !== "archive")
              return yield* invalid("Restore this work item before editing it.");
            if (["planning", "awaiting_approval", "running"].includes(current.status)) {
              return yield* invalid("Use the agent workflow to change an active work item.");
            }
            item = { ...current, revision: current.revision + 1, updatedAt: now };
            switch (input.kind) {
              case "update":
                item = { ...item, ...input.patch };
                break;
              case "archive":
                item = { ...item, archivedAt: input.archived ? now : null };
                break;
              case "status": {
                if (!WORK_ITEM_MANUAL_STATUSES.some((status) => status === input.status)) {
                  return yield* invalid("Planning and execution states require an agent workflow.");
                }
                if (
                  (current.status === "done" || current.status === "cancelled") &&
                  input.status !== current.status &&
                  !["inbox", "backlog", "ready"].includes(input.status)
                ) {
                  return yield* invalid(
                    "Reopen this work item into Inbox, Backlog or Ready first.",
                  );
                }
                if (input.status === "blocked" && !input.reason && !item.failureReason)
                  return yield* invalid("Explain why this work item is blocked.");
                item = {
                  ...item,
                  status: input.status,
                  completedAt: input.status === "done" ? (current.completedAt ?? now) : null,
                  failureReason:
                    input.status === "blocked" ? (input.reason ?? item.failureReason) : null,
                };
                break;
              }
              case "attachResource": {
                const resources = item.resources.filter(
                  (resource) => !sameResource(resource, input.resource),
                );
                if (resources.length >= 50)
                  return yield* invalid("A work item can have at most 50 external resources.");
                item = { ...item, resources: [...resources, input.resource] };
                break;
              }
              case "detachResource":
                item = {
                  ...item,
                  resources: item.resources.filter(
                    (resource) => !sameResource(resource, input.resource),
                  ),
                };
                break;
            }
            item = {
              ...item,
              externalId: item.resources[0]?.externalId ?? null,
              externalUrl: item.resources[0]?.url ?? null,
            };
          }
          if (item.status === "blocked" && !item.failureReason)
            return yield* invalid("A blocked work item needs a reason.");
          yield* validate(item, current);
          yield* repository.save(item);
          yield* repository.record(
            input.commandId,
            request,
            `work_item.${input.kind}`,
            item,
            encodeMetadata({
              previousStatus: current?.status ?? null,
              status: item.status,
              projectId: item.projectId,
              fields: input.kind === "update" ? Object.keys(input.patch) : [],
            }),
          );
          return { item, changed: true };
        }),
      );
      if (result.changed) yield* SubscriptionRef.update(changes, (value) => value + 1);
      return result.item;
    },
    Effect.mapError(mapError),
    Effect.uninterruptible,
  );
  const deleteArchived = Effect.fn("WorkItemService.deleteArchived")(
    function* (raw: WorkItemDeleteInput) {
      const input = yield* decodeDelete(raw).pipe(
        Effect.mapError(() => invalid("Invalid task deletion.")),
      );
      const changed = yield* repository.transaction(
        Effect.gen(function* () {
          const receipts = yield* repository.deletedReceipt(input.id, input.commandId);
          if (receipts.length) {
            if (
              receipts.length === 1 &&
              receipts[0]!.id === input.id &&
              receipts[0]!.command_id === input.commandId &&
              receipts[0]!.revision === input.expectedRevision
            )
              return false;
            return yield* conflict(
              "This task was already deleted or the command was used for another deletion.",
            );
          }
          const item = yield* repository.get(input.id);
          if (!item)
            return yield* new WorkItemError({ code: "not_found", message: "Work item not found." });
          if (item.revision !== input.expectedRevision)
            return yield* conflict("This task changed. Refresh Archived before deleting it.");
          if (
            !item.archivedAt ||
            ["planning", "awaiting_approval", "running"].includes(item.status)
          )
            return yield* invalid("Only archived, inactive tasks can be deleted.");
          const now = DateTime.formatIso(yield* DateTime.now);
          const children = yield* repository.childItems(item.id);
          for (const [index, child] of children.entries()) {
            const detached = {
              ...child,
              parentWorkItemId: null,
              revision: child.revision + 1,
              updatedAt: now,
            };
            yield* repository.save(detached);
            yield* repository.record(
              `${input.commandId}:detach:${index}`,
              canonicalJson({ deletedParentId: item.id }),
              "work_item.update",
              detached,
              encodeMetadata({ fields: ["parentWorkItemId"] }),
            );
          }
          yield* repository.remove(item, input.commandId);
          return true;
        }),
      );
      if (changed) yield* SubscriptionRef.update(changes, (n) => n + 1);
    },
    Effect.mapError(mapError),
    Effect.uninterruptible,
  );
  const list = Effect.fn("WorkItemService.list")(function* (raw: WorkItemListInput) {
    const input = yield* decodeList(raw).pipe(
      Effect.mapError(() => invalid("Invalid work item filters.")),
    );
    return yield* repository.list(input);
  }, Effect.mapError(mapError));
  const get = Effect.fn("WorkItemService.get")(function* (id: string) {
    const item = yield* repository.get(id);
    if (!item)
      return yield* new WorkItemError({ code: "not_found", message: "Work item not found." });
    return item;
  }, Effect.mapError(mapError));
  // An external refresh may only change fields still equal to the previous source snapshot.
  // Active/archived work keeps the context it was started with.
  const refreshExternal = Effect.fn("WorkItemService.refreshExternal")(
    function* (
      resource: WorkItemExternalResource,
      previous: { readonly title: string; readonly body: string },
      next: { readonly title: string; readonly body: string },
    ) {
      const changed = yield* repository.transaction(
        Effect.gen(function* () {
          const owner = yield* repository.resourceOwner(resource);
          const current = owner ? yield* repository.get(owner) : null;
          if (
            !current ||
            current.source !== resource.source ||
            !current.resources[0] ||
            !sameResource(current.resources[0], resource) ||
            current.archivedAt ||
            ["planning", "awaiting_approval", "running"].includes(current.status)
          )
            return false;
          const title = current.title === previous.title ? next.title : current.title;
          const body = current.body === previous.body ? next.body : current.body;
          if (title === current.title && body === current.body) return false;
          const item = yield* decodeWorkItem({
            ...current,
            title,
            body,
            revision: current.revision + 1,
            updatedAt: DateTime.formatIso(yield* DateTime.now),
          });
          const commandId = `external-refresh:${item.id}:${item.revision}`;
          yield* repository.save(item);
          yield* repository.record(
            commandId,
            canonicalJson({ resource, previous, next }),
            "work_item.external_refreshed",
            item,
            encodeMetadata({
              fields: [
                title !== current.title ? "title" : null,
                body !== current.body ? "body" : null,
              ].filter(Boolean),
            }),
          );
          return true;
        }),
      );
      if (changed) yield* SubscriptionRef.update(changes, (n) => n + 1);
    },
    Effect.mapError(mapError),
    Effect.uninterruptible,
  );
  const findByResource = Effect.fn("WorkItemService.findByResource")(function* (
    resource: WorkItemExternalResource,
  ) {
    const owner = yield* repository.resourceOwner(resource);
    return owner ? yield* repository.get(owner) : null;
  }, Effect.mapError(mapError));
  return {
    findByResource,
    deleteArchived,
    isResourceDeleted: (resource: WorkItemExternalResource) =>
      repository.isResourceDeleted(resource).pipe(Effect.mapError(mapError)),
    refreshExternal,
    changes: SubscriptionRef.changes(changes),
    notifyChange: SubscriptionRef.update(changes, (n) => n + 1),
    mutate,
    list,
    get,
    subscribe: (input: WorkItemListInput) =>
      SubscriptionRef.changes(changes).pipe(Stream.mapEffect(() => list(input))),
  };
});

export class WorkItemService extends Context.Service<
  WorkItemService,
  Effect.Success<typeof make>
>()("t3/workItems/WorkItemService") {
  static readonly layer = Layer.effect(WorkItemService, make);
}
