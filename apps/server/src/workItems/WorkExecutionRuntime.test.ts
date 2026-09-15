import { PullRequestService } from "../pullRequest/PullRequestService.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  TurnId,
  type PullRequestDetail,
  type OrchestrationThread,
  WorkPlan,
  ProjectId,
  ThreadId,
  ProviderInstanceId,
  WorkItem,
  WorkItemId,
  WorkExecution,
  type OrchestrationCommand,
  type OrchestrationProjectShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Option from "effect/Option";
import * as FileSystem from "effect/FileSystem";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { ProjectSetupScriptRunner } from "../project/ProjectSetupScriptRunner.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import * as Processes from "../processRunner.ts";
import { TerminalManager } from "../terminal/Manager.ts";
import { make, matchesAutomationRepository } from "./WorkExecutionRuntime.ts";
const at = "2026-09-14T10:00:00Z";
const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-execution-runtime-test-" });
  const item = WorkItem.make({
    id: WorkItemId.make("task"),
    title: "Task",
    body: "Implement",
    projectId: ProjectId.make("project"),
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
    status: "ready",
    revision: 1,
    createdAt: at,
    updatedAt: at,
    completedAt: null,
    archivedAt: null,
  });
  const run = WorkExecution.make({
    id: "run",
    workItemId: item.id,
    revision: 1,
    planRevision: 2,
    threadId: ThreadId.make("execution:run"),
    turnId: null,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
    agentName: "Codex",
    branch: "task/branch",
    baseRef: "HEAD",
    worktreePath: null,
    threadReady: false,
    status: "preparing",
    activity: "Preparing",
    error: null,
    startedAt: at,
    updatedAt: at,
    completedAt: null,
    validationCommands: ["test"],
    validationResults: [],
    changedFiles: [],
  });
  const dirty = yield* Ref.make(false);
  const setupExit = yield* Ref.make(0);
  const commands: OrchestrationCommand[] = [];
  const calls = { worktree: 0, setup: 0, publish: 0 };
  const closed = yield* Ref.make(false);
  const projectRoot = yield* Ref.make("/repo");
  const runtime = yield* make.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(GitWorkflowService)({
          invalidateLocalStatus: () => Effect.void,
          invalidateStatus: () => Effect.void,
          localStatus: (input) =>
            Ref.get(dirty).pipe(
              Effect.map((dirty) => ({
                isRepo: true,
                hasPrimaryRemote: false,
                isDefaultRef: input.cwd !== cwd,
                refName: input.cwd === cwd ? run.branch : "main",
                hasWorkingTreeChanges: dirty,
                workingTree: { files: [], insertions: 0, deletions: 0 },
              })),
            ),
          runStackedAction: (input) => {
            calls.publish++;
            assert.equal(input.action, "commit_push");
            assert.equal(input.threadId, run.threadId);
            assert.equal(input.cwd, cwd);
            return Effect.succeed({
              action: "commit_push",
              branch: { status: "skipped_not_requested" },
              commit: { status: "created" },
              push: { status: "pushed" },
              pr: { status: "skipped_not_requested" },
              toast: { title: "Pushed", cta: { kind: "none" } },
            });
          },
          createWorktree: (input) => {
            calls.worktree++;
            assert.strictEqual(input.newRefName, run.branch);
            assert.strictEqual(input.refName, "HEAD");
            return Effect.succeed({ worktree: { path: cwd, refName: run.branch } });
          },
        }),
        Layer.mock(ProjectSetupScriptRunner)({
          runForThread: () => {
            calls.setup++;
            return Effect.succeed({
              status: "started",
              scriptId: "setup",
              scriptName: "Setup",
              scriptCommand: "test",
              terminalId: "setup",
              cwd,
              completion: Ref.get(setupExit).pipe(
                Effect.map((exitCode) => ({ exitCode, durationMs: 1 })),
              ),
            });
          },
        }),
        Layer.mock(ProjectionSnapshotQuery)({
          getThreadDetailById: () =>
            Effect.succeed(
              Option.some({
                latestTurn: { turnId: TurnId.make("review-turn"), state: "completed" },
                session: null,
                messages: [],
              } as unknown as OrchestrationThread),
            ),
          getProjectShellById: () =>
            Ref.get(projectRoot).pipe(
              Effect.map((workspaceRoot) =>
                Option.some({ workspaceRoot } as OrchestrationProjectShell),
              ),
            ),
        }),
        Layer.mock(OrchestrationEngineService)({
          dispatch: (command) => {
            commands.push(command);
            return Effect.succeed({ sequence: commands.length });
          },
        }),
        Layer.mock(TerminalManager)({}),
        Layer.mock(PullRequestService)({
          invalidate: () => Effect.void,
          detail: () =>
            Ref.get(closed).pipe(
              Effect.map(
                (closed) =>
                  ({
                    state: closed ? "merged" : "open",
                    headBranch: run.branch,
                  }) as PullRequestDetail,
              ),
            ),
        }),
        Processes.layer,
        Layer.succeed(HostProcessPlatform, "linux"),
      ),
    ),
  );
  yield* runtime.validate(
    cwd,
    "git init --initial-branch=task/branch && git -c user.name=Test -c user.email=test@example.invalid commit --allow-empty -m initial",
  );
  return { runtime, item, run, cwd, dirty, setupExit, commands, calls, closed, projectRoot };
});
it.effect("uses the Git workflow and project setup, and refuses a dirty source checkout", () =>
  Effect.gen(function* () {
    const ctx = yield* setup;
    yield* Ref.set(ctx.dirty, true);
    const error = yield* ctx.runtime
      .prepare(ctx.run, ctx.item, () => Effect.void)
      .pipe(Effect.flip);
    assert.include(error.message, "clean checkout");
    assert.strictEqual(ctx.calls.worktree, 0);
    yield* Ref.set(ctx.dirty, false);
    const stages: boolean[] = [];
    assert.strictEqual(
      yield* ctx.runtime.prepare(ctx.run, ctx.item, (_path, ready) =>
        Effect.sync(() => {
          stages.push(ready ?? false);
        }),
      ),
      ctx.cwd,
    );
    assert.deepEqual(stages, [false, true]);
    assert.strictEqual(ctx.calls.setup, 1);
    assert.deepEqual(
      ctx.commands.map((command) => command.type),
      ["thread.create"],
    );
    assert.deepEqual(ctx.commands[0], {
      type: "thread.create",
      commandId: CommandId.make("execution-thread:run"),
      threadId: ctx.run.threadId,
      projectId: ctx.item.projectId!,
      title: "Task",
      modelSelection: ctx.run.modelSelection,
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: ctx.run.branch,
      worktreePath: ctx.cwd,
      createdAt: at,
    });
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
it.effect("a failed setup blocks handoff and preserves the created thread", () =>
  Effect.gen(function* () {
    const ctx = yield* setup;
    yield* Ref.set(ctx.setupExit, 1);
    const error = yield* ctx.runtime
      .prepare(ctx.run, ctx.item, () => Effect.void)
      .pipe(Effect.flip);
    assert.include(error.message, "setup failed");
    assert.strictEqual(ctx.commands.length, 1);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
it.effect("runs real validation commands in the worktree and captures nonzero exits", () =>
  Effect.gen(function* () {
    const ctx = yield* setup;
    const result = yield* ctx.runtime.validate(ctx.cwd, "pwd; printf validation-output; exit 3");
    assert.strictEqual(result.code, 3);
    assert.include(result.stdout, "validation-output");
    const fs = yield* FileSystem.FileSystem;
    assert.include(result.stdout, yield* fs.realPath(ctx.cwd));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect(
  "review prompts reuse the original thread and validated publication uses commit/push only",
  () =>
    Effect.gen(function* () {
      const ctx = yield* setup;
      const run: WorkExecution = {
        ...ctx.run,
        worktreePath: ctx.cwd,
        turnId: TurnId.make("review-turn"),
        review: {
          reference: {
            projectId: ctx.item.projectId!,
            repository: "acme/app",
            host: "github.com",
            number: 7,
          },
          feedbackFingerprint: "v1",
          feedback: "Fix rounding; failed checks",
          previousTurnId: null,
          previousUserMessageIds: [],
        },
      };
      yield* ctx.runtime.start(run, ctx.item, { content: { summary: "Invoices" } } as WorkPlan, "");
      const command = ctx.commands[0]!;
      assert.equal(command.type, "thread.turn.start");
      if (command.type === "thread.turn.start") {
        assert.equal(command.threadId, ctx.run.threadId);
        assert.include(command.message.text, "Fix rounding; failed checks");
        assert.include(command.message.text, "[WORK_ITEM_COMPLETE]");
      }
      yield* ctx.runtime.publish(run);
      assert.equal(ctx.calls.publish, 1);
      yield* Ref.set(ctx.closed, true);
      const error = yield* ctx.runtime.publish(run).pipe(Effect.flip);
      assert.include(error.message, "no longer open");
      assert.equal(ctx.calls.publish, 1);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it("matches actual Git remote identity without accepting a lookalike host or repository", () => {
  const repo = { host: "github.com", repository: "example/repo" };
  for (const remote of [
    "git@github.com:example/repo.git",
    "ssh://git@github.com/example/repo.git",
    "https://github.com/example/repo.git",
  ])
    assert.isTrue(matchesAutomationRepository(remote, repo));
  for (const remote of [
    "https://github.com.evil.test/example/repo.git",
    "git@github.com:other/repo.git",
    "/local/example/repo",
    "https://github.com/example/repo-other.git",
  ])
    assert.isFalse(matchesAutomationRepository(remote, repo));
});

it.effect(
  "autonomous work checks origin before setup and preserves the selected permission mode",
  () =>
    Effect.gen(function* () {
      const ctx = yield* setup;
      yield* ctx.runtime.validate(
        ctx.cwd,
        "git init -q && git remote add origin https://github.com/example/repo.git",
      );
      yield* Ref.set(ctx.projectRoot, ctx.cwd);
      const automation = {
        ruleId: "rule",
        runId: "run",
        ruleRevision: 1,
        repository: { host: "github.com", repository: "example/repo" },
        permissionMode: "auto-accept-edits" as const,
        requireTests: true,
        requirePullRequest: true,
      };
      yield* ctx.runtime.prepare({ ...ctx.run, automation }, ctx.item, () => Effect.void);
      const created = ctx.commands[0]!;
      assert.strictEqual(created.type, "thread.create");
      if (created.type === "thread.create")
        assert.strictEqual(created.runtimeMode, "auto-accept-edits");
      const plan = WorkPlan.make({
        workItemId: ctx.item.id,
        revision: 1,
        generationId: "plan",
        status: "approved",
        modelSelection: ctx.run.modelSelection,
        agentName: "Codex",
        threadId: ThreadId.make("plan"),
        createdAt: at,
        generatedAt: at,
        updatedAt: at,
        sourceWorkItemRevision: 1,
        approvedWorkItemRevision: 1,
        approvedAt: at,
        content: null,
        error: null,
        inspectedFiles: [],
      });
      yield* ctx.runtime.start(
        { ...ctx.run, automation, worktreePath: ctx.cwd },
        ctx.item,
        plan,
        "",
      );
      const turn = ctx.commands[1]!;
      assert.strictEqual(turn.type, "thread.turn.start");
      if (turn.type === "thread.turn.start")
        assert.strictEqual(turn.runtimeMode, "auto-accept-edits");
      yield* ctx.runtime.validate(
        ctx.cwd,
        "git remote set-url origin https://github.com/other/repo.git",
      );
      const mismatch = yield* ctx.runtime
        .prepare({ ...ctx.run, automation }, ctx.item, () => Effect.void)
        .pipe(Effect.result);
      assert.strictEqual(mismatch._tag, "Failure");
      assert.strictEqual(ctx.calls.worktree, 1);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("refuses a missing worktree or deleted execution branch while retaining files", () =>
  Effect.gen(function* () {
    const ctx = yield* setup;
    const fs = yield* FileSystem.FileSystem;
    const run = { ...ctx.run, worktreePath: ctx.cwd };
    yield* ctx.runtime.verifyWorktree(run);
    yield* fs.writeFileString(`${ctx.cwd}/retained.txt`, "Keep this work");
    yield* ctx.runtime.validate(ctx.cwd, "git update-ref -d refs/heads/task/branch");
    assert.strictEqual(
      (yield* ctx.runtime.verifyWorktree(run).pipe(Effect.result))._tag,
      "Failure",
    );
    assert.isTrue(yield* fs.exists(`${ctx.cwd}/retained.txt`));
    assert.strictEqual(
      (yield* ctx.runtime
        .verifyWorktree({ ...run, worktreePath: `${ctx.cwd}/missing` })
        .pipe(Effect.result))._tag,
      "Failure",
    );
    assert.strictEqual(ctx.commands.length, 0);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
