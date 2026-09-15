import { WorkExecutionService } from "../workItems/WorkExecutionService.ts";
import { WorkPullRequestService } from "../workItems/WorkPullRequestService.ts";
import {
  AutomationConfig,
  AutomationControlMutation,
  WorkExecution,
  WorkPlan,
  AutomationError,
  AutomationListInput,
  AutomationMutation,
  AutomationRule,
  AutomationRun,
  GitHubIssue,
  WorkItem,
  WorkItemId,
  type AutomationTrigger,
  type AutomationAction,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ApplicationEventService } from "../notifications/ApplicationEventService.ts";
import { WorkItemService } from "../workItems/WorkItemService.ts";
import { WorkPlanService } from "../workItems/WorkPlanService.ts";
import { activityId } from "../persistence/WorkActivity.ts";
import { AutomationEvent, decodeEvent, makeEventRepository, matches } from "./AutomationEvents.ts";
const decodeRule = Schema.decodeUnknownEffect(Schema.fromJsonString(AutomationRule));
const encodeRule = Schema.encodeSync(Schema.fromJsonString(AutomationRule));
const decodeRun = Schema.decodeUnknownEffect(Schema.fromJsonString(AutomationRun));
const encodeRun = Schema.encodeSync(Schema.fromJsonString(AutomationRun));
const decodeItem = Schema.decodeUnknownEffect(Schema.fromJsonString(WorkItem));
const decodeIssue = Schema.decodeUnknownEffect(Schema.fromJsonString(GitHubIssue));
const isAutomationError = Schema.is(AutomationError);
const decodeExecution = Schema.decodeUnknownEffect(Schema.fromJsonString(WorkExecution));
const decodePlan = Schema.decodeUnknownEffect(Schema.fromJsonString(WorkPlan));
const decodeControlMutation = Schema.decodeUnknownEffect(AutomationControlMutation);
const decodeList = Schema.decodeUnknownEffect(AutomationListInput);
const decodeMutation = Schema.decodeUnknownEffect(AutomationMutation);
const decodeConfig = Schema.decodeUnknownEffect(AutomationConfig);
const error = (message: string) => new AutomationError({ message });
const storageError = (cause: unknown) =>
  isAutomationError(cause)
    ? cause
    : error("Could not access automation rules. Reconnect or retry.");
const workTriggers: Readonly<Record<string, AutomationTrigger>> = {
  "work_item.plan_approve": "plan_approved",
  pr_changes_requested: "pr_changes_requested",
  pr_check_failed: "pr_checks_failed",
};
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const work = yield* WorkItemService;
  const plans = yield* WorkPlanService;
  const executions = yield* WorkExecutionService;
  const pullRequests = yield* WorkPullRequestService;
  const notifications = yield* ApplicationEventService;
  const events = yield* makeEventRepository;
  const lock = yield* Semaphore.make(1);
  const changes = yield* SubscriptionRef.make(0);
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const controlState = Effect.fn("WorkAutomationService.controlState")(function* () {
    const row = (yield* sql<{
      paused: number;
      revision: number;
    }>`SELECT paused,revision FROM work_automation_control WHERE id=1`)[0]!;
    return { paused: row.paused === 1, revision: row.revision };
  });
  const cursor = Effect.fn(function* (source: string) {
    return (yield* sql<{
      sequence: number;
    }>`SELECT sequence FROM work_automation_cursors WHERE source=${source}`)[0]!.sequence;
  });
  const saveRun = (run: AutomationRun) =>
    sql`UPDATE work_automation_runs SET status=${run.status},record_json=${encodeRun(run)} WHERE id=${run.id}`;
  const ingestWork = Effect.fn("WorkAutomationService.ingestWork")(function* () {
    const after = yield* cursor("work");
    const rows = yield* sql<{
      sequence: number;
      command_id: string;
      kind: string;
      result_json: string;
      previous_status: string | null;
    }>`SELECT e.sequence,e.command_id,e.kind,c.result_json,
      (SELECT json_extract(prior.result_json,'$.status') FROM work_item_events p JOIN work_item_commands prior ON prior.command_id=p.command_id WHERE p.work_item_id=e.work_item_id AND p.sequence<e.sequence ORDER BY p.sequence DESC LIMIT 1) AS previous_status
      FROM work_item_events e JOIN work_item_commands c ON c.command_id=e.command_id WHERE e.sequence>${after} ORDER BY e.sequence LIMIT 100`;
    for (const row of rows) {
      // Automation mutations cannot trigger other automations, including themselves.
      if (
        /^(?:plan-command:|plan-finish:|execution-start:|execution-finish:|work-pr:)?automation:/.test(
          row.command_id,
        )
      )
        continue;
      const item = yield* decodeItem(row.result_json);
      const trigger =
        row.kind === "work_item.create"
          ? item.source === "github_issue"
            ? "github_issue_imported"
            : item.source === "slack"
              ? "slack_work_item_created"
              : null
          : workTriggers[row.kind];
      const triggers: AutomationTrigger[] = trigger ? [trigger] : [];
      if (row.previous_status !== null && row.previous_status !== item.status)
        triggers.push("work_item_status_changed");
      if (!triggers.length || item.archivedAt) continue;
      const resource = item.resources.find((r) => r.source === "github_issue");
      const cached = resource
        ? yield* sql<{
            record_json: string;
          }>`SELECT record_json FROM github_issues WHERE namespace=${resource.namespace} AND external_id=${resource.externalId}`
        : [];
      const issue = cached[0] ? yield* decodeIssue(cached[0].record_json) : null;
      for (const trigger of triggers)
        yield* events.append({
          id: `work:${row.sequence}:${trigger}`,
          trigger,
          occurredAt: item.updatedAt,
          workItemId: item.id,
          projectId: item.projectId,
          title: item.title,
          repository: item.repository,
          labels: issue?.labels ?? [],
          status: item.status,
          hasAgentThread: item.agentThreadId !== null,
          issue: issue
            ? { host: issue.host, repository: issue.repository, number: issue.number }
            : null,
        });
    }
    if (rows.length)
      yield* sql`UPDATE work_automation_cursors SET sequence=${rows.at(-1)!.sequence} WHERE source='work'`;
    return rows.length === 100;
  });
  const ingestEvents = Effect.fn("WorkAutomationService.ingestEvents")(function* () {
    const paused = (yield* controlState()).paused;
    const after = yield* cursor("events");
    const rows = yield* sql<{
      sequence: number;
      record_json: string;
    }>`SELECT sequence,record_json FROM work_automation_events WHERE sequence>${after} ORDER BY sequence LIMIT 100`;
    const rules = yield* sql<{
      starts_after: number;
      record_json: string;
    }>`SELECT starts_after,record_json FROM work_automation_rules`;
    const decoded = yield* Effect.forEach(rules, (row) =>
      decodeRule(row.record_json).pipe(Effect.map((rule) => ({ rule, after: row.starts_after }))),
    );
    for (const row of rows) {
      const event = yield* decodeEvent(row.record_json);
      for (const { rule, after } of decoded) {
        if (
          paused ||
          !rule.enabled ||
          row.sequence <= after ||
          rule.trigger !== event.trigger ||
          !matches(rule.conditions, event)
        )
          continue;
        const run: AutomationRun = {
          id: activityId(`${rule.id}:${event.id}`),
          ruleId: rule.id,
          ruleName: rule.name,
          ruleRevision: rule.revision,
          trigger: event.trigger,
          workItemId: event.workItemId,
          status: "pending",
          completedActions: 0,
          actionCount: rule.actions.length,
          createdAt: yield* now,
          completedAt: null,
          message: "Waiting to run",
        };
        yield* sql`INSERT INTO work_automation_runs(id,rule_id,event_id,status,record_json,rule_json,event_json) VALUES (${run.id},${rule.id},${event.id},'pending',${encodeRun(run)},${encodeRule(rule)},${row.record_json}) ON CONFLICT(rule_id,event_id) DO NOTHING`;
      }
    }
    if (rows.length)
      yield* sql`UPDATE work_automation_cursors SET sequence=${rows.at(-1)!.sequence} WHERE source='events'`;
    return rows.length === 100;
  });
  const action = Effect.fn("WorkAutomationService.action")(function* (
    step: AutomationAction,
    event: AutomationEvent,
    run: AutomationRun,
    index: number,
  ) {
    const commandId = `automation:${run.id}:${index}`;
    let item = run.workItemId ? yield* work.get(run.workItemId) : null;
    if (item?.archivedAt) return yield* error("The WorkItem was archived before this action ran.");
    if (step.kind === "import_work_item") {
      if (item) return item.id;
      if (!event.issue) return yield* error("This event has no GitHub issue to import.");
      const namespace = `${event.issue.host.toLowerCase()}/${event.issue.repository.toLowerCase()}`;
      const rows = yield* sql<{
        record_json: string;
      }>`SELECT record_json FROM github_issues WHERE namespace=${namespace} AND number=${event.issue.number}`;
      if (!rows[0])
        return yield* error("The source issue is no longer cached. Sync the repository first.");
      const issue = yield* decodeIssue(rows[0].record_json);
      const resource = {
        source: "github_issue" as const,
        namespace,
        externalId: issue.externalId,
        url: issue.url,
      };
      item = yield* work.findByResource(resource);
      if (item) {
        if (item.archivedAt) return yield* error("The imported WorkItem is archived.");
        return item.id;
      }
      const id = WorkItemId.make(`github:${namespace}:${issue.externalId}`);
      const detached = yield* work.get(id).pipe(
        Effect.catchIf(
          (e) => e.code === "not_found",
          () => Effect.succeed(null),
        ),
      );
      if (detached)
        return (yield* work.mutate({
          kind: "attachResource",
          commandId,
          id,
          expectedRevision: detached.revision,
          resource,
        })).id;
      return (yield* work.mutate({
        kind: "create",
        commandId,
        id,
        source: "github_issue",
        title: issue.title,
        fields: { body: issue.body, repository: issue.repository, projectId: event.projectId },
        resource,
      })).id;
    }
    if (step.kind === "notify") {
      yield* notifications.append({
        id: commandId,
        source: "automation",
        type: "automation_notification",
        userId: null,
        projectId: item?.projectId ?? event.projectId,
        workItemId: item?.id ?? null,
        title: run.ruleName,
        message: `${step.message}\n${item?.title ?? event.title}`.slice(0, 5000),
        action: item ? { kind: "work_item", workItemId: item.id } : null,
        createdAt: yield* now,
      });
      yield* notifications.notifyChange;
      return item?.id ?? null;
    }
    if (!item)
      return yield* error("Add Create/import WorkItem before this action for an unimported issue.");
    switch (step.kind) {
      case "change_status":
        if (item.status !== step.status)
          yield* work.mutate({
            kind: "status",
            commandId,
            id: item.id,
            expectedRevision: item.revision,
            status: step.status,
          });
        break;
      case "assign_provider":
        yield* work.mutate({
          kind: "update",
          commandId,
          id: item.id,
          expectedRevision: item.revision,
          patch: { assignedAgent: step.instanceId },
        });
        break;
      case "generate_plan":
        if (["inbox", "backlog"].includes(item.status))
          item = yield* work.mutate({
            kind: "status",
            commandId: `${commandId}:ready`,
            id: item.id,
            expectedRevision: item.revision,
            status: "ready",
          });
        yield* plans.mutate({
          kind: "start",
          commandId,
          id: item.id,
          expectedWorkItemRevision: item.revision,
          modelSelection: step.modelSelection,
        });
        break;
      default:
        return yield* error("This automation action is not supported.");
    }
    return item.id;
  });
  const stopOwned = Effect.fn("WorkAutomationService.stopOwned")(function* () {
    const errors: string[] = [];
    const active = yield* sql<{
      record_json: string;
    }>`SELECT record_json FROM work_item_executions WHERE json_extract(record_json,'$.automation') IS NOT NULL AND status IN ('preparing','running','validating','stopping')`;
    for (const row of active) {
      const run = yield* decodeExecution(row.record_json);
      const result = yield* executions
        .mutate({
          kind: "stop",
          commandId: `auto-stop:${run.id}:${run.revision}`,
          id: run.workItemId,
          expectedRevision: run.revision,
        })
        .pipe(Effect.result);
      if (result._tag === "Failure") errors.push(result.failure.message);
    }
    const planning = yield* sql<{
      record_json: string;
    }>`SELECT record_json FROM work_item_plans WHERE json_extract(record_json,'$.status')='generating' AND json_extract(record_json,'$.generationId') LIKE 'automation:%'`;
    for (const row of planning) {
      const plan = yield* decodePlan(row.record_json);
      const result = yield* plans
        .mutate({
          kind: "cancel",
          commandId: `auto-stop-plan:${plan.generationId}:${plan.revision}`,
          id: plan.workItemId,
          expectedRevision: plan.revision,
        })
        .pipe(Effect.result);
      if (result._tag === "Failure") errors.push(result.failure.message);
    }
    if (errors.length)
      return yield* error(
        `Automations are paused. Some work could not be stopped: ${errors.join("; ").slice(0, 800)}. Inspect the threads and retry Stop all.`,
      );
  });
  const beginExecution = Effect.fn("WorkAutomationService.beginExecution")(function* (
    run: AutomationRun,
    step: Extract<AutomationAction, { kind: "execute_approved" }>,
  ) {
    if (!run.workItemId) return yield* error("Import a WorkItem before executing it.");
    const state = yield* plans.get(run.workItemId);
    if (state.plan?.status !== "approved")
      return yield* error("Approve the current plan before this rule can execute it.");
    const executionId = `automation:${run.id}:${run.completedActions}`;
    // Persist ownership before launch. A restart never repeats a launch whose outcome is uncertain.
    yield* saveRun({
      ...run,
      executionId,
      status: "waiting",
      message: "Waiting for execution and validation",
    });
    const started = yield* executions
      .startAutomation(
        {
          kind: "start",
          commandId: executionId,
          id: run.workItemId,
          expectedWorkItemRevision: state.item.revision,
          expectedPlanRevision: state.plan.revision,
          modelSelection: step.modelSelection,
          validationCommands: step.validationCommands,
        },
        { ruleId: run.ruleId, ruleRevision: run.ruleRevision, runId: run.id },
      )
      .pipe(Effect.result);
    if (started._tag === "Failure") {
      if (started.failure.code === "capacity") {
        const { executionId: _, ...waiting } = run;
        yield* saveRun({ ...waiting, status: "waiting", message: started.failure.message });
      } else return yield* started.failure;
    }
  });
  const resumeWaiting = Effect.fn("WorkAutomationService.resumeWaiting")(function* () {
    if ((yield* controlState()).paused) return;
    let after = 0;
    while (true) {
      const rows = yield* sql<{
        sequence: number;
        record_json: string;
      }>`SELECT sequence,record_json FROM work_automation_runs WHERE status='waiting' AND sequence>${after} ORDER BY sequence LIMIT 100`;
      if (rows.length === 0) return;
      after = rows[rows.length - 1]!.sequence;
      for (const row of rows) {
        if ((yield* controlState()).paused) return;
        let run = yield* decodeRun(row.record_json);
        if (!run.executionId) {
          yield* sql`UPDATE work_automation_runs SET status='pending',record_json=${encodeRun({ ...run, status: "pending" })} WHERE id=${run.id} AND status='waiting' AND (SELECT paused FROM work_automation_control WHERE id=1)=0`;
          continue;
        }
        const state = run.workItemId ? yield* executions.get(run.workItemId) : null;
        const execution = state?.execution;
        if (
          execution?.id === run.executionId &&
          !["succeeded", "failed", "stopped"].includes(execution.status)
        )
          continue;
        if (execution?.id !== run.executionId || execution.status !== "succeeded") {
          yield* saveRun({
            ...run,
            status: "failed",
            completedAt: yield* now,
            message:
              execution?.error ??
              "Execution did not finish successfully. Inspect the retained thread and worktree.",
          });
          yield* SubscriptionRef.update(changes, (n) => n + 1);
          continue;
        }
        run = { ...run, status: "running", message: "Finishing execution actions" };
        yield* saveRun(run);
        const result = yield* Effect.gen(function* () {
          if (execution.automation?.requirePullRequest) {
            if ((yield* controlState()).paused)
              return yield* error("Automations were stopped before PR creation.");
            yield* executions.verifyAutomationRepository(execution.workItemId);
            const pr = yield* pullRequests.get(execution.workItemId);
            if (pr.record?.status === "linked" && pr.record.executionId !== execution.id)
              return yield* error(
                "A PR from an earlier execution is already linked. Review it manually.",
              );
            yield* pullRequests.mutate({
              kind: "create",
              commandId: `auto-pr:${run.id}`,
              id: execution.workItemId,
              expectedRevision: pr.item.revision,
              content: pr.draft,
            });
          }
        }).pipe(Effect.result);
        const paused = (yield* controlState()).paused;
        yield* saveRun({
          ...run,
          status: paused ? "cancelled" : result._tag === "Failure" ? "failed" : "pending",
          completedActions:
            result._tag === "Success" ? run.completedActions + 1 : run.completedActions,
          completedAt: paused || result._tag === "Failure" ? yield* now : null,
          message: paused
            ? "Stopped by emergency control"
            : result._tag === "Failure"
              ? result.failure.message.slice(0, 1000)
              : "Execution completed",
        });
        yield* SubscriptionRef.update(changes, (n) => n + 1);
      }
    }
  });
  const executePending = Effect.fn("WorkAutomationService.executePending")(function* () {
    if ((yield* controlState()).paused) return false;
    const rows = yield* sql<{
      record_json: string;
      rule_json: string;
      event_json: string;
    }>`SELECT record_json,rule_json,event_json FROM work_automation_runs WHERE status='pending' ORDER BY sequence LIMIT 1`;
    if (!rows[0]) return false;
    let run = yield* decodeRun(rows[0].record_json);
    const rule = yield* decodeRule(rows[0].rule_json);
    const event = yield* decodeEvent(rows[0].event_json);
    run = { ...run, status: "running", message: "Running actions" };
    yield* saveRun(run);
    yield* SubscriptionRef.update(changes, (n) => n + 1);
    const result = yield* Effect.gen(function* () {
      for (let index = run.completedActions; index < rule.actions.length; index++) {
        if ((yield* controlState()).paused) return yield* error("Automations were stopped.");
        const step = rule.actions[index]!;
        if (step.kind === "execute_approved") {
          yield* beginExecution(run, step);
          return "waiting" as const;
        }
        const workItemId = yield* action(step, event, run, index);
        run = { ...run, workItemId, completedActions: index + 1 };
        yield* saveRun(run);
      }
      return "done" as const;
    }).pipe(Effect.result);
    const paused = (yield* controlState()).paused;
    if (paused) {
      yield* saveRun({
        ...run,
        status: "cancelled",
        completedAt: yield* now,
        message: "Stopped by emergency control",
      });
      yield* stopOwned().pipe(Effect.ignoreCause({ log: true }));
    } else if (result._tag === "Failure" || result.success !== "waiting") {
      yield* saveRun({
        ...run,
        status: result._tag === "Success" ? "succeeded" : "failed",
        completedAt: yield* now,
        message:
          result._tag === "Success"
            ? "Actions completed. Generated plans still require approval."
            : result.failure.message.slice(0, 1000),
      });
    }
    yield* SubscriptionRef.update(changes, (n) => n + 1);
    return true;
  });
  const sync = Effect.fn("WorkAutomationService.sync")(function* () {
    while (yield* lock.withPermits(1)(sql.withTransaction(ingestWork()))) {
      /* Bounded receipt batches. */
    }
    while (yield* lock.withPermits(1)(sql.withTransaction(ingestEvents()))) {
      /* Atomically claim each event once. */
    }
    yield* lock.withPermits(1)(resumeWaiting());
    // Release the permit between runs so disabling a rule can cancel pending work.
    while (yield* lock.withPermits(1)(executePending())) {
      /* Ordered actions, no parallel mutations of a task. */
    }
  }, Effect.mapError(storageError));
  // A crash may occur after a side effect but before its receipt. Do not repeat uncertain actions.
  const interrupted = yield* sql<{
    record_json: string;
  }>`SELECT record_json FROM work_automation_runs WHERE status='running'`;
  for (const row of interrupted) {
    const run = yield* decodeRun(row.record_json);
    yield* saveRun({
      ...run,
      status: "failed",
      completedAt: yield* now,
      message:
        "Interrupted by a server restart. Inspect the WorkItem before making further changes; an action may have completed.",
    });
  }
  const list = Effect.fn("WorkAutomationService.list")(
    function* (raw: AutomationListInput) {
      const input = yield* decodeList(raw);
      const ruleRows = yield* sql<{
        record_json: string;
        last_run: string | null;
      }>`SELECT r.record_json,(SELECT record_json FROM work_automation_runs WHERE rule_id=r.id ORDER BY sequence DESC LIMIT 1) AS last_run FROM work_automation_rules r ORDER BY json_extract(r.record_json,'$.name'),r.id`;
      const rules = yield* Effect.forEach(ruleRows, (row) =>
        Effect.gen(function* () {
          return {
            ...(yield* decodeRule(row.record_json)),
            lastRun: row.last_run ? yield* decodeRun(row.last_run) : null,
          };
        }),
      );
      const where = input.ruleId ? sql`rule_id=${input.ruleId}` : sql`1=1`;
      const rows = yield* sql<{
        record_json: string;
      }>`SELECT record_json FROM work_automation_runs WHERE ${where} ORDER BY sequence DESC LIMIT ${input.limit ?? 25} OFFSET ${input.offset ?? 0}`;
      return {
        control: yield* controlState(),
        rules,
        runs: yield* Effect.forEach(rows, (row) => decodeRun(row.record_json)),
        total: (yield* sql<{
          n: number;
        }>`SELECT count(*) AS n FROM work_automation_runs WHERE ${where}`)[0]!.n,
      };
    },
    sql.withTransaction,
    Effect.mapError(storageError),
  );
  const mutate = Effect.fn("WorkAutomationService.mutate")(
    function* (raw: AutomationMutation) {
      const input = yield* decodeMutation(raw).pipe(
        Effect.mapError(() =>
          error("Enter a valid rule with supported actions and complete execution safeguards."),
        ),
      );
      // Establish an activation boundary including work receipts awaiting projection.
      while (yield* sql.withTransaction(ingestWork())) {
        /* Never replay past events for a new rule. */
      }
      while (yield* sql.withTransaction(ingestEvents())) {
        /* Preserve already queued rule snapshots. */
      }
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{
            record_json: string;
          }>`SELECT record_json FROM work_automation_rules WHERE id=${input.id}`;
          const previous = rows[0] ? yield* decodeRule(rows[0].record_json) : null;
          if ((previous?.revision ?? 0) !== input.expectedRevision)
            return yield* error("This rule changed on another client. Reload before saving.");
          if (input.kind === "delete")
            yield* sql`DELETE FROM work_automation_rules WHERE id=${input.id}`;
          else {
            const count = (yield* sql<{
              n: number;
            }>`SELECT count(*) AS n FROM work_automation_rules`)[0]!.n;
            if (!previous && count >= 100)
              return yield* error("This environment supports at most 100 rules.");
            const value = yield* decodeConfig(input.value);
            const executionSteps = value.actions.filter((step) => step.kind === "execute_approved");
            if (executionSteps.length > 1)
              return yield* error("Use at most one execution action per rule.");
            if (
              executionSteps.length &&
              value.actions.some((step) => step.kind === "generate_plan")
            )
              return yield* error(
                "Use a separate plan-approved rule to execute. Plans need explicit approval.",
              );
            if (executionSteps.length && value.enabled && !value.execution?.trusted)
              return yield* error(
                "Explicitly trust and configure this rule before enabling execution.",
              );
            if (
              value.execution?.requireTests &&
              executionSteps.some((step) => !step.validationCommands.length)
            )
              return yield* error("Required tests need at least one validation command.");
            const time = yield* now;
            const record: AutomationRule = {
              ...value,
              id: input.id,
              revision: (previous?.revision ?? 0) + 1,
              createdAt: previous?.createdAt ?? time,
              updatedAt: time,
            };
            const head = (yield* sql<{
              n: number;
            }>`SELECT coalesce(max(sequence),0) AS n FROM work_automation_events`)[0]!.n;
            yield* sql`INSERT INTO work_automation_rules(id,revision,starts_after,record_json) VALUES (${input.id},${record.revision},${head},${encodeRule(record)}) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,starts_after=excluded.starts_after,record_json=excluded.record_json`;
          }
          // Edits, disable and delete cancel work that has not started under the old revision.
          const pending = yield* sql<{
            record_json: string;
          }>`SELECT record_json FROM work_automation_runs WHERE rule_id=${input.id} AND status IN ('pending','waiting')`;
          for (const row of pending)
            yield* saveRun({
              ...(yield* decodeRun(row.record_json)),
              status: "cancelled",
              completedAt: yield* now,
              message: "Rule was changed or deleted before this run started.",
            });
        }),
      );
      yield* SubscriptionRef.update(changes, (n) => n + 1);
    },
    lock.withPermits(1),
    Effect.mapError(storageError),
  );
  const control = Effect.fn("WorkAutomationService.control")(function* (
    raw: AutomationControlMutation,
  ) {
    const input = yield* decodeControlMutation(raw);
    if (input.kind === "stop_all") {
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`UPDATE work_automation_control SET paused=1,revision=revision+1 WHERE id=1`;
          const rows = yield* sql<{
            record_json: string;
          }>`SELECT record_json FROM work_automation_runs WHERE status IN ('pending','waiting')`;
          for (const row of rows)
            yield* saveRun({
              ...(yield* decodeRun(row.record_json)),
              status: "cancelled",
              completedAt: yield* now,
              message: "Stopped by emergency control",
            });
        }),
      );
      yield* SubscriptionRef.update(changes, (n) => n + 1);
      yield* stopOwned();
    } else {
      yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const state = yield* controlState();
          if (!state.paused || state.revision !== input.expectedRevision)
            return yield* error("Automation controls changed. Refresh before resuming.");
          while (yield* sql.withTransaction(ingestWork())) {}
          while (yield* sql.withTransaction(ingestEvents())) {}
          const changed =
            yield* sql`UPDATE work_automation_control SET paused=0,revision=revision+1 WHERE id=1 AND revision=${input.expectedRevision} RETURNING id`;
          if (!changed.length)
            return yield* error("Automations were stopped again. Refresh before resuming.");
        }),
      );
      yield* SubscriptionRef.update(changes, (n) => n + 1);
    }
  }, Effect.mapError(storageError));
  const worker = yield* makeDrainableWorker((_input: void) =>
    sync().pipe(Effect.ignoreCause({ log: true })),
  );
  yield* work.changes.pipe(
    Stream.runForEach(() => worker.enqueue(undefined)),
    Effect.forkScoped,
  );
  yield* sync();
  return {
    list,
    control,
    mutate,
    sync,
    drain: worker.drain,
    subscribe: (input: AutomationListInput) =>
      SubscriptionRef.changes(changes).pipe(Stream.mapEffect(() => list(input))),
  };
});
export class WorkAutomationService extends Context.Service<
  WorkAutomationService,
  Effect.Success<typeof make>
>()("t3/automations/WorkAutomationService") {}
