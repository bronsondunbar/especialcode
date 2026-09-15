import { WorkExecutionService } from "../workItems/WorkExecutionService.ts";
import { WorkPullRequestService } from "../workItems/WorkPullRequestService.ts";
import { assert, it } from "@effect/vitest";
import {
  AutomationMutation,
  AutomationRule,
  AutomationRun,
  GitHubIssue,
  ProjectId,
  ProviderInstanceId,
  WorkItemId,
  type AutomationConfig,
  type WorkPlanMutation,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as Work from "../workItems/WorkItemService.ts";
import { WorkPlanService } from "../workItems/WorkPlanService.ts";
import * as Notifications from "../notifications/ApplicationEventService.ts";
import { AutomationEvent, encodeEvent, makeEventRepository, matches } from "./AutomationEvents.ts";
import { make } from "./WorkAutomationService.ts";
const encodeIssue = Schema.encodeSync(Schema.fromJsonString(GitHubIssue));
const encodeRule = Schema.encodeSync(Schema.fromJsonString(AutomationRule));
const encodeRun = Schema.encodeSync(Schema.fromJsonString(AutomationRun));
const decodeMutation = Schema.decodeUnknownExit(AutomationMutation);
const at = "2026-09-15T10:00:00.000Z";
const id = WorkItemId.make("task");
const model = { instanceId: ProviderInstanceId.make("codex"), model: "test" };
const config: AutomationConfig = {
  name: "Prepare agent-ready issues",
  enabled: true,
  trigger: "github_label_changed",
  conditions: { label: "agent-ready", repository: "example/repo" },
  actions: [
    { kind: "import_work_item" },
    { kind: "generate_plan", modelSelection: model },
    { kind: "notify", message: "Review the plan" },
  ],
};
const source: AutomationEvent = {
  id: "github:1",
  trigger: "github_label_changed",
  occurredAt: at,
  workItemId: null,
  projectId: ProjectId.make("project"),
  title: "Fix bug",
  repository: "example/repo",
  labels: ["agent-ready"],
  status: null,
  hasAgentThread: false,
  issue: { host: "github.com", repository: "example/repo", number: 42 },
};
const issue: GitHubIssue = {
  ...source.issue!,
  externalId: "9001",
  title: source.title,
  body: "Issue body",
  url: "https://github.com/example/repo/issues/42",
  state: "open",
  labels: source.labels,
  assignees: [],
  milestone: null,
  updatedAt: at,
  comments: [],
  commentsFetchedAt: null,
};
const setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES ('project','Project','/repo','[]',${at},${at})`;
  yield* sql`INSERT INTO github_tracked_repositories(namespace,record_json) VALUES ('github.com/example/repo','{}')`;
  yield* sql`INSERT INTO github_issues(namespace,external_id,number,state,updated_at,record_json) VALUES ('github.com/example/repo','9001',42,'open',${at},${encodeIssue(issue)})`;
  const work = yield* Work.make;
  const events = yield* makeEventRepository;
  const notifications = yield* Notifications.make;
  const calls: Array<WorkPlanMutation> = [];
  const planLayer = Layer.mock(WorkPlanService)({
    mutate: Effect.fn(function* (input) {
      yield* Effect.sync(() => {
        calls.push(input);
      });
    }),
  });
  const build = make.pipe(
    Effect.provide(
      Layer.mergeAll(
        planLayer,
        Layer.mock(WorkExecutionService)({}),
        Layer.mock(WorkPullRequestService)({}),
      ),
    ),
    Effect.provideService(Work.WorkItemService, work),
    Effect.provideService(Notifications.ApplicationEventService, notifications),
  );
  const service = yield* build;
  const save = (value: AutomationConfig = config, ruleId = "rule", expectedRevision = 0) =>
    service.mutate({ kind: "save", id: ruleId, expectedRevision, value });
  return { sql, work, events, notifications, calls, build, service, save };
});
it.effect("imports once, requests a plan and notifies without executing or approving coding", () =>
  Effect.gen(function* () {
    const { service, save, events, work, calls, sql } = yield* setup;
    yield* save({
      ...config,
      actions: [
        config.actions[0]!,
        { kind: "assign_provider", instanceId: model.instanceId },
        ...config.actions.slice(1),
      ],
    });
    yield* events.append(source);
    yield* service.sync();
    yield* service.drain;
    const page = yield* service.list({});
    assert.strictEqual(page.total, 1);
    assert.strictEqual(page.runs[0]?.status, "succeeded");
    assert.strictEqual(page.runs[0]?.completedActions, 4);
    const item = (yield* work.list({})).items[0]!;
    assert.strictEqual(item.status, "ready");
    assert.strictEqual(item.assignedAgent, model.instanceId);
    assert.strictEqual(item.projectId, "project");
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0]?.kind, "start");
    assert.strictEqual(
      (yield* sql<{
        n: number;
      }>`SELECT count(*) AS n FROM application_events WHERE json_extract(record_json,'$.type')='automation_notification'`)[0]
        ?.n,
      1,
    );
    yield* events.append(source);
    yield* service.sync();
    assert.strictEqual((yield* service.list({})).total, 1);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(
      (yield* sql<{ n: number }>`SELECT count(*) AS n FROM work_item_executions`)[0]?.n,
      0,
    );
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
it.effect("only matches all conditions and never runs disabled or historical events", () =>
  Effect.gen(function* () {
    const { service, save, events } = yield* setup;
    yield* events.append(source);
    yield* save();
    yield* service.sync();
    assert.strictEqual((yield* service.list({})).total, 0);
    yield* events.append({ ...source, id: "wrong-label", labels: ["other"] });
    yield* events.append({ ...source, id: "wrong-repo", repository: "other/repo" });
    yield* service.sync();
    assert.strictEqual((yield* service.list({})).total, 0);
    yield* save({ ...config, enabled: false }, "rule", 1);
    yield* events.append({ ...source, id: "disabled" });
    yield* service.sync();
    yield* save(config, "rule", 2);
    yield* service.sync();
    assert.strictEqual((yield* service.list({})).total, 0);
    assert.isFalse(matches({ hasAgentThread: true }, source));
    assert.isFalse(matches({ status: "ready" }, source));
    assert.isTrue(
      matches({ repository: "EXAMPLE/REPO", label: "agent-ready", hasAgentThread: false }, source),
    );
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
it.effect(
  "stops after failure, records completed steps, and rejects autonomous execution actions",
  () =>
    Effect.gen(function* () {
      const { service, save, events, sql } = yield* setup;
      yield* save({
        ...config,
        actions: [
          { kind: "notify", message: "Observed" },
          { kind: "generate_plan", modelSelection: model },
          { kind: "notify", message: "Must not run" },
        ],
      });
      yield* events.append(source);
      yield* service.sync();
      const run = (yield* service.list({})).runs[0]!;
      assert.strictEqual(run.status, "failed");
      assert.strictEqual(run.completedActions, 1);
      assert.include(run.message, "Create/import");
      assert.strictEqual(
        (yield* sql<{ n: number }>`SELECT count(*) AS n FROM application_events`)[0]?.n,
        1,
      );
      for (const kind of ["execute_task", "resume_agent", "create_pr", "merge_pr"]) {
        const decoded = decodeMutation({
          kind: "save",
          id: "unsafe",
          expectedRevision: 0,
          value: { ...config, actions: [{ kind }] },
        });
        assert.strictEqual(decoded._tag, "Failure");
      }
      const unsafe = decodeMutation({
        kind: "save",
        id: "unsafe",
        expectedRevision: 0,
        value: { ...config, actions: [{ kind: "change_status", status: "running" }] },
      });
      assert.strictEqual(unsafe._tag, "Failure");
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
it.effect(
  "delivers status events live, suppresses rule loops and keeps history after deletion",
  () =>
    Effect.gen(function* () {
      const { service, save, work } = yield* setup;
      yield* save({
        name: "Move to backlog",
        enabled: true,
        trigger: "work_item_status_changed",
        conditions: {},
        actions: [{ kind: "change_status", status: "backlog" }],
      });
      const item = yield* work.mutate({
        kind: "create",
        id,
        commandId: "create",
        title: "Task",
        source: "manual",
        fields: {},
      });
      const ready = yield* Deferred.make<void>();
      const received = yield* Deferred.make<void>();
      const fiber = yield* service.subscribe({}).pipe(
        Stream.runForEach((page) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(ready, undefined);
            if (page.runs.some((r) => r.status === "succeeded"))
              yield* Deferred.succeed(received, undefined);
          }),
        ),
        Effect.forkScoped,
      );
      yield* Deferred.await(ready);
      yield* work.mutate({
        kind: "status",
        commandId: "manual-status",
        id,
        expectedRevision: item.revision,
        status: "ready",
      });
      yield* Deferred.await(received);
      yield* service.drain;
      assert.strictEqual((yield* work.get(id)).status, "backlog");
      assert.strictEqual((yield* service.list({})).total, 1);
      yield* service.mutate({ kind: "delete", id: "rule", expectedRevision: 1 });
      const page = yield* service.list({});
      assert.strictEqual(page.rules.length, 0);
      assert.strictEqual(page.total, 1);
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
it.effect("protects edits from stale clients and filters and pages immutable run history", () =>
  Effect.gen(function* () {
    const { service, save, events } = yield* setup;
    yield* save({ ...config, actions: [{ kind: "notify", message: "First" }] });
    for (let n = 0; n < 3; n++) yield* events.append({ ...source, id: `event-${n}` });
    yield* service.sync();
    yield* save(
      { ...config, name: "Renamed", actions: [{ kind: "notify", message: "Second" }] },
      "rule",
      1,
    );
    const failed = yield* service
      .mutate({ kind: "delete", id: "rule", expectedRevision: 1 })
      .pipe(Effect.result);
    assert.strictEqual(failed._tag, "Failure");
    const first = yield* service.list({ ruleId: "rule", limit: 2 });
    const second = yield* service.list({ ruleId: "rule", offset: 2, limit: 2 });
    assert.strictEqual(first.total, 3);
    assert.strictEqual(second.runs.length, 1);
    assert.notEqual(first.runs[0]?.id, second.runs[0]?.id);
    assert.strictEqual(first.runs[0]?.ruleName, config.name);
    assert.strictEqual(first.rules[0]?.name, "Renamed");
    assert.strictEqual(first.rules[0]?.lastRun?.id, first.runs[0]?.id);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
it.effect("marks interrupted side effects as failed and never repeats them on restart", () =>
  Effect.gen(function* () {
    const { sql, build, service } = yield* setup;
    const rule: AutomationRule = {
      ...config,
      id: "interrupted",
      revision: 1,
      createdAt: at,
      updatedAt: at,
    };
    const run: AutomationRun = {
      id: "run",
      ruleId: rule.id,
      ruleName: rule.name,
      ruleRevision: 1,
      trigger: source.trigger,
      workItemId: null,
      status: "running",
      completedActions: 1,
      actionCount: 3,
      createdAt: at,
      completedAt: null,
      message: "Running",
    };
    yield* sql`INSERT INTO work_automation_runs(id,rule_id,event_id,status,record_json,rule_json,event_json) VALUES ('run','interrupted','source','running',${encodeRun(run)},${encodeRule(rule)},${encodeEvent(source)})`;
    yield* Effect.scoped(build);
    const result = (yield* service.list({})).runs[0]!;
    assert.strictEqual(result.status, "failed");
    assert.include(result.message, "restart");
    assert.strictEqual(result.completedActions, 1);
    assert.strictEqual((yield* sql<{ n: number }>`SELECT count(*) AS n FROM work_items`)[0]?.n, 0);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
it.effect("routes every supported WorkItem receipt trigger", () =>
  Effect.gen(function* () {
    const { service, save, work } = yield* setup;
    const sql = yield* SqlClient.SqlClient;
    for (const trigger of [
      "plan_approved",
      "pr_changes_requested",
      "pr_checks_failed",
      "slack_work_item_created",
      "github_issue_imported",
    ] as const)
      yield* save(
        {
          name: trigger,
          enabled: true,
          trigger,
          conditions: {},
          actions: [{ kind: "notify", message: "Event received" }],
        },
        trigger,
      );
    yield* work.mutate({
      kind: "create",
      id,
      commandId: "slack",
      title: "Slack task",
      source: "slack",
      resource: {
        source: "slack",
        namespace: "team/channel",
        externalId: "1",
        url: "https://example.slack.com/archives/channel/p1",
      },
      fields: {},
    });
    yield* work.mutate({
      kind: "create",
      id: WorkItemId.make("github"),
      commandId: "github",
      title: "GitHub task",
      source: "github_issue",
      resource: {
        source: "github_issue",
        namespace: "github.com/example/repo",
        externalId: "9001",
        url: issue.url,
      },
      fields: {},
    });
    for (const kind of ["work_item.plan_approve", "pr_changes_requested", "pr_check_failed"]) {
      yield* sql`INSERT INTO work_item_commands(command_id,request_json,result_json,work_item_id,created_at) SELECT ${kind},'{}',record_json,id,updated_at FROM work_items WHERE id=${id}`;
      yield* sql`INSERT INTO work_item_events(work_item_id,command_id,kind,revision,occurred_at,metadata_json) VALUES (${id},${kind},${kind},1,${at},'{}')`;
    }
    yield* service.sync();
    assert.strictEqual((yield* service.list({})).total, 5);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("cancels pending actions when a rule is disabled, while retaining their history", () =>
  Effect.gen(function* () {
    const { service, save, sql } = yield* setup;
    yield* save({ ...config, actions: [{ kind: "notify", message: "Queued" }] });
    yield* service.drain;
    const rule = (yield* service.list({})).rules[0]!;
    const run: AutomationRun = {
      id: "pending",
      ruleId: rule.id,
      ruleName: rule.name,
      ruleRevision: rule.revision,
      trigger: source.trigger,
      workItemId: null,
      status: "pending",
      completedActions: 0,
      actionCount: 1,
      createdAt: at,
      completedAt: null,
      message: "Waiting",
    };
    yield* sql`INSERT INTO work_automation_runs(id,rule_id,event_id,status,record_json,rule_json,event_json) VALUES ('pending',${rule.id},'queued','pending',${encodeRun(run)},${encodeRule(rule)},${encodeEvent(source)})`;
    yield* save({ ...rule, enabled: false }, rule.id, rule.revision);
    yield* service.sync();
    assert.strictEqual((yield* service.list({})).runs[0]?.status, "cancelled");
    assert.strictEqual(
      (yield* sql<{ n: number }>`SELECT count(*) AS n FROM application_events`)[0]?.n,
      0,
    );
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("resumes pending runs once after a restart", () =>
  Effect.gen(function* () {
    const { service, save, sql, build } = yield* setup;
    yield* save({ ...config, actions: [{ kind: "notify", message: "Queued" }] });
    yield* service.drain;
    const rule = (yield* service.list({})).rules[0]!;
    const run: AutomationRun = {
      id: "pending",
      ruleId: rule.id,
      ruleName: rule.name,
      ruleRevision: rule.revision,
      trigger: source.trigger,
      workItemId: null,
      status: "pending",
      completedActions: 0,
      actionCount: 1,
      createdAt: at,
      completedAt: null,
      message: "Waiting",
    };
    yield* sql`INSERT INTO work_automation_runs(id,rule_id,event_id,status,record_json,rule_json,event_json) VALUES ('pending',${rule.id},'queued','pending',${encodeRun(run)},${encodeRule(rule)},${encodeEvent(source)})`;
    yield* Effect.scoped(build);
    yield* Effect.scoped(build);
    assert.strictEqual((yield* service.list({})).runs[0]?.status, "succeeded");
    assert.strictEqual(
      (yield* sql<{ n: number }>`SELECT count(*) AS n FROM application_events`)[0]?.n,
      1,
    );
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("observes lifecycle status changes but excludes automatic planning completion", () =>
  Effect.gen(function* () {
    const { work, service, save, sql } = yield* setup;
    yield* save({
      name: "Plan ready",
      enabled: true,
      trigger: "work_item_status_changed",
      conditions: { status: "awaiting_approval" },
      actions: [{ kind: "notify", message: "Plan ready" }],
    });
    const item = yield* work.mutate({
      kind: "create",
      id,
      commandId: "create",
      title: "Task",
      source: "manual",
      fields: {},
    });
    const record = Effect.fn(function* (commandId: string, status: string, revision: number) {
      yield* sql`INSERT INTO work_item_commands(command_id,request_json,result_json,work_item_id,created_at) SELECT ${commandId},'{}',json_set(record_json,'$.status',${status},'$.revision',${revision}),id,updated_at FROM work_items WHERE id=${item.id}`;
      yield* sql`INSERT INTO work_item_events(work_item_id,command_id,kind,revision,occurred_at,metadata_json) VALUES (${item.id},${commandId},'work_item.plan_generated',${revision},${at},'{}')`;
    });
    yield* record("plan-finish:automation:run:0", "awaiting_approval", 2);
    yield* record("reset", "planning", 3);
    yield* record("plan-finish:manual", "awaiting_approval", 4);
    yield* record("other-update", "awaiting_approval", 5);
    yield* service.sync();
    const page = yield* service.list({});
    assert.strictEqual(page.total, 1);
    assert.strictEqual(page.runs[0]?.trigger, "work_item_status_changed");
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
