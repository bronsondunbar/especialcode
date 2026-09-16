import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ORCHESTRATION_WS_METHODS,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WorkItem,
  WorkItemError,
  WorkItemId,
  WS_METHODS,
  type ClientOrchestrationCommand,
  type WorkItemMutation,
  type VcsCreateWorktreeInput,
  type VcsListRefsInput,
  type VercelLinkInput,
  VercelError,
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
import {
  startWorkTaskThread,
  prepareWorkTaskBranch,
  workTaskBranches,
  workTaskProjectId,
  workTaskBranchName,
  workTaskBranchError,
  workTaskPrompt,
  type WorkTaskThreadInput,
} from "./workTaskThread.ts";

const task = WorkItem.make({
  id: WorkItemId.make("task-1"),
  title: "Fix the search",
  body: "Include archived results.",
  projectId: null,
  priority: "medium",
  repository: null,
  branch: "fix/search",
  assignedAgent: null,
  agentThreadId: null,
  parentWorkItemId: null,
  failureReason: null,
  source: "github_issue",
  externalId: "123",
  externalUrl: "https://github.com/example/repo/issues/123",
  resources: [
    {
      source: "github_issue",
      namespace: "example/repo",
      externalId: "123",
      url: "https://github.com/example/repo/issues/123",
    },
  ],
  status: "inbox",
  revision: 1,
  createdAt: "2026-09-15T00:00:00.000Z",
  updatedAt: "2026-09-15T00:00:00.000Z",
  completedAt: null,
  archivedAt: null,
});
const input: WorkTaskThreadInput = {
  task,
  projectId: ProjectId.make("project-1"),
  threadId: ThreadId.make("thread-1"),
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test-model" },
  createdAt: "2026-09-15T01:00:00.000Z",
};
const setup = Effect.fn("TestWorkTaskThread.setup")(function* (
  options: {
    current?: WorkItem;
    failCreate?: boolean;
    failLink?: boolean;
    failBranch?: boolean;
    failVercel?: boolean;
    input?: WorkTaskThreadInput;
  } = {},
) {
  let current = options.current ?? task;
  const commands: ClientOrchestrationCommand[] = [];
  const mutations: WorkItemMutation[] = [];
  const worktrees: VcsCreateWorktreeInput[] = [];
  const refQueries: VcsListRefsInput[] = [];
  const vercelLinks: VercelLinkInput[] = [];
  const client = {
    [WS_METHODS.vercelLink]: (input: VercelLinkInput) =>
      Effect.gen(function* () {
        vercelLinks.push(input);
        if (options.failVercel) return yield* new VercelError({ message: "Vercel unavailable" });
      }),
    [WS_METHODS.vcsListRefs]: (query: VcsListRefsInput) =>
      Effect.sync(() => {
        refQueries.push(query);
        return {
          refs: [
            {
              name: query.cursor ? "origin/release" : "main",
              current: !query.cursor,
              isDefault: !query.cursor,
              worktreePath: null,
            },
          ],
          isRepo: true,
          hasPrimaryRemote: true,
          totalCount: 2,
          nextCursor: query.cursor ? null : 1,
        };
      }),
    [WS_METHODS.vcsCreateWorktree]: (input: VcsCreateWorktreeInput) =>
      Effect.gen(function* () {
        worktrees.push(input);
        if (options.failBranch)
          return yield* new WorkItemError({ code: "conflict", message: "Branch exists" });
        return { worktree: { path: "/worktrees/search", refName: input.newRefName! } };
      }),
    [WS_METHODS.workItemsGet]: () => Effect.sync(() => current),
    [ORCHESTRATION_WS_METHODS.dispatchCommand]: (command: ClientOrchestrationCommand) =>
      Effect.gen(function* () {
        commands.push(command);
        if (options.failCreate)
          return yield* new WorkItemError({ code: "conflict", message: "Create failed" });
        return { sequence: commands.length };
      }),
    [WS_METHODS.workItemsMutate]: (mutation: WorkItemMutation) =>
      Effect.gen(function* () {
        mutations.push(mutation);
        if (options.failLink)
          return yield* new WorkItemError({ code: "conflict", message: "Task changed" });
        if (mutation.kind === "update")
          current = { ...current, ...mutation.patch, revision: current.revision + 1 };
        return current;
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
    commands,
    vercelLinks,
    mutations,
    worktrees,
    refQueries,
    prepare: (branch = "codex/fix-search") =>
      prepareWorkTaskBranch({ task, cwd: "/repo", baseBranch: "origin/release", branch }).pipe(
        Effect.provideService(EnvironmentSupervisor, supervisor),
      ),
    branches: workTaskBranches({ cwd: "/repo" }).pipe(
      Effect.provideService(EnvironmentSupervisor, supervisor),
    ),
    current: () => current,
    run: startWorkTaskThread(options.input ?? input).pipe(
      Effect.provideService(EnvironmentSupervisor, supervisor),
    ),
  };
});

describe("new thread from task", () => {
  it.effect("creates an idle thread, links its project, and leaves task status unchanged", () =>
    Effect.gen(function* () {
      const harness = yield* setup();
      expect(yield* harness.run).toEqual({ threadId: input.threadId, warning: null });
      expect(harness.commands).toHaveLength(1);
      expect(harness.commands[0]).toMatchObject({
        type: "thread.create",
        threadId: input.threadId,
        projectId: input.projectId,
        title: task.title,
        modelSelection: input.modelSelection,
      });
      expect(harness.current()).toMatchObject({
        agentThreadId: input.threadId,
        projectId: input.projectId,
        status: task.status,
      });
      expect(harness.mutations).toHaveLength(1);
    }),
  );
  it.effect("retries a completed request without creating or linking another thread", () =>
    Effect.gen(function* () {
      const harness = yield* setup();
      yield* harness.run;
      yield* harness.run;
      expect(harness.commands).toHaveLength(1);
      expect(harness.mutations).toHaveLength(1);
    }),
  );
  it.effect("rejects stale or archived tasks before creating a thread", () =>
    Effect.gen(function* () {
      for (const current of [
        { ...task, revision: 2 },
        { ...task, archivedAt: input.createdAt },
      ]) {
        const harness = yield* setup({ current });
        const result = yield* harness.run.pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        expect(harness.commands).toHaveLength(0);
        expect(harness.mutations).toHaveLength(0);
      }
    }),
  );
  it.effect(
    "does not link a task when thread creation fails, and preserves retry command identity",
    () =>
      Effect.gen(function* () {
        const harness = yield* setup({ failCreate: true });
        expect((yield* harness.run.pipe(Effect.result))._tag).toBe("Failure");
        yield* harness.run.pipe(Effect.result);
        expect(harness.mutations).toHaveLength(0);
        expect(harness.commands[0]).toEqual(harness.commands[1]);
      }),
  );
  it.effect("returns the created thread when linking fails so it can still be opened", () =>
    Effect.gen(function* () {
      const harness = yield* setup({ failLink: true });
      const result = yield* harness.run;
      expect(result.threadId).toBe(input.threadId);
      expect(result.warning).toContain("could not be linked");
      expect(harness.commands).toHaveLength(1);
      expect(harness.current().agentThreadId).toBeNull();
    }),
  );
  it.effect(
    "creates a worktree from the selected base and retains it in thread and task metadata",
    () =>
      Effect.gen(function* () {
        const harness = yield* setup({
          input: { ...input, worktree: { path: "/worktrees/search", refName: "codex/fix-search" } },
        });
        yield* harness.prepare();
        expect(harness.worktrees).toEqual([
          {
            cwd: "/repo",
            refName: "origin/release",
            newRefName: "codex/fix-search",
            baseRefName: "origin/release",
            path: null,
          },
        ]);
        yield* harness.run;
        yield* harness.run;
        expect(harness.commands).toHaveLength(1);
        expect(harness.commands[0]).toMatchObject({
          branch: "codex/fix-search",
          worktreePath: "/worktrees/search",
        });
        expect(harness.current().branch).toBe("codex/fix-search");
      }),
  );
  it.effect(
    "can retry thread creation using the prepared worktree without creating another branch",
    () =>
      Effect.gen(function* () {
        const harness = yield* setup({
          failCreate: true,
          input: { ...input, worktree: { path: "/worktrees/search", refName: "codex/fix-search" } },
        });
        yield* harness.prepare();
        yield* harness.run.pipe(Effect.result);
        yield* harness.run.pipe(Effect.result);
        expect(harness.worktrees).toHaveLength(1);
        expect(harness.commands[0]).toEqual(harness.commands[1]);
        expect(harness.mutations).toHaveLength(0);
      }),
  );
  it.effect("rejects stale tasks and invalid names before changing Git", () =>
    Effect.gen(function* () {
      const stale = yield* setup({ current: { ...task, revision: 2 } });
      expect((yield* stale.prepare().pipe(Effect.result))._tag).toBe("Failure");
      expect(stale.worktrees).toHaveLength(0);
      const valid = yield* setup();
      expect((yield* valid.prepare("bad..branch").pipe(Effect.result))._tag).toBe("Failure");
      expect(valid.worktrees).toHaveLength(0);
      const conflict = yield* setup({ failBranch: true });
      expect((yield* conflict.prepare().pipe(Effect.result))._tag).toBe("Failure");
      expect(conflict.commands).toHaveLength(0);
      expect(conflict.mutations).toHaveLength(0);
    }),
  );
  it.effect("loads all base branches, including remote refs and subsequent pages", () =>
    Effect.gen(function* () {
      const harness = yield* setup();
      expect((yield* harness.branches).map((ref) => ref.name)).toEqual(["main", "origin/release"]);
      expect(harness.refQueries).toHaveLength(2);
      expect(harness.refQueries[0]).toMatchObject({
        cwd: "/repo",
        includeMatchingRemoteRefs: true,
      });
      expect(harness.refQueries[1]?.cursor).toBe(1);
    }),
  );
  it("matches GitHub repository identities and respects an existing user selection", () => {
    const project = {
      id: input.projectId,
      repositoryIdentity: {
        canonicalKey: "github.com/example/repo",
        locator: {
          source: "git-remote" as const,
          remoteName: "origin",
          remoteUrl: "git@github.com:example/repo.git",
        },
      },
    };
    const other = { id: ProjectId.make("other"), repositoryIdentity: null };
    expect(workTaskProjectId(task, [other, project])).toBe(project.id);
    expect(workTaskProjectId({ ...task, projectId: other.id }, [other, project])).toBe(other.id);
    expect(workTaskProjectId({ ...task, resources: [] }, [other, project])).toBe("");
    expect(workTaskProjectId(task, [project, { ...project, id: other.id }])).toBe("");
  });
  it("suggests short valid branch names from issue titles and Slack messages", () => {
    expect(workTaskBranchName(task)).toBe("codex/fix-the-search");
    const long = workTaskBranchName({
      ...task,
      title:
        "<@U123> Fix **search** results https://example.com now " +
        "with lots of additional detail ".repeat(30),
    });
    expect(long).toBe("codex/fix-search-results-now-with-lots-of-additional");
    expect(workTaskBranchError(long)).toBeNull();
    expect(workTaskBranchName({ ...task, title: "🔥" })).toBe("codex/work-task");
    for (const name of ["bad name", "a..b", "a.lock", "a/.b", "a/", "-oops", "@", "a:b", "a\\b"])
      expect(workTaskBranchError(name)).not.toBeNull();
  });
  it("includes task context and source links in a bounded editable prompt", () => {
    const prompt = workTaskPrompt(task);
    expect(prompt).toContain(task.title);
    expect(prompt).toContain(task.body);
    expect(prompt).toContain(task.id);
    expect(prompt).toContain(task.branch);
    expect(prompt).toContain(task.resources[0]!.url);
    const shortened = workTaskPrompt({ ...task, body: "a".repeat(100_000) });
    expect(shortened.length).toBeLessThan(31_000);
    expect(shortened).toContain("Description shortened");
    expect(shortened).toContain(task.resources[0]!.url);
  });
});

it.effect("links the chosen Vercel project to the created thread and follows its branch", () =>
  Effect.gen(function* () {
    const harness = yield* setup({
      input: { ...input, vercel: { project: "prj_app" }, branch: "main" },
    });
    expect((yield* harness.run).warning).toBeNull();
    expect(harness.vercelLinks).toEqual([
      {
        kind: "link",
        projectId: input.projectId,
        threadId: input.threadId,
        vercelProject: "prj_app",
        branch: null,
      },
    ]);
    expect(harness.commands[0]).toMatchObject({ branch: "main" });
  }),
);
it.effect("reports Vercel linking failure without losing the thread or creating it twice", () =>
  Effect.gen(function* () {
    const harness = yield* setup({
      failVercel: true,
      input: { ...input, vercel: { project: "prj_app" } },
    });
    expect((yield* harness.run).warning).toContain("Vercel could not be linked");
    expect((yield* harness.run).threadId).toBe(input.threadId);
    expect(harness.commands).toHaveLength(1);
    expect(harness.mutations).toHaveLength(1);
  }),
);
it.effect("allows opting out of the inherited Vercel connection", () =>
  Effect.gen(function* () {
    const harness = yield* setup({ input: { ...input, vercel: { project: null } } });
    yield* harness.run;
    expect(harness.vercelLinks).toEqual([
      { kind: "unlink", projectId: input.projectId, threadId: input.threadId },
    ]);
  }),
);
