import {
  CommandId,
  MessageId,
  ThreadId,
  WorkPlan,
  WorkPlanMutation,
  WorkPlanError,
  type WorkItem,
  type WorkItemId,
  type WorkPlanContent,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { makeWorkItemRepository } from "../persistence/WorkItems.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { WorkItemService } from "./WorkItemService.ts";
import { WorkPlanGenerator } from "./WorkPlanGenerator.ts";
const encodePlan = Schema.encodeSync(Schema.fromJsonString(WorkPlan));
const decodePlan = Schema.decodeUnknownEffect(Schema.fromJsonString(WorkPlan));
const decodeMutation = Schema.decodeUnknownEffect(WorkPlanMutation);
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const isPlanError = Schema.is(WorkPlanError);
const error = (code: WorkPlanError["code"], message: string) =>
  new WorkPlanError({ code, message });
const mapError = (cause: unknown) =>
  isPlanError(cause)
    ? cause
    : error("storage", "Could not update the work plan. Refresh and retry.");
function requestKey(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    entry !== null && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)))
      : entry,
  );
}
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const scope = yield* Scope.Scope;
  const work = yield* WorkItemService;
  const repository = yield* makeWorkItemRepository;
  const generator = yield* WorkPlanGenerator;
  const engine = yield* OrchestrationEngineService;
  const fibers = new Map<string, Fiber.Fiber<void, never>>();
  const read = Effect.fn("WorkPlanService.read")(function* (id: WorkItemId) {
    const rows = yield* sql<{
      record_json: string;
    }>`SELECT record_json FROM work_item_plans WHERE work_item_id=${id}`;
    return rows[0] ? yield* decodePlan(rows[0].record_json) : null;
  });
  const save = Effect.fn("WorkPlanService.save")(function* (
    plan: WorkPlan,
    item: WorkItem,
    commandId: string,
    kind: string,
  ) {
    yield* sql`INSERT INTO work_item_plans(work_item_id, record_json) VALUES (${item.id}, ${encodePlan(plan)}) ON CONFLICT(work_item_id) DO UPDATE SET record_json=excluded.record_json`;
    yield* sql`INSERT INTO work_item_plan_history(work_item_id, revision, record_json) VALUES (${item.id}, ${plan.revision}, ${encodePlan(plan)})`;
    yield* repository.save(item);
    yield* repository.record(
      commandId,
      encode({ planRevision: plan.revision }),
      `work_item.plan_${kind}`,
      item,
      encode({ planRevision: plan.revision, status: plan.status }),
    );
  });
  const finish = Effect.fn("WorkPlanService.finish")(
    function* (
      id: WorkItemId,
      generationId: string,
      result: { content: WorkPlanContent; inspectedFiles: ReadonlyArray<string> } | string,
    ) {
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const plan = yield* read(id);
          const item = yield* repository.get(id);
          if (!plan || !item || plan.generationId !== generationId || plan.status !== "generating")
            return;
          const now = DateTime.formatIso(yield* DateTime.now);
          const failed = typeof result === "string";
          yield* save(
            {
              ...plan,
              revision: plan.revision + 1,
              status: failed ? "failed" : "draft",
              updatedAt: now,
              generatedAt: failed ? null : now,
              error: failed ? result : null,
              content: failed ? null : result.content,
              inspectedFiles: failed ? [] : result.inspectedFiles,
            },
            {
              ...item,
              status: failed ? "ready" : "awaiting_approval",
              failureReason: failed ? result : null,
              revision: item.revision + 1,
              updatedAt: now,
            },
            `plan-finish:${generationId}`,
            failed ? "failed" : "generated",
          );
        }),
      );
      yield* work.notifyChange;
    },
    Effect.mapError(mapError),
    Effect.uninterruptible,
  );
  // A provider call cannot be safely replayed after process loss. Preserve its record and require a deliberate retry.
  const pending = yield* sql<{
    record_json: string;
  }>`SELECT record_json FROM work_item_plans WHERE json_extract(record_json, '$.status')='generating'`;
  for (const row of pending) {
    const plan = yield* decodePlan(row.record_json);
    yield* finish(
      plan.workItemId,
      plan.generationId,
      "Planning was interrupted by a server restart. Regenerate to try again.",
    );
  }
  const run = Effect.fn("WorkPlanService.run")(function* (
    plan: WorkPlan,
    item: WorkItem,
    project: { title: string; workspace_root: string },
    feedback: string,
  ) {
    yield* engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`plan-thread:${plan.generationId}`),
      threadId: plan.threadId,
      projectId: item.projectId!,
      title: `Plan: ${item.title}`,
      modelSelection: plan.modelSelection,
      runtimeMode: "approval-required",
      interactionMode: "plan",
      branch: item.branch,
      worktreePath: null,
      createdAt: plan.createdAt,
      historyImport: true,
    });
    const issues = yield* sql<{
      record_json: string;
    }>`SELECT i.record_json FROM github_issues i JOIN work_item_resources r ON r.namespace=i.namespace AND r.external_id=i.external_id AND r.source='github_issue' WHERE r.work_item_id=${item.id}`;
    const result = yield* generator.generate({
      item,
      cwd: project.workspace_root,
      projectTitle: project.title,
      modelSelection: plan.modelSelection,
      externalContext: issues.map((row) => row.record_json).join("\n"),
      feedback,
    });
    const now = DateTime.formatIso(yield* DateTime.now);
    // Import a transcript through existing orchestration. No ordinary turn command or execution reactor is dispatched.
    yield* engine.dispatch({
      type: "thread.history.import",
      commandId: CommandId.make(`plan-transcript:${plan.generationId}`),
      threadId: plan.threadId,
      messages: [
        {
          messageId: MessageId.make(`plan-request:${plan.generationId}`),
          role: "user",
          text: `Plan only; do not modify code.\n${item.title}\n${item.body}\n${feedback}`,
          createdAt: plan.createdAt,
        },
        {
          messageId: MessageId.make(`plan-result:${plan.generationId}`),
          role: "assistant",
          text: encode(result.content),
          createdAt: now,
        },
      ],
    });
    yield* finish(item.id, plan.generationId, result);
  });
  const mutate = Effect.fn("WorkPlanService.mutate")(
    function* (raw: WorkPlanMutation) {
      const input = yield* decodeMutation(raw).pipe(
        Effect.mapError(() => error("invalid", "Invalid plan command.")),
      );
      const request = requestKey(input);
      const result = yield* sql.withTransaction(
        Effect.gen(function* () {
          const receipts = yield* sql<{
            request_json: string;
          }>`SELECT request_json FROM work_item_plan_commands WHERE command_id=${input.commandId}`;
          if (receipts[0]) {
            if (receipts[0].request_json !== request)
              return yield* error(
                "conflict",
                "This command ID was already used for another plan change.",
              );
            return null;
          }
          const item = yield* repository.get(input.id);
          if (!item || item.archivedAt)
            return yield* error("invalid", "Choose an available, unarchived WorkItem.");
          const current = yield* read(input.id);
          const now = DateTime.formatIso(yield* DateTime.now);
          let plan: WorkPlan;
          let next: WorkItem;
          let project: { title: string; workspace_root: string } | null = null;
          if (input.kind === "start") {
            if (item.revision !== input.expectedWorkItemRevision)
              return yield* error("conflict", "This WorkItem changed. Refresh before planning.");
            if (
              !item.projectId ||
              !["ready", "awaiting_approval"].includes(item.status) ||
              current?.status === "generating"
            )
              return yield* error(
                "invalid",
                "Assign a project and move the WorkItem to Ready before planning.",
              );
            const candidates = yield* generator.agents();
            const agent = candidates.find(
              (agent) => agent.instanceId === input.modelSelection.instanceId,
            );
            if (!agent || !agent.models.some((model) => model.slug === input.modelSelection.model))
              return yield* error(
                "unavailable",
                "Choose an available planning provider and model.",
              );
            const projects = yield* sql<{
              title: string;
              workspace_root: string;
            }>`SELECT title,workspace_root FROM projection_projects WHERE project_id=${item.projectId} AND deleted_at IS NULL`;
            if (!projects[0])
              return yield* error("invalid", "The assigned project is unavailable.");
            project = projects[0];
            plan = {
              workItemId: item.id,
              revision: (current?.revision ?? 0) + 1,
              generationId: input.commandId,
              status: "generating",
              modelSelection: input.modelSelection,
              agentName: agent.displayName ?? agent.driver,
              threadId: ThreadId.make(`plan:${input.commandId}`),
              createdAt: now,
              generatedAt: null,
              updatedAt: now,
              sourceWorkItemRevision: item.revision,
              approvedWorkItemRevision: null,
              approvedAt: null,
              content: null,
              error: null,
              inspectedFiles: [],
            };
            next = {
              ...item,
              status: "planning",
              assignedAgent: input.modelSelection.instanceId,
              agentThreadId: plan.threadId,
              revision: item.revision + 1,
              updatedAt: now,
              failureReason: null,
            };
          } else {
            if (!current || current.revision !== input.expectedRevision)
              return yield* error("conflict", "The plan changed. Refresh before saving.");
            if (
              input.kind === "cancel"
                ? current.status !== "generating"
                : current.status === "generating"
            )
              return yield* error("invalid", "Wait for planning to finish or cancel it first.");
            if (!["ready", "awaiting_approval", "planning"].includes(item.status))
              return yield* error(
                "invalid",
                "Move the WorkItem to Ready before changing its plan.",
              );
            if ((input.kind === "approve" || input.kind === "edit") && !current.content)
              return yield* error("invalid", "Generate a plan first.");
            if (input.kind === "approve" && current.status !== "draft")
              return yield* error("invalid", "Only a draft plan can be approved.");
            plan = {
              ...current,
              revision: current.revision + 1,
              updatedAt: now,
              approvedAt: null,
              approvedWorkItemRevision: null,
            };
            if (input.kind === "edit") plan = { ...plan, content: input.content, status: "draft" };
            if (input.kind === "approve")
              plan = {
                ...plan,
                status: "approved",
                approvedAt: now,
                approvedWorkItemRevision: item.revision + 1,
              };
            if (input.kind === "reject") plan = { ...plan, status: "rejected" };
            if (input.kind === "cancel")
              plan = {
                ...plan,
                status: "failed",
                error: "Planning cancelled. Regenerate when ready.",
              };
            next = {
              ...item,
              status: input.kind === "edit" ? "awaiting_approval" : "ready",
              revision: item.revision + 1,
              updatedAt: now,
              failureReason: null,
            };
          }
          yield* save(plan, next, `plan-command:${input.commandId}`, input.kind);
          yield* sql`INSERT INTO work_item_plan_commands(command_id,request_json) VALUES (${input.commandId}, ${request})`;
          return { plan, item: next, project };
        }),
      );
      if (!result) return;
      yield* work.notifyChange;
      if (input.kind === "cancel") {
        const fiber = fibers.get(result.plan.generationId);
        if (fiber) yield* Fiber.interrupt(fiber);
      }
      if (input.kind === "start" && result.project) {
        const task = run(result.plan, result.item, result.project, input.feedback ?? "").pipe(
          Effect.catchCause((cause) => {
            const reason = Cause.squash(cause);
            return finish(
              input.id,
              result.plan.generationId,
              reason instanceof Error
                ? reason.message.slice(0, 500)
                : "Planning was interrupted. Regenerate to retry.",
            ).pipe(Effect.ignoreCause({ log: true }));
          }),
          Effect.ensuring(
            Effect.sync(() => {
              fibers.delete(result.plan.generationId);
            }),
          ),
        );
        const fiber = yield* Effect.forkIn(Effect.interruptible(task), scope);
        fibers.set(result.plan.generationId, fiber);
      }
    },
    Effect.mapError(mapError),
    Effect.uninterruptible,
  );
  const get = Effect.fn("WorkPlanService.get")(function* (id: WorkItemId) {
    return { item: yield* work.get(id), plan: yield* read(id), agents: yield* generator.agents() };
  }, Effect.mapError(mapError));
  return {
    get,
    mutate,
    subscribe: (id: WorkItemId) => work.changes.pipe(Stream.mapEffect(() => get(id))),
  };
});
export class WorkPlanService extends Context.Service<
  WorkPlanService,
  Effect.Success<typeof make>
>()("t3/workItems/WorkPlanService") {}
