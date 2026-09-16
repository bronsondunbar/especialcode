import * as NodeCrypto from "node:crypto";
import {
  WorkTaskUpdateInput,
  type GitHubIssuesError,
  type SlackError,
  WorkTaskUpdateError,
  workTaskDiscussionSources,
  type WorkTaskUpdateResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { WorkItemService } from "./WorkItemService.ts";
import { GitHubIssuesService } from "../integrations/github/GitHubIssuesService.ts";
import { GitHubIssuesAdapter } from "../integrations/github/GitHubIssuesAdapter.ts";
import { SlackService } from "../integrations/slack/SlackService.ts";

const failure = (message: string, uncertain = false) =>
  new WorkTaskUpdateError({ message, uncertain });
const encodeFingerprint = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const decode = Schema.decodeUnknownEffect(WorkTaskUpdateInput);
const isError = Schema.is(WorkTaskUpdateError);
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tasks = yield* WorkItemService;
  const github = yield* GitHubIssuesService;
  const githubAdapter = yield* GitHubIssuesAdapter;
  const slack = yield* SlackService;
  const lock = yield* Semaphore.make(1);
  const post = Effect.fn("WorkTaskUpdateService.post")(
    function* (raw: WorkTaskUpdateInput) {
      const input = yield* decode(raw).pipe(Effect.mapError(() => failure("Invalid update.")));
      if (!input.body.trim()) return yield* failure("Write an update before posting.");
      const fingerprint = NodeCrypto.createHash("sha256")
        .update(encodeFingerprint([input.taskId, input.threadId, input.sourceKey, input.body]))
        .digest("hex");
      const receipt = yield* sql<{
        fingerprint: string;
        url: string | null;
      }>`SELECT fingerprint, url FROM work_task_updates WHERE command_id=${input.commandId}`;
      if (receipt[0]) {
        if (receipt[0].fingerprint !== fingerprint)
          return yield* failure("This posting request was already used for a different update.");
        if (receipt[0].url) return { url: receipt[0].url };
        return yield* failure(
          "Posting could not be confirmed. Check the original conversation before drafting another update. This request will not be sent again.",
          true,
        );
      }
      const task = yield* tasks.get(input.taskId);
      if (task.agentThreadId !== input.threadId)
        return yield* failure("This task is no longer linked to this thread.");
      const source = workTaskDiscussionSources(task).find(
        (source) => source.key === input.sourceKey,
      );
      if (!source) return yield* failure("This source is no longer attached to the task.");
      let send: Effect.Effect<WorkTaskUpdateResult, GitHubIssuesError | SlackError>;
      if (source.kind === "github") {
        const issue = yield* github.get(source.reference);
        if (
          !task.resources.some(
            (resource) =>
              resource.source === "github_issue" &&
              resource.externalId === issue.externalId &&
              resource.namespace.toLowerCase() ===
                `${issue.host}/${issue.repository}`.toLowerCase(),
          )
        )
          return yield* failure("The saved GitHub issue does not match this task.");
        send = githubAdapter.comment(source.reference, input.body);
      } else {
        const reply = yield* slack.prepareReply(source.reference);
        send = reply(input.body, input.commandId);
      }
      const claimed =
        yield* sql`INSERT INTO work_task_updates(command_id, fingerprint) VALUES (${input.commandId}, ${fingerprint}) ON CONFLICT DO NOTHING RETURNING command_id`;
      if (claimed.length === 0)
        return yield* failure(
          "This update is already being posted. Check the source before trying again.",
          true,
        );
      // No automatic resend after an ambiguous network failure or server interruption.
      const result = yield* send.pipe(Effect.result);
      if (result._tag === "Failure") {
        const error = result.failure;
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          ["authentication", "rate_limit", "not_found"].includes(String(error.code))
        ) {
          yield* sql`DELETE FROM work_task_updates WHERE command_id=${input.commandId}`;
          return yield* failure(
            "message" in error ? String(error.message) : "Could not post the update.",
          );
        }
        return yield* failure(
          "Posting could not be confirmed. Check the original conversation before drafting another update. This request will not be sent again.",
          true,
        );
      }
      yield* sql`UPDATE work_task_updates SET url=${result.success.url} WHERE command_id=${input.commandId}`.pipe(
        Effect.mapError(() =>
          failure(
            "The update was sent, but confirmation could not be saved. Check the original conversation before posting again.",
            true,
          ),
        ),
      );
      return result.success;
    },
    lock.withPermits(1),
    Effect.mapError((error) =>
      isError(error)
        ? error
        : failure(
            typeof error === "object" && error !== null && "message" in error
              ? String(error.message)
              : "Could not prepare the update.",
          ),
    ),
  );
  return { post };
});
export class WorkTaskUpdateService extends Context.Service<
  WorkTaskUpdateService,
  Effect.Success<typeof make>
>()("t3/workItems/WorkTaskUpdateService") {}
