import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  WorkItem,
  WorkItemId,
  WorkItemError,
  WS_METHODS,
  type SlackMutation,
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
  loadWorkTaskDiscussion,
  workTaskDiscussionSources,
  workTaskPromptWithDiscussion,
} from "./workTaskDiscussion.ts";
const github = {
  source: "github_issue" as const,
  namespace: "github.com/example/repo",
  externalId: "999",
  url: "https://github.com/example/repo/issues/12",
};
const slack = {
  source: "slack" as const,
  namespace: "T123/C123",
  externalId: "1760000000.000001",
  url: "https://example.slack.com/archives/C123/p1760000000000001",
};
const task = WorkItem.make({
  id: WorkItemId.make("task-1"),
  title: "Task",
  body: "Original instructions",
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
  resources: [github, slack],
  status: "inbox",
  revision: 1,
  createdAt: "now",
  updatedAt: "now",
  completedAt: null,
  archivedAt: null,
});
const setup = Effect.fn("TestTaskDiscussion.setup")(function* (
  options: { fail?: boolean; noComments?: boolean; huge?: boolean; detached?: boolean } = {},
) {
  const calls: string[] = [];
  let current = options.detached ? { ...task, resources: [] } : task;
  let more = false;
  const client = {
    [WS_METHODS.workItemsGet]: () => Effect.sync(() => current),
    [WS_METHODS.githubIssuesMutate]: (input: { kind: string; number: number }) =>
      Effect.gen(function* () {
        calls.push(`github:${input.kind}:${input.number}`);
        if (options.fail)
          return yield* new WorkItemError({ code: "invalid", message: "Token expired" });
        current = { ...current, revision: 2 };
      }),
    [WS_METHODS.githubIssuesGet]: () =>
      Effect.sync(() => {
        calls.push("github:get");
        return {
          syncStatus: "ready",
          body: "Issue description",
          comments: options.noComments
            ? []
            : [
                {
                  id: "comment-1",
                  author: "alice",
                  createdAt: "2026-09-16T09:00:00Z",
                  url: `${github.url}#issuecomment-1`,
                  body: options.huge ? "A".repeat(100_000) : "Include archived results.",
                },
              ],
        };
      }),
    [WS_METHODS.slackMutate]: (input: SlackMutation) =>
      Effect.sync(() => {
        expect(input.kind).toBe("thread");
        more = input.kind === "thread" && input.more === true;
        calls.push(`slack:thread:${more}`);
        return { workItemId: null, hasMore: !more };
      }),
    [WS_METHODS.slackGet]: () =>
      Effect.sync(() => {
        calls.push("slack:get");
        return {
          nextCursor: more ? "" : "next-page",
          replies: [
            { author: "U123", ts: slack.externalId, text: "Original Slack message" },
            ...(more ? [{ author: "U456", ts: "1760000000.000002", text: "Reply context" }] : []),
          ],
        };
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
  return { calls, provide: Effect.provideService(EnvironmentSupervisor, supervisor) };
});
describe("optional task discussion context", () => {
  it("derives issue numbers and Slack references from attached sources and rejects mismatched URLs", () => {
    const sources = workTaskDiscussionSources({
      ...task,
      resources: [
        github,
        github,
        slack,
        { ...github, url: "https://elsewhere.test/other/repo/issues/12" },
      ],
    });
    expect(sources).toHaveLength(2);
    expect(sources[0]).toMatchObject({
      kind: "github",
      reference: { host: "github.com", repository: "example/repo", number: 12 },
    });
    expect(sources[1]).toMatchObject({
      kind: "slack",
      reference: { workspaceId: "T123", channelId: "C123", ts: slack.externalId },
    });
  });
  it.effect(
    "refreshes comments, includes attribution, and returns the task revision changed by the refresh",
    () =>
      Effect.gen(function* () {
        const harness = yield* setup();
        const source = workTaskDiscussionSources(task)[0]!;
        const result = yield* loadWorkTaskDiscussion({
          taskId: task.id,
          sourceKey: source.key,
        }).pipe(harness.provide);
        expect(harness.calls).toEqual(["github:refresh:12", "github:get"]);
        expect(result.task.revision).toBe(2);
        expect(result.githubIssue?.body).toBe("Issue description");
        expect(result.githubIssue?.comments[0]).toMatchObject({
          id: "comment-1",
          author: "alice",
          body: "Include archived results.",
        });
        expect(result.context.text).toContain("@alice");
        expect(result.context.text).toContain("Include archived results.");
        expect(result.context.text).toContain("2026-09-16T09:00:00Z");
        expect(workTaskPromptWithDiscussion("My edited prompt", [result.context])).toContain(
          "My edited prompt\n\nReference discussion:",
        );
        expect(workTaskPromptWithDiscussion("My edited prompt", [])).toBe("My edited prompt");
      }),
  );
  it.effect(
    "loads Slack thread pages on demand and replaces the preview without duplicate replies",
    () =>
      Effect.gen(function* () {
        const harness = yield* setup();
        const sourceKey = workTaskDiscussionSources(task)[1]!.key;
        const first = yield* loadWorkTaskDiscussion({ taskId: task.id, sourceKey }).pipe(
          harness.provide,
        );
        expect(first.context.hasMore).toBe(true);
        expect(first.githubIssue).toBeNull();
        expect(first.context.text).toContain("partial thread");
        const next = yield* loadWorkTaskDiscussion({ taskId: task.id, sourceKey, more: true }).pipe(
          harness.provide,
        );
        expect(next.context.hasMore).toBe(false);
        expect(next.context.text).toContain("Reply context");
        expect(next.context.text.match(/Original Slack message/g)).toHaveLength(1);
        expect(harness.calls).toEqual([
          "slack:thread:false",
          "slack:get",
          "slack:thread:true",
          "slack:get",
        ]);
      }),
  );
  it.effect("reports expired access and detached sources without substituting stale context", () =>
    Effect.gen(function* () {
      const sourceKey = workTaskDiscussionSources(task)[0]!.key;
      for (const options of [{ fail: true }, { detached: true }]) {
        const harness = yield* setup(options);
        expect(
          (yield* loadWorkTaskDiscussion({ taskId: task.id, sourceKey }).pipe(
            harness.provide,
            Effect.result,
          ))._tag,
        ).toBe("Failure");
        expect(harness.calls).not.toContain("github:get");
      }
    }),
  );
  it.effect("shows an empty discussion explicitly and marks oversized context as shortened", () =>
    Effect.gen(function* () {
      const sourceKey = workTaskDiscussionSources(task)[0]!.key;
      const empty = yield* setup({ noComments: true });
      expect(
        (yield* loadWorkTaskDiscussion({ taskId: task.id, sourceKey }).pipe(empty.provide)).context
          .text,
      ).toContain("No comments");
      const huge = yield* setup({ huge: true });
      const result = yield* loadWorkTaskDiscussion({ taskId: task.id, sourceKey }).pipe(
        huge.provide,
      );
      expect(result.context.truncated).toBe(true);
      expect(result.context.text.length).toBeLessThan(25_000);
      expect(result.context.text).toContain("Discussion shortened");
    }),
  );
});
