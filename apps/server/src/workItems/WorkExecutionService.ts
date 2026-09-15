import {
  admitAutomation,
  type AutomationAdmission,
} from "../automations/AutomationExecutionGuard.ts";
import { makeWorkActivityRepository, activityId } from "../persistence/WorkActivity.ts";
import {
  WorkExecution,
  WorkExecutionError,
  WorkExecutionMutation,
  WorkValidationResult,
  WorkPlan,
  WorkPullRequestRecord,
  WorkReviewSnapshot,
  type WorkReviewMutation,
  ThreadId,
  type WorkItem,
  type WorkItemId,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { sanitizeBranchFragment } from "@t3tools/shared/git";
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Struct from "effect/Struct";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { makeWorkItemRepository } from "../persistence/WorkItems.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { WorkItemService } from "./WorkItemService.ts";
import { WorkExecutionRuntime } from "./WorkExecutionRuntime.ts";
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const encodeRun = Schema.encodeSync(Schema.fromJsonString(WorkExecution));
const decodeRun = Schema.decodeUnknownEffect(Schema.fromJsonString(WorkExecution));
const encodePlan = Schema.encodeSync(Schema.fromJsonString(WorkPlan));
const decodePlan = Schema.decodeUnknownEffect(Schema.fromJsonString(WorkPlan));
const decodeMutation = Schema.decodeUnknownEffect(WorkExecutionMutation);
const decodeAutomationStart = Schema.decodeUnknownEffect(
  Schema.Struct({
    ...WorkExecutionMutation.members[0].fields,
    validationCommands: Schema.Array(WorkValidationResult.fields.command).check(
      Schema.isMaxLength(10),
    ),
  }),
);
const isError = Schema.is(WorkExecutionError);
const fail = (code: WorkExecutionError["code"], message: string) =>
  new WorkExecutionError({ code, message });
const mapError = (cause: unknown) =>
  isError(cause) ? cause : fail("storage", "Could not update execution. Refresh and retry.");
const active = (run: WorkExecution) => !["succeeded", "failed", "stopped"].includes(run.status);
export function executionBranch(item: WorkItem, id: string) {
  const issue =
    item.source === "github_issue"
      ? /\/issues\/(\d+)/.exec(item.externalUrl ?? "")?.[1]
      : undefined;
  const key = issue ?? sanitizeBranchFragment(item.id.replaceAll("/", "-")).slice(0, 16);
  const title = sanitizeBranchFragment(item.title.replaceAll("/", "-")).slice(0, 45);
  return `${issue ? "issue" : "task"}/${key}-${title}-${NodeCrypto.createHash("sha256").update(id).digest("hex").slice(0, 8)}`;
}
const decodeReview = Schema.decodeUnknownEffect(Schema.fromJsonString(WorkReviewSnapshot));
const decodePr = Schema.decodeUnknownEffect(Schema.fromJsonString(WorkPullRequestRecord));
const hasForeignInput = (thread: OrchestrationThread, run: WorkExecution) =>
  thread.messages.some(
    (message) =>
      message.role === "user" &&
      message.id !== `execution-message:${run.id}` &&
      !run.review?.previousUserMessageIds.includes(message.id),
  );
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const scope = yield* Scope.Scope;
  const work = yield* WorkItemService;
  const repo = yield* makeWorkItemRepository;
  const activity = yield* makeWorkActivityRepository;
  const runtime = yield* WorkExecutionRuntime;
  const registry = yield* ProviderInstanceRegistry;
  const engine = yield* OrchestrationEngineService;
  const fibers = new Map<string, Fiber.Fiber<void, never>>();
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const read = Effect.fn("WorkExecutionService.read")(function* (id: WorkItemId) {
    const rows = yield* sql<{
      record_json: string;
    }>`SELECT record_json FROM work_item_executions WHERE work_item_id=${id} ORDER BY rowid DESC LIMIT 1`;
    return rows[0] ? yield* decodeRun(rows[0].record_json) : null;
  });
  const save = Effect.fn("WorkExecutionService.save")(function* (run: WorkExecution) {
    yield* sql`INSERT INTO work_item_executions(id,work_item_id,thread_id,status,record_json) VALUES (${run.id},${run.workItemId},${run.threadId},${run.status},${encodeRun(run)}) ON CONFLICT(id) DO UPDATE SET status=excluded.status,record_json=excluded.record_json`;
  });
  const update = Effect.fn("WorkExecutionService.update")(function* (
    id: WorkItemId,
    runId: string,
    patch: Partial<WorkExecution>,
    expectedStatus?: WorkExecution["status"],
  ) {
    const result = yield* sql.withTransaction(
      Effect.gen(function* () {
        const run = yield* read(id);
        if (
          !run ||
          run.id !== runId ||
          !active(run) ||
          run.status === "stopping" ||
          (expectedStatus && run.status !== expectedStatus)
        )
          return null;
        if (
          Object.entries(patch).every(
            ([key, value]) => encode(run[key as keyof WorkExecution]) === encode(value),
          )
        )
          return run;
        const next = { ...run, ...patch, revision: run.revision + 1, updatedAt: yield* now };
        yield* save(next);
        if (patch.status === "running" && run.status === "preparing")
          yield* activity.append({
            id: activityId(`agent-started:${run.id}`),
            workItemId: run.workItemId,
            kind: "agent_started",
            source: "agents",
            occurredAt: next.updatedAt,
            title: run.review ? "Agent resumed" : "Agent started",
            summary: run.agentName.slice(0, 1000),
            threadId: run.threadId,
            url: null,
            details: [],
          });
        for (const [index, result] of (patch.validationResults ?? []).entries()) {
          if (index < run.validationResults.length) continue;
          yield* activity.append({
            id: activityId(`validation:${run.id}:${index}`),
            workItemId: run.workItemId,
            kind: "validation_completed",
            source: "ci",
            occurredAt: result.completedAt,
            title: result.timedOut
              ? "Validation timed out"
              : result.exitCode === 0
                ? "Validation passed"
                : "Validation failed",
            summary: result.command.slice(0, 1000),
            threadId: run.threadId,
            url: null,
            details: [
              {
                label: "Exit code",
                value: result.exitCode === null ? "Unavailable" : String(result.exitCode),
              },
            ],
          });
        }
        if (patch.worktreePath && run.worktreePath === null) {
          const item = yield* repo.get(run.workItemId);
          if (item) {
            const withBranch = {
              ...item,
              branch: run.branch,
              revision: item.revision + 1,
              updatedAt: next.updatedAt,
            };
            yield* repo.save(withBranch);
            yield* repo.record(
              `execution-worktree:${run.id}`,
              encode({ path: patch.worktreePath }),
              "work_item.execution_worktree_created",
              withBranch,
              encode({ executionId: run.id, branch: run.branch, path: patch.worktreePath }),
            );
          }
        }
        return next;
      }),
    );
    yield* work.notifyChange;
    return result;
  }, Effect.mapError(mapError));
  const finish = Effect.fn("WorkExecutionService.finish")(
    function* (
      run: WorkExecution,
      status: "succeeded" | "failed" | "stopped",
      reason: string | null,
    ) {
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const current = yield* read(run.workItemId);
          if (!current || current.id !== run.id || !active(current)) return;
          if (
            status === "succeeded" &&
            current.status !== (current.review ? "publishing" : "validating")
          )
            return;
          const item = yield* repo.get(run.workItemId);
          if (!item) return;
          const at = yield* now;
          const message = reason?.slice(0, 500) ?? null;
          yield* save({
            ...current,
            status,
            error: message,
            activity:
              status === "succeeded"
                ? run.review
                  ? "Changes pushed; awaiting review"
                  : "Validation passed; ready for review"
                : (message ?? status),
            revision: current.revision + 1,
            updatedAt: at,
            completedAt: at,
          });
          const next = {
            ...item,
            status:
              item.status === "done"
                ? ("done" as const)
                : status === "succeeded"
                  ? ("review" as const)
                  : ("blocked" as const),
            failureReason: message,
            revision: item.revision + 1,
            updatedAt: at,
          };
          yield* repo.save(next);
          yield* repo.record(
            `execution-finish:${run.id}`,
            encode({ status }),
            run.review ? `work_item.review_${status}` : `work_item.execution_${status}`,
            next,
            encode({
              executionId: run.id,
              message: run.review
                ? status === "succeeded"
                  ? "Changes pushed; awaiting review"
                  : message
                : undefined,
            }),
          );
        }),
      );
      yield* work.notifyChange;
    },
    Effect.mapError(mapError),
    Effect.uninterruptible,
  );
  const fork = Effect.fn("WorkExecutionService.fork")(function* <E>(
    run: WorkExecution,
    task: Effect.Effect<void, E>,
  ) {
    let owned: Fiber.Fiber<void, never> | undefined;
    const fiber = yield* Effect.forkIn(
      Effect.interruptible(task).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            const current = yield* read(run.workItemId);
            if (current?.status !== "stopping")
              yield* finish(run, "failed", String(Cause.squash(cause)));
          }).pipe(Effect.ignoreCause({ log: true })),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (fibers.get(run.id) === owned) fibers.delete(run.id);
          }),
        ),
      ),
      scope,
    );
    owned = fiber;
    fibers.set(run.id, fiber);
  });
  const validate = Effect.fn("WorkExecutionService.validate")(function* (run: WorkExecution) {
    if (!run.worktreePath) return yield* fail("invalid", "The execution worktree is unavailable.");
    yield* runtime.verifyWorktree(run);
    const results: WorkExecution["validationResults"][number][] = [];
    for (const command of run.validationCommands) {
      const current = yield* update(run.workItemId, run.id, { activity: `Validating: ${command}` });
      if (!current || current.status !== "validating") return;
      const startedAt = yield* now;
      const result = yield* runtime.validate(run.worktreePath, command);
      results.push({
        command,
        startedAt,
        completedAt: yield* now,
        exitCode: result.code,
        timedOut: result.timedOut,
        output: `${result.stdout}\n${result.stderr}`.slice(0, 32000),
      });
      yield* update(run.workItemId, run.id, { validationResults: [...results] });
      if (result.code !== 0 || result.timedOut) {
        yield* finish(
          run,
          "failed",
          `Validation ${result.timedOut ? "timed out" : "failed"}: ${command}`,
        );
        return;
      }
    }
    yield* runtime.verifyWorktree(run);
    const thread = Option.getOrNull(yield* runtime.inspect(run));
    if (
      !thread ||
      thread.latestTurn?.turnId !== run.turnId ||
      thread.latestTurn.state !== "completed" ||
      thread.session?.activeTurnId ||
      hasForeignInput(thread, run)
    )
      return yield* finish(
        run,
        "failed",
        "The agent thread changed during validation. Review the thread and run again.",
      );
    if (run.review) {
      const publishing = yield* update(
        run.workItemId,
        run.id,
        {
          status: "publishing",
          activity: "Validation passed; committing and pushing review fixes",
        },
        "validating",
      );
      if (!publishing) return;
      const published = yield* runtime.publish(publishing);
      if (published.commit.status === "created" && published.commit.commitSha)
        yield* activity.append({
          id: activityId(`commit:${run.workItemId}:${published.commit.commitSha}`),
          workItemId: run.workItemId,
          kind: "commit_created",
          source: "work",
          occurredAt: yield* now,
          title: "Commit created",
          summary: published.commit.subject?.slice(0, 1000) ?? "",
          threadId: run.threadId,
          url: null,
          details: [{ label: "Commit", value: published.commit.commitSha.slice(0, 500) }],
        });
    }
    yield* finish(run, "succeeded", null);
  });
  const reconcile = Effect.fn("WorkExecutionService.reconcile")(function* (run: WorkExecution) {
    if (!["running", "stopping", "validating"].includes(run.status)) return;
    const thread = Option.getOrNull(yield* runtime.inspect(run));
    if (!thread || thread.deletedAt)
      return yield* finish(run, "failed", "The execution thread was deleted or is unavailable.");
    if (run.status === "stopping") {
      const failure = thread.activities.findLast(
        (entry) =>
          entry.kind === "provider.session.stop.failed" && entry.createdAt >= run.updatedAt,
      );
      if (failure) {
        yield* sql.withTransaction(
          Effect.gen(function* () {
            const current = yield* read(run.workItemId);
            if (current?.id === run.id && current.status === "stopping")
              yield* save({
                ...current,
                status: "running",
                error: "The provider could not stop. Retry Stop or inspect the agent thread.",
                activity: failure.summary,
                revision: current.revision + 1,
                updatedAt: yield* now,
              });
          }),
        );
        yield* work.notifyChange;
        return;
      }
      if (
        !thread.session ||
        ["stopped", "error", "interrupted", "idle"].includes(thread.session.status)
      )
        yield* finish(run, "stopped", "Execution stopped. The branch and worktree were retained.");
      return;
    }
    const turn = thread.latestTurn;
    if (run.status === "validating") {
      if (
        thread.latestTurn?.turnId !== run.turnId ||
        thread.latestTurn.state !== "completed" ||
        thread.session?.activeTurnId ||
        hasForeignInput(thread, run)
      ) {
        yield* finish(
          run,
          "failed",
          "The agent thread changed during validation. Review it before another execution.",
        );
        const fiber = fibers.get(run.id);
        if (fiber) yield* Fiber.interrupt(fiber);
      }
      return;
    }
    if (
      run.review &&
      (!thread.messages.some((message) => message.id === `execution-message:${run.id}`) ||
        turn?.turnId === run.review.previousTurnId)
    )
      return;
    if (
      ((!run.review || (thread.session?.updatedAt ?? "") >= run.startedAt) &&
        (thread.session?.status === "error" || thread.session?.status === "stopped")) ||
      turn?.state === "error" ||
      turn?.state === "interrupted"
    )
      return yield* finish(
        run,
        "failed",
        thread.session?.lastError ?? "The agent stopped before completing the approved work.",
      );
    if (!turn || (run.review && turn.turnId === run.review.previousTurnId)) return;
    // A dedicated thread owns exactly the initial execution turn; follow-ups need a new explicit run.
    if (hasForeignInput(thread, run))
      return yield* finish(
        run,
        "failed",
        "Another turn was added to the execution thread. Review and approve the work again.",
      );
    const patch: Partial<WorkExecution> = {
      turnId: turn.turnId,
      activity:
        thread.activities.at(-1)?.summary ??
        (turn.state === "completed"
          ? "Waiting for change snapshot"
          : "Agent implementing approved plan"),
    };
    const checkpoint = thread.checkpoints.find((entry) => entry.turnId === turn.turnId);
    const current = yield* update(run.workItemId, run.id, {
      ...patch,
      ...(checkpoint ? { changedFiles: checkpoint.files.map((file) => file.path) } : {}),
    });
    if (
      !current ||
      current.status !== "running" ||
      turn.state !== "completed" ||
      thread.session?.activeTurnId ||
      hasForeignInput(thread, run)
    )
      return;
    if (!checkpoint) return;
    if (checkpoint.status !== "ready")
      return yield* finish(
        current,
        "failed",
        "The change snapshot failed. Inspect changes in the agent thread.",
      );
    const answer =
      thread.messages.find((message) => message.id === turn.assistantMessageId)?.text ?? "";
    if (!/\[WORK_ITEM_COMPLETE\]\s*$/.test(answer))
      return yield* finish(
        current,
        "failed",
        "The agent did not confirm the approved scope is complete. Review its response in the agent thread.",
      );
    const validating = yield* update(
      run.workItemId,
      run.id,
      {
        status: "validating",
        activity: "Running required validation",
      },
      "running",
    );
    if (validating) yield* fork(validating, validate(validating));
  });
  // Subscribe first. A restart deliberately stops unfinished work instead of replaying an agent or shell command.
  const events = yield* engine.subscribeDomainEvents;
  const unfinished = yield* sql<{
    record_json: string;
  }>`SELECT record_json FROM work_item_executions WHERE status IN ('preparing','running','validating','publishing','stopping')`;
  for (const row of unfinished) {
    const run = yield* decodeRun(row.record_json);
    if (run.status === "running" || run.status === "stopping")
      yield* runtime.stop(run).pipe(Effect.ignoreCause({ log: true }));
    yield* finish(
      run,
      "failed",
      "Execution was interrupted by a server restart. Inspect the retained thread and worktree, then review the plan before retrying.",
    );
  }
  yield* events.pipe(
    Stream.filter((event) =>
      [
        "thread.session-set",
        "thread.turn-diff-completed",
        "thread.activity-appended",
        "thread.message-sent",
        "thread.deleted",
      ].includes(event.type),
    ),
    Stream.filter((event) => event.type !== "thread.message-sent" || !event.payload.streaming),
    Stream.runForEach((event) =>
      Effect.gen(function* () {
        const rows = yield* sql<{
          record_json: string;
        }>`SELECT record_json FROM work_item_executions WHERE thread_id=${event.aggregateId} AND status IN ('running','stopping','validating')`;
        if (rows[0]) yield* reconcile(yield* decodeRun(rows[0].record_json));
      }).pipe(Effect.ignoreCause({ log: true })),
    ),
    Effect.forkIn(scope),
  );
  const agents = Effect.fn("WorkExecutionService.agents")(function* () {
    const instances = yield* registry.listInstances;
    const snapshots = yield* Effect.forEach(
      instances.filter((instance) => instance.enabled),
      (instance) => instance.snapshot.getSnapshot,
    );
    return snapshots.filter(
      (agent) =>
        agent.enabled &&
        agent.installed &&
        agent.auth.status !== "unauthenticated" &&
        !["error", "disabled"].includes(agent.status),
    );
  });
  const mutate = Effect.fn("WorkExecutionService.mutate")(
    function* (raw: WorkExecutionMutation, owner?: AutomationAdmission) {
      const input = yield* (owner ? decodeAutomationStart(raw) : decodeMutation(raw)).pipe(
        Effect.mapError(() => fail("invalid", "Invalid execution command.")),
      );
      const request = encode(input);
      const candidates = input.kind === "start" ? yield* agents() : [];
      const result = yield* sql.withTransaction(
        Effect.gen(function* () {
          const receipts = yield* sql<{
            request_json: string;
          }>`SELECT request_json FROM work_item_execution_commands WHERE command_id=${input.commandId}`;
          if (receipts[0]) {
            if (receipts[0].request_json !== request)
              return yield* fail(
                "conflict",
                "This command ID was used for another execution change.",
              );
            return null;
          }
          const item = yield* repo.get(input.id);
          if (!item || item.archivedAt)
            return yield* fail("invalid", "Choose an available WorkItem.");
          const existing = yield* read(item.id);
          const at = yield* now;
          let run: WorkExecution;
          let plan: WorkPlan | null = null;
          let automation: WorkExecution["automation"];
          if (input.kind === "start") {
            if (existing && active(existing))
              return yield* fail("conflict", "This WorkItem already has an active execution.");
            if (item.revision !== input.expectedWorkItemRevision)
              return yield* fail("conflict", "The WorkItem changed. Refresh before execution.");
            if (!item.projectId || !["ready", "awaiting_approval"].includes(item.status))
              return yield* fail(
                "invalid",
                "Assign a project and move the WorkItem to Ready before execution.",
              );
            const rows = yield* sql<{
              record_json: string;
            }>`SELECT record_json FROM work_item_plans WHERE work_item_id=${item.id}`;
            plan = rows[0] ? yield* decodePlan(rows[0].record_json) : null;
            if (
              !plan?.content ||
              plan.revision !== input.expectedPlanRevision ||
              !["draft", "approved"].includes(plan.status)
            )
              return yield* fail(
                "conflict",
                "Review a current draft or approved plan before execution.",
              );
            if (plan.status === "approved" && plan.approvedWorkItemRevision !== item.revision)
              return yield* fail(
                "conflict",
                "The WorkItem changed since approval. Edit or regenerate the plan and approve it again.",
              );
            if (owner)
              automation = yield* admitAutomation(
                owner,
                item,
                plan,
                input.modelSelection,
                input.validationCommands,
              ).pipe(Effect.provideService(SqlClient.SqlClient, sql));
            const agent = candidates.find(
              (agent) => agent.instanceId === input.modelSelection.instanceId,
            );
            if (!agent?.models.some((model) => model.slug === input.modelSelection.model))
              return yield* fail("unavailable", "Choose an available agent and model.");
            if (plan.status === "draft") {
              plan = {
                ...plan,
                revision: plan.revision + 1,
                status: "approved",
                approvedAt: at,
                updatedAt: at,
                approvedWorkItemRevision: item.revision,
              };
              yield* sql`UPDATE work_item_plans SET record_json=${encodePlan(plan)} WHERE work_item_id=${item.id}`;
              yield* sql`INSERT INTO work_item_plan_history(work_item_id,revision,record_json) VALUES (${item.id},${plan.revision},${encodePlan(plan)})`;
            }
            run = {
              ...(automation ? { automation } : {}),
              id: input.commandId,
              workItemId: item.id,
              revision: 1,
              planRevision: plan.revision,
              threadId: ThreadId.make(`execution:${input.commandId}`),
              turnId: null,
              modelSelection: input.modelSelection,
              agentName: agent.displayName ?? agent.driver,
              branch: executionBranch(item, input.commandId),
              baseRef: item.branch ?? "HEAD",
              worktreePath: null,
              threadReady: false,
              status: "preparing",
              activity: "Preparing worktree and project setup",
              error: null,
              startedAt: at,
              updatedAt: at,
              completedAt: null,
              validationCommands: input.validationCommands,
              validationResults: [],
              changedFiles: [],
            };
            const next: WorkItem = {
              ...item,
              status: "running",
              failureReason: null,
              assignedAgent: run.modelSelection.instanceId,
              agentThreadId: run.threadId,
              revision: item.revision + 1,
              updatedAt: at,
            };
            yield* repo.save(next);
            yield* repo.record(
              `execution-start:${run.id}`,
              request,
              "work_item.execution_started",
              next,
              encode({ executionId: run.id, planRevision: run.planRevision }),
            );
          } else {
            if (
              !existing ||
              !active(existing) ||
              existing.status === "publishing" ||
              existing.revision !== input.expectedRevision
            )
              return yield* fail("conflict", "Execution changed. Refresh before stopping.");
            run = {
              ...existing,
              status: "stopping",
              activity: "Stopping execution",
              revision: existing.revision + 1,
              updatedAt: at,
            };
          }
          yield* save(run);
          yield* sql`INSERT INTO work_item_execution_commands(command_id,request_json) VALUES (${input.commandId},${request})`;
          return { run, item, plan, previousStatus: existing?.status };
        }),
      );
      if (!result) return;
      yield* work.notifyChange;
      if (input.kind === "stop") {
        const fiber = fibers.get(result.run.id);
        if (fiber) yield* Fiber.interrupt(fiber);
        if (
          result.previousStatus === "running" ||
          result.previousStatus === "stopping" ||
          (result.run.review && result.previousStatus === "preparing")
        ) {
          yield* runtime.stop(result.run);
          yield* reconcile(result.run);
        } else
          yield* finish(
            result.run,
            "stopped",
            "Execution stopped. The branch and worktree were retained.",
          );
        return;
      }
      const { run, item, plan } = result;
      if (!plan) return;
      yield* fork(
        run,
        Effect.gen(function* () {
          const admitted = yield* read(item.id);
          if (admitted?.id !== run.id || admitted.status !== "preparing") return;
          if (
            run.automation &&
            (yield* sql<{
              paused: number;
            }>`SELECT paused FROM work_automation_control WHERE id=1`)[0]?.paused !== 0
          ) {
            yield* finish(run, "stopped", "Automations were stopped before worktree setup.");
            return;
          }
          const cwd = yield* runtime.prepare(run, item, (path, threadReady) =>
            update(item.id, run.id, {
              worktreePath: path,
              ...(threadReady ? { threadReady } : {}),
            }).pipe(Effect.asVoid),
          );
          const current = yield* update(item.id, run.id, {
            status: "running",
            worktreePath: cwd,
            activity: "Starting agent",
          });
          if (!current) return;
          const issues = yield* sql<{
            record_json: string;
          }>`SELECT i.record_json FROM github_issues i JOIN work_item_resources r ON r.namespace=i.namespace AND r.external_id=i.external_id AND r.source='github_issue' WHERE r.work_item_id=${item.id}`;
          yield* runtime.start(
            current,
            item,
            plan,
            issues.map((row) => row.record_json).join("\n"),
          );
        }),
      );
    },
    Effect.mapError(mapError),
    Effect.uninterruptible,
  );
  const startReview = Effect.fn("WorkExecutionService.startReview")(
    function* (
      input: Extract<WorkReviewMutation, { kind: "send" }>,
      snapshot: WorkReviewSnapshot,
      feedback: string,
    ) {
      const request = encode(input);
      const candidates = yield* agents();
      const result = yield* sql.withTransaction(
        Effect.gen(function* () {
          const receipts = yield* sql<{
            request_json: string;
          }>`SELECT request_json FROM work_item_execution_commands WHERE command_id=${input.commandId}`;
          if (receipts[0]) {
            if (receipts[0].request_json !== request)
              return yield* fail(
                "conflict",
                "This command ID was used for another execution change.",
              );
            return null;
          }
          const item = yield* repo.get(input.id);
          if (!item || item.archivedAt || !["review", "blocked"].includes(item.status))
            return yield* fail("invalid", "Choose a WorkItem in Review or Blocked.");
          if (item.revision !== input.expectedWorkItemRevision)
            return yield* fail("conflict", "The WorkItem changed. Review the latest feedback.");
          const savedReviews = yield* sql<{
            snapshot_json: string | null;
          }>`SELECT snapshot_json FROM work_item_reviews WHERE work_item_id=${item.id}`;
          const savedReview = savedReviews[0]?.snapshot_json
            ? yield* decodeReview(savedReviews[0].snapshot_json)
            : null;
          if (
            !savedReview ||
            savedReview.revision !== snapshot.revision ||
            savedReview.fingerprint !== snapshot.fingerprint ||
            savedReview.state !== "open"
          )
            return yield* fail("conflict", "The review changed before execution admission.");
          const latest = yield* read(item.id);
          if (latest && active(latest))
            return yield* fail("conflict", "This WorkItem already has an active execution.");
          const rows = yield* sql<{
            record_json: string;
          }>`SELECT record_json FROM work_item_pull_requests WHERE work_item_id=${item.id}`;
          const pr = rows[0] ? yield* decodePr(rows[0].record_json) : null;
          const runs = pr
            ? yield* sql<{
                record_json: string;
              }>`SELECT record_json FROM work_item_executions WHERE id=${pr.executionId}`
            : [];
          const source = runs[0] ? yield* decodeRun(runs[0].record_json) : null;
          if (
            !source?.worktreePath ||
            !pr?.reference ||
            source.threadId !== item.agentThreadId ||
            source.branch !== snapshot.headBranch ||
            item.branch !== source.branch ||
            item.projectId !== pr.reference.projectId
          )
            return yield* fail(
              "invalid",
              "The WorkItem no longer matches its original PR execution.",
            );
          const thread = Option.getOrNull(yield* runtime.inspect(source));
          if (
            !thread ||
            thread.deletedAt ||
            thread.archivedAt ||
            thread.projectId !== item.projectId ||
            thread.worktreePath !== source.worktreePath ||
            thread.session?.activeTurnId ||
            thread.latestTurn?.state === "running"
          )
            return yield* fail(
              "invalid",
              "Restore the original thread and finish its active work before sending feedback.",
            );
          if (
            !candidates.some(
              (agent) =>
                agent.instanceId === source.modelSelection.instanceId &&
                agent.models.some((model) => model.slug === source.modelSelection.model),
            )
          )
            return yield* fail("unavailable", "The original agent or model is unavailable.");
          const plans = yield* sql<{
            record_json: string;
          }>`SELECT record_json FROM work_item_plan_history WHERE work_item_id=${item.id} AND revision=${source.planRevision}`;
          const plan = plans[0] ? yield* decodePlan(plans[0].record_json) : null;
          if (!plan?.content)
            return yield* fail("invalid", "The original approved plan is unavailable.");
          const at = yield* now;
          const run: WorkExecution = {
            ...Struct.omit(source, ["automation"]),
            id: input.commandId,
            revision: 1,
            turnId: null,
            status: "preparing",
            startedAt: at,
            updatedAt: at,
            completedAt: null,
            error: null,
            activity: "Resuming agent with review feedback",
            changedFiles: [],
            validationResults: [],
            validationCommands: input.validationCommands,
            review: {
              reference: pr.reference,
              feedbackFingerprint: snapshot.fingerprint,
              feedback,
              previousUserMessageIds: thread.messages
                .filter((message) => message.role === "user")
                .map((message) => message.id),
              previousTurnId: thread.latestTurn?.turnId ?? null,
            },
          };
          yield* save(run);
          const next: WorkItem = {
            ...item,
            status: "running",
            failureReason: null,
            revision: item.revision + 1,
            updatedAt: at,
          };
          yield* repo.save(next);
          yield* repo.record(
            `execution-start:${run.id}`,
            request,
            "work_item.review_started",
            next,
            encode({ executionId: run.id, message: "Review cycle started; agent resumed" }),
          );
          yield* sql`INSERT INTO work_item_execution_commands(command_id,request_json) VALUES (${input.commandId},${request})`;
          return { run, item, plan };
        }),
      );
      if (!result) return;
      yield* work.notifyChange;
      yield* fork(
        result.run,
        Effect.gen(function* () {
          const thread = Option.getOrNull(yield* runtime.inspect(result.run));
          if (
            !thread ||
            hasForeignInput(thread, result.run) ||
            thread.session?.activeTurnId ||
            (thread.latestTurn?.turnId ?? null) !== result.run.review?.previousTurnId
          )
            return yield* fail("conflict", "The thread changed before the review cycle started.");
          yield* runtime.start(result.run, result.item, result.plan, "");
          const current = yield* update(
            result.item.id,
            result.run.id,
            { status: "running", activity: "Agent addressing review feedback" },
            "preparing",
          );
          if (current) yield* reconcile(current);
        }),
      );
    },
    Effect.mapError(mapError),
    Effect.uninterruptible,
  );
  const completeMerged = Effect.fn("WorkExecutionService.completeMerged")(
    function* (id: WorkItemId, mergedAt: string, identity: string) {
      const run = yield* sql.withTransaction(
        Effect.gen(function* () {
          const commandId = `pr-merged:${id}:${identity}`;
          if (yield* repo.receipt(commandId)) return null;
          const item = yield* repo.get(id);
          if (!item) return null;
          const run = yield* read(id);
          if (run && active(run))
            yield* save({
              ...run,
              status: "stopped",
              completedAt: mergedAt,
              updatedAt: yield* now,
              revision: run.revision + 1,
              error: null,
              activity: "PR merged; review cycle ended",
            });
          const next: WorkItem = {
            ...item,
            status: "done",
            failureReason: null,
            completedAt: mergedAt,
            updatedAt: yield* now,
            revision: item.revision + 1,
          };
          yield* repo.save(next);
          yield* repo.record(
            commandId,
            encode({ identity }),
            "pr_merged",
            next,
            encode({ message: "PR merged; WorkItem completed" }),
          );
          return run && active(run) ? run : null;
        }),
      );
      yield* work.notifyChange;
      if (run)
        yield* Effect.forkIn(
          Effect.gen(function* () {
            const fiber = fibers.get(run.id);
            if (fiber) yield* Fiber.interrupt(fiber);
            if (["running", "preparing", "stopping"].includes(run.status)) yield* runtime.stop(run);
          }).pipe(Effect.ignoreCause({ log: true })),
          scope,
        );
    },
    Effect.mapError(mapError),
    Effect.uninterruptible,
  );
  const get = Effect.fn("WorkExecutionService.get")(function* (id: WorkItemId) {
    return { item: yield* work.get(id), execution: yield* read(id), agents: yield* agents() };
  }, Effect.mapError(mapError));
  return {
    get,
    verifyAutomationRepository: Effect.fn("WorkExecutionService.verifyAutomationRepository")(
      function* (id: WorkItemId) {
        const run = yield* read(id);
        if (!run?.automation || !run.worktreePath)
          return yield* fail("invalid", "An autonomous execution worktree is required.");
        yield* runtime.verifyRepository(run.worktreePath, run.automation.repository);
      },
      Effect.mapError(mapError),
    ),
    startReview,
    completeMerged,
    mutate: (input: WorkExecutionMutation) => mutate(input),
    startAutomation: (
      input: Extract<WorkExecutionMutation, { kind: "start" }>,
      owner: AutomationAdmission,
    ) => mutate(input, owner),
    subscribe: (id: WorkItemId) => work.changes.pipe(Stream.mapEffect(() => get(id))),
    reconcile,
  };
});
export class WorkExecutionService extends Context.Service<
  WorkExecutionService,
  Effect.Success<typeof make>
>()("t3/workItems/WorkExecutionService") {}
