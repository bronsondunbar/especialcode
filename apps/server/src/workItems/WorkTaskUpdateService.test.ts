import { describe, expect, it } from "@effect/vitest";
import {
  ThreadId,
  WorkItemId,
  WorkItem,
  GitHubIssuesError,
  type WorkTaskUpdateInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { WorkItemService } from "./WorkItemService.ts";
import { GitHubIssuesService } from "../integrations/github/GitHubIssuesService.ts";
import { GitHubIssuesAdapter } from "../integrations/github/GitHubIssuesAdapter.ts";
import { SlackService } from "../integrations/slack/SlackService.ts";
import { make } from "./WorkTaskUpdateService.ts";
const task = WorkItem.make({
  id: WorkItemId.make("task"),
  title: "Fix search",
  body: "",
  projectId: null,
  priority: "medium",
  repository: null,
  branch: null,
  assignedAgent: null,
  agentThreadId: ThreadId.make("thread"),
  parentWorkItemId: null,
  failureReason: null,
  source: "github_issue",
  externalId: "123",
  externalUrl: "https://github.com/owner/repo/issues/5",
  resources: [
    {
      source: "github_issue",
      namespace: "github.com/owner/repo",
      externalId: "123",
      url: "https://github.com/owner/repo/issues/5",
    },
    {
      source: "slack",
      namespace: "T123/C123",
      externalId: "1760000000.000001",
      url: "https://example.slack.com/archives/C123/p1760000000000001",
    },
  ],
  status: "review",
  revision: 1,
  createdAt: "2026-09-16T00:00:00Z",
  updatedAt: "2026-09-16T00:00:00Z",
  completedAt: null,
  archivedAt: null,
});
const input: WorkTaskUpdateInput = {
  taskId: task.id,
  threadId: ThreadId.make("thread"),
  sourceKey: "github:github.com/owner/repo:123",
  body: "Fixed search. Tests passed.",
  commandId: "post-1",
};
const setup = Effect.fn("test.setup")(function* (
  options: { fail?: boolean; denied?: boolean; task?: WorkItem } = {},
) {
  const sent: Array<{ kind: string; body: string }> = [];
  const send = (kind: string, body: string) =>
    Effect.gen(function* () {
      sent.push({ kind, body });
      if (options.denied)
        return yield* new GitHubIssuesError({
          code: "authentication",
          message: "Issues write permission required.",
        });
      if (options.fail)
        return yield* new GitHubIssuesError({ message: "Lost connection", code: "unavailable" });
      return { url: `https://example.test/${kind}/posted` };
    });
  const service = yield* make.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(WorkItemService)({ get: () => Effect.succeed(options.task ?? task) }),
        Layer.mock(GitHubIssuesService)({
          get: () =>
            Effect.succeed({
              host: "github.com",
              repository: "owner/repo",
              externalId: "123",
              number: 5,
              title: "Fix search",
              body: "",
              url: task.externalUrl!,
              state: "open" as const,
              labels: [],
              assignees: [],
              milestone: null,
              updatedAt: task.updatedAt,
              comments: [],
              commentsFetchedAt: null,
              workItemId: task.id,
              localStatus: task.status,
            }),
        }),
        Layer.mock(GitHubIssuesAdapter)({ comment: (_ref, body) => send("github", body) }),
        Layer.mock(SlackService)({
          prepareReply: () =>
            Effect.succeed((body: string) =>
              Effect.sync(() => {
                sent.push({ kind: "slack", body });
                return { url: "https://example.test/slack/posted" };
              }),
            ),
        }),
      ),
    ),
  );
  return { service, sent };
});
describe("reviewed task updates", () => {
  it.effect(
    "posts the reviewed text once and reuses the durable receipt across service restarts",
    () =>
      Effect.gen(function* () {
        const { service, sent } = yield* setup();
        const result = yield* service.post(input);
        expect(sent).toEqual([{ kind: "github", body: input.body }]);
        expect(yield* service.post(input)).toEqual(result);
        const restarted = yield* setup();
        expect(yield* restarted.service.post(input)).toEqual(result);
        expect(restarted.sent).toEqual([]);
        expect((yield* service.post({ ...input, body: "Edited" }).pipe(Effect.result))._tag).toBe(
          "Failure",
        );
        expect(sent).toHaveLength(1);
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );
  it.effect("posts only to the chosen linked source", () =>
    Effect.gen(function* () {
      const { service, sent } = yield* setup();
      yield* service.post({ ...input, sourceKey: "slack:T123/C123:1760000000.000001" });
      expect(sent).toEqual([{ kind: "slack", body: input.body }]);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );
  it.effect(
    "rejects detached threads, missing sources, blank and oversized text before sending",
    () =>
      Effect.gen(function* () {
        const { service, sent } = yield* setup();
        for (const patch of [
          { threadId: ThreadId.make("other") },
          { sourceKey: "slack:T123/C999:1760000000.000001" },
          { body: "   " },
          { body: "a".repeat(4001) },
        ]) {
          expect((yield* service.post({ ...input, ...patch }).pipe(Effect.result))._tag).toBe(
            "Failure",
          );
        }
        expect(sent).toEqual([]);
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );
  it.effect("never resends an uncertain write even after restart", () =>
    Effect.gen(function* () {
      const { service, sent } = yield* setup({ fail: true });
      expect((yield* service.post(input).pipe(Effect.flip)).uncertain).toBe(true);
      expect((yield* service.post(input).pipe(Effect.flip)).uncertain).toBe(true);
      expect(sent).toHaveLength(1);
      const restarted = yield* setup();
      expect((yield* restarted.service.post(input).pipe(Effect.flip)).uncertain).toBe(true);
      expect(restarted.sent).toHaveLength(0);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );
  it.effect("permits retry after an explicit permission rejection", () =>
    Effect.gen(function* () {
      const rejected = yield* setup({ denied: true });
      expect((yield* rejected.service.post(input).pipe(Effect.flip)).uncertain).toBe(false);
      const reconnected = yield* setup();
      yield* reconnected.service.post(input);
      expect(reconnected.sent).toHaveLength(1);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );
});
