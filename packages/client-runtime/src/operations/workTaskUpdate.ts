import {
  WS_METHODS,
  workTaskDiscussionSources,
  type ThreadId,
  type WorkItemSummary,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { request } from "../rpc/client.ts";

/** Use the agent's actual response; never invent completion or verification claims. */
export function workTaskUpdateDraft(
  messages: ReadonlyArray<{ role: string; text: string; streaming: boolean }>,
) {
  const response = messages.findLast(
    (message) => message.role === "assistant" && !message.streaming && message.text.trim(),
  );
  const text = response?.text.trim() ?? "";
  return { body: text.slice(0, 4000), truncated: text.length > 4000 };
}
export const loadThreadUpdateTargets = Effect.fn("WorkTaskUpdate.targets")(function* (input: {
  threadId: ThreadId;
}) {
  const tasks: WorkItemSummary[] = [];
  for (const archived of [false, true]) {
    let offset = 0;
    while (true) {
      const page = yield* request(WS_METHODS.workItemsList, {
        agentThreadId: input.threadId,
        archived,
        offset,
        limit: 100,
      });
      tasks.push(...page.items);
      offset += page.items.length;
      if (offset >= page.total || page.items.length === 0) break;
    }
  }
  return tasks.flatMap((task) =>
    workTaskDiscussionSources(task).map((source) => ({
      taskId: task.id,
      taskTitle: task.title,
      source,
    })),
  );
});
