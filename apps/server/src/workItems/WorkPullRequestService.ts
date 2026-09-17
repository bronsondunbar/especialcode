import { makeWorkActivityRepository, activityId } from "../persistence/WorkActivity.ts";
import {
  CommandId,
  WorkExecution,
  WorkPlan,
  WorkPullRequestError,
  WorkPullRequestMutation,
  WorkPullRequestRecord,
  type WorkItemId,
  type WorkItem,
  type WorkPullRequestState,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { makeWorkItemRepository } from "../persistence/WorkItems.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { createdPullRequestKey, linkCreatedPullRequest } from "../git/linkCreatedPullRequest.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { PullRequestService } from "../pullRequest/PullRequestService.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { WorkItemService } from "./WorkItemService.ts";
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const encodeRecord = Schema.encodeSync(Schema.fromJsonString(WorkPullRequestRecord));
const decodeRecord = Schema.decodeUnknownEffect(Schema.fromJsonString(WorkPullRequestRecord));
const decodeRun = Schema.decodeUnknownEffect(Schema.fromJsonString(WorkExecution));
const decodePlan = Schema.decodeUnknownEffect(Schema.fromJsonString(WorkPlan));
const isWorkPullRequestError = Schema.is(WorkPullRequestError);
const decodeMutation = Schema.decodeUnknownEffect(WorkPullRequestMutation);
const fail = (code: WorkPullRequestError["code"], message: string) =>
  new WorkPullRequestError({ code, message });
const mapError = (cause: unknown) =>
  isWorkPullRequestError(cause)
    ? cause
    : fail(
        "unavailable",
        cause instanceof Error
          ? cause.message
          : "Pull request operation failed. Refresh and retry.",
      );
export function pullRequestDraft(item: WorkItem, run: WorkExecution | null, plan: WorkPlan | null) {
  return {
    title: item.title.slice(0, 256),
    body: [
      "## Summary",
      (plan?.content?.summary || item.body || item.title).slice(0, 20_000),
      "## Changes",
      (run?.changedFiles.map((path) => `- ${path}`).join("\n") || "See the branch diff.").slice(
        0,
        10_000,
      ),
      "## Testing",
      (
        run?.validationResults
          .map(
            (result) =>
              `- ${result.command}: ${result.timedOut ? "timed out" : `exit ${result.exitCode ?? "unknown"}`}`,
          )
          .join("\n") || "No validation recorded."
      ).slice(0, 10_000),
      "## References",
      `WorkItem: ${item.id}`,
      item.resources
        .filter((resource) => resource.source === "github_issue")
        .map((resource) => `Issue: ${resource.url}`)
        .join("\n")
        .slice(0, 10_000),
    ].join("\n\n"),
  };
}
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const repo = yield* makeWorkItemRepository;
  const work = yield* WorkItemService;
  const git = yield* GitWorkflowService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const prs = yield* PullRequestService;
  const engine = yield* OrchestrationEngineService;
  const read = Effect.fn("WorkPullRequest.read")(function* (id: WorkItemId) {
    const rows = yield* sql<{
      record_json: string;
    }>`SELECT record_json FROM work_item_pull_requests WHERE work_item_id=${id}`;
    return rows[0] ? yield* decodeRecord(rows[0].record_json) : null;
  });
  const save = (record: WorkPullRequestRecord) =>
    sql`INSERT INTO work_item_pull_requests(work_item_id,record_json) VALUES (${record.workItemId},${encodeRecord(record)}) ON CONFLICT(work_item_id) DO UPDATE SET record_json=excluded.record_json`;
  const context = Effect.fn("WorkPullRequest.context")(function* (id: WorkItemId) {
    const item = yield* work.get(id);
    const rows = yield* sql<{
      record_json: string;
    }>`SELECT record_json FROM work_item_executions WHERE work_item_id=${id} ORDER BY rowid DESC LIMIT 1`;
    const run = rows[0] ? yield* decodeRun(rows[0].record_json) : null;
    const plans = run
      ? yield* sql<{
          record_json: string;
        }>`SELECT record_json FROM work_item_plan_history WHERE work_item_id=${id} AND revision=${run.planRevision}`
      : [];
    const plan = plans[0] ? yield* decodePlan(plans[0].record_json) : null;
    const unavailableReason = item.archivedAt
      ? "Restore the WorkItem first."
      : !["running", "review"].includes(item.status)
        ? "Start work on this task before creating a pull request."
        : !run || run.status !== "succeeded" || !run.worktreePath
          ? "Complete execution and validation before creating a pull request."
          : item.agentThreadId !== run.threadId || item.branch !== run.branch
            ? "The WorkItem no longer matches its completed execution."
            : null;
    return { item, run, plan, unavailableReason };
  });
  const get = Effect.fn("WorkPullRequest.get")(function* (
    id: WorkItemId,
  ): Effect.fn.Return<WorkPullRequestState, WorkPullRequestError> {
    const { item, run, plan, unavailableReason } = yield* context(id).pipe(
      Effect.mapError(mapError),
    );
    const record = yield* read(id).pipe(Effect.mapError(mapError));
    const remote = record?.reference
      ? yield* Effect.all(
          {
            detail: prs.detail(record.reference),
            activity: prs.activity(record.reference),
            summary: prs.summary(record.reference),
          },
          { concurrency: 3 },
        ).pipe(
          Effect.map((value) => ({ ...value, refreshError: null })),
          Effect.catch((error) =>
            Effect.succeed({
              detail: null,
              activity: null,
              summary: null,
              refreshError: error.message,
            }),
          ),
        )
      : { detail: null, activity: null, summary: null, refreshError: null };
    return {
      item,
      draft:
        record && record.executionId === run?.id
          ? record.content
          : pullRequestDraft(item, run, plan),
      record,
      unavailableReason,
      ...remote,
    };
  });
  const mutate = Effect.fn("WorkPullRequest.mutate")(
    function* (raw: WorkPullRequestMutation) {
      const input = yield* decodeMutation(raw).pipe(
        Effect.mapError(() => fail("invalid", "Invalid pull request command.")),
      );
      if (input.kind !== "create") {
        const record = yield* read(input.id);
        if (!record?.reference) return yield* fail("invalid", "Create a pull request first.");
        if (input.kind === "merge")
          yield* prs.runAction({
            ...record.reference,
            action: "merge",
            mergeMethod: input.mergeMethod,
          });
        yield* prs.invalidate({ reference: record.reference });
        yield* work.notifyChange;
        return;
      }
      const request = json(input);
      const admitted = yield* sql.withTransaction(
        Effect.gen(function* () {
          const receipts = yield* sql<{
            request_json: string;
          }>`SELECT request_json FROM work_item_pull_request_commands WHERE command_id=${input.commandId}`;
          if (receipts[0] && receipts[0].request_json !== request)
            return yield* fail(
              "conflict",
              "This command ID was already used for different content.",
            );
          const existing = yield* read(input.id);
          if (existing?.status === "linked") return null;
          if (existing?.status === "creating")
            return yield* fail(
              "conflict",
              "Pull request creation is already running. Refresh for its result.",
            );
          const ctx = yield* context(input.id);
          if (ctx.unavailableReason) return yield* fail("invalid", ctx.unavailableReason);
          if (ctx.item.revision !== input.expectedRevision)
            return yield* fail(
              "conflict",
              "The WorkItem changed. Refresh and review the draft again.",
            );
          const record: WorkPullRequestRecord = {
            workItemId: input.id,
            executionId: ctx.run!.id,
            commandId: input.commandId,
            status: "creating",
            content: input.content,
            reference: null,
            url: null,
            error: null,
          };
          yield* save(record);
          if (!receipts[0])
            yield* sql`INSERT INTO work_item_pull_request_commands(command_id,request_json) VALUES (${input.commandId},${request})`;
          return { ...ctx, record };
        }),
      );
      if (!admitted) return;
      yield* work.notifyChange;
      yield* Effect.gen(function* () {
        const { run, item, record } = admitted;
        const cwd = run!.worktreePath!;
        const thread = yield* snapshots.getThreadDetailById(run!.threadId);
        if (
          Option.isNone(thread) ||
          thread.value.deletedAt ||
          thread.value.projectId !== item.projectId ||
          thread.value.worktreePath !== cwd ||
          thread.value.session?.activeTurnId
        )
          return yield* fail(
            "invalid",
            "The execution thread is unavailable or has active work. Finish it before publishing.",
          );
        yield* git.invalidateStatus(cwd);
        const status = yield* git.localStatus({ cwd });
        if (!status.isRepo || status.refName !== run!.branch || status.isDefaultRef)
          return yield* fail("invalid", "The worktree must still be on its execution branch.");
        const result = yield* git.runStackedAction({
          actionId: input.commandId,
          cwd,
          action: "commit_push_pr",
          commitMessage: input.content.title,
          pullRequestContent: input.content,
          threadId: run!.threadId,
        });
        const activity = yield* makeWorkActivityRepository;
        if (result.commit.status === "created" && result.commit.commitSha)
          yield* activity.append({
            id: activityId(`commit:${item.id}:${result.commit.commitSha}`),
            workItemId: item.id,
            kind: "commit_created",
            source: "work",
            occurredAt: DateTime.formatIso(yield* DateTime.now),
            title: "Commit created",
            summary: result.commit.subject?.slice(0, 1000) ?? "",
            threadId: run!.threadId,
            url: null,
            details: [{ label: "Commit", value: result.commit.commitSha.slice(0, 500) }],
          });
        const project = item.projectId
          ? Option.getOrUndefined(yield* snapshots.getProjectShellById(item.projectId))
          : undefined;
        const key = createdPullRequestKey(result, project);
        if (!key || !item.projectId)
          return yield* fail(
            "unavailable",
            "Git finished but did not return a pull request URL. Refresh or retry to recover the existing PR.",
          );
        const reference = {
          projectId: item.projectId,
          host: key.host,
          repository: key.repository,
          number: key.number,
        };
        yield* sql.withTransaction(
          Effect.gen(function* () {
            const current = yield* repo.get(item.id);
            if (!current) return yield* fail("invalid", "The WorkItem is unavailable.");
            const resource = {
              source: "github_pr" as const,
              namespace: `${key.host}/${key.repository}`,
              externalId: String(key.number),
              url: key.url,
            };
            const owner = yield* repo.resourceOwner(resource);
            if (owner && owner !== item.id)
              return yield* fail("conflict", "This PR already belongs to another WorkItem.");
            const next = {
              ...current,
              status: current.status === "done" ? ("done" as const) : ("review" as const),
              failureReason: null,
              resources: [
                ...current.resources.filter(
                  (entry) =>
                    !(
                      entry.source === resource.source &&
                      entry.namespace === resource.namespace &&
                      entry.externalId === resource.externalId
                    ),
                ),
                resource,
              ],
              revision: current.revision + 1,
              updatedAt: DateTime.formatIso(yield* DateTime.now),
            };
            yield* repo.save(next);
            yield* repo.record(
              `work-pr:${input.commandId}`,
              request,
              "pr_created",
              next,
              json(reference),
            );
            yield* save({ ...record, status: "linked", reference, url: key.url });
          }),
        );
        yield* linkCreatedPullRequest({
          threadId: run!.threadId,
          result,
          commandId: Effect.succeed(CommandId.make(`work-pr-link:${input.commandId}`)),
        }).pipe(
          Effect.provideService(OrchestrationEngineService, engine),
          Effect.provideService(ProjectionSnapshotQuery, snapshots),
        );
        yield* prs.invalidate({ reference });
      }).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            const committed = yield* read(input.id);
            // A PR already committed locally remains linked even if thread linking or cache invalidation fails.
            if (committed?.status !== "linked")
              yield* save({ ...admitted.record, status: "failed", error: mapError(error).message });
            yield* Effect.logWarning("WorkItem PR operation needs recovery").pipe(
              Effect.annotateLogs({
                workItemId: input.id,
                stage: committed?.status === "linked" ? "after-link" : "creation",
              }),
            );
            return yield* mapError(error);
          }),
        ),
        Effect.ensuring(work.notifyChange),
      );
    },
    Effect.mapError(mapError),
    Effect.uninterruptible,
  );
  // Never replay a commit, push or provider mutation after a server restart.
  const rows = yield* sql<{ record_json: string }>`SELECT record_json FROM work_item_pull_requests`;
  for (const row of rows) {
    const record = yield* decodeRecord(row.record_json);
    if (record.status === "creating")
      yield* save({
        ...record,
        status: "failed",
        error:
          "The server restarted during creation. Inspect the branch and retry to recover an existing PR.",
      });
  }
  return {
    get,
    mutate,
    subscribe: (id: WorkItemId) => work.changes.pipe(Stream.mapEffect(() => get(id))),
  };
});
export class WorkPullRequestService extends Context.Service<
  WorkPullRequestService,
  Effect.Success<typeof make>
>()("t3/workItems/WorkPullRequestService") {}
