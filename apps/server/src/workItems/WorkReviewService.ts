import {
  WorkPullRequestRecord,
  WorkPullRequestError,
  WorkReviewSnapshot,
  WorkReviewMutation,
  WorkItemId,
  type WorkItem,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { makeWorkItemRepository } from "../persistence/WorkItems.ts";
import { PullRequestService } from "../pullRequest/PullRequestService.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { WorkItemService } from "./WorkItemService.ts";
import { WorkExecutionService } from "./WorkExecutionService.ts";
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodePr = Schema.decodeUnknownEffect(Schema.fromJsonString(WorkPullRequestRecord));
const decodeSnapshot = Schema.decodeUnknownEffect(Schema.fromJsonString(WorkReviewSnapshot));
const encodeSnapshot = Schema.encodeSync(Schema.fromJsonString(WorkReviewSnapshot));
const decodeMutation = Schema.decodeUnknownEffect(WorkReviewMutation);
const decodeMetadata = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ message: Schema.optional(Schema.NullOr(Schema.String)) })),
);
const hash = (value: unknown) => NodeCrypto.createHash("sha256").update(json(value)).digest("hex");
const fail = (message: string, code: WorkPullRequestError["code"] = "invalid") =>
  new WorkPullRequestError({ code, message });
const isError = Schema.is(WorkPullRequestError);
const mapError = (cause: unknown) =>
  isError(cause)
    ? cause
    : fail(cause instanceof Error ? cause.message : "Could not update PR review.", "unavailable");
function reviewChanges(previous: WorkReviewSnapshot | null, next: WorkReviewSnapshot) {
  const changes: { kind: string; message: string }[] = [];
  if (previous?.reviewDecision !== next.reviewDecision && next.reviewDecision)
    changes.push({
      kind: `pr_${next.reviewDecision.replaceAll("-", "_")}`,
      message: {
        approved: "Reviewer approved",
        "changes-requested": "Reviewer requested changes",
        "review-required": "Review requested",
      }[next.reviewDecision],
    });
  if (json(previous?.reviewers ?? []) !== json(next.reviewers) && next.reviewers.length)
    changes.push({
      kind: "pr_review_requested",
      message: `Reviewers: ${next.reviewers.join(", ")}`,
    });
  const old = new Map(previous?.comments.map((comment) => [comment.id, hash(comment)]) ?? []);
  for (const comment of next.comments)
    if (old.get(comment.id) !== hash(comment))
      changes.push({
        kind: comment.kind === "issue-comment" ? "pr_comment" : "pr_review_comment",
        message: `${comment.author?.login ?? "Unknown"}${comment.path ? ` on ${comment.path}` : ""}: ${comment.body.slice(0, 1000)}`,
      });
  if (json(previous?.checks ?? []) !== json(next.checks)) {
    const failed = next.checks.filter((check) =>
      ["failure", "cancelled", "action-required"].includes(check.status),
    );
    if (failed.length)
      changes.push({
        kind: "pr_check_failed",
        message: `Checks need attention: ${failed.map((check) => check.name).join(", ")}`,
      });
    else if (
      next.checks.length &&
      next.checks.every((check) => ["success", "skipped", "neutral"].includes(check.status))
    )
      changes.push({ kind: "pr_checks_passed", message: "Checks passed" });
  }
  return changes;
}
function reviewFeedback(snapshot: WorkReviewSnapshot, guidance: string) {
  return json({
    pullRequest: snapshot.reference,
    reviewDecision: snapshot.reviewDecision,
    comments: snapshot.comments,
    failedChecks: snapshot.checks.filter((check) =>
      ["failure", "cancelled", "action-required"].includes(check.status),
    ),
    userGuidance: guidance,
  });
}
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const repo = yield* makeWorkItemRepository;
  const work = yield* WorkItemService;
  const executions = yield* WorkExecutionService;
  const prs = yield* PullRequestService;
  const engine = yield* OrchestrationEngineService;
  const lock = yield* Semaphore.make(1);
  const read = Effect.fn("WorkReviewService.read")(function* (id: WorkItemId) {
    const rows = yield* sql<{
      snapshot_json: string | null;
      sync_error: string | null;
    }>`SELECT snapshot_json,sync_error FROM work_item_reviews WHERE work_item_id=${id}`;
    return {
      snapshot: rows[0]?.snapshot_json ? yield* decodeSnapshot(rows[0].snapshot_json) : null,
      syncError: rows[0]?.sync_error ?? null,
    };
  });
  const refresh = Effect.fn("WorkReviewService.refresh")(
    function* (id: WorkItemId, force = false) {
      const rows = yield* sql<{
        record_json: string;
      }>`SELECT record_json FROM work_item_pull_requests WHERE work_item_id=${id}`;
      const record = rows[0] ? yield* decodePr(rows[0].record_json) : null;
      if (!record?.reference) return null;
      const reference = record.reference;
      return yield* Effect.gen(function* () {
        if (force) yield* prs.invalidate({ reference });
        const summary = yield* prs.summary(reference);
        const at = DateTime.formatIso(yield* DateTime.now);
        if (summary.state === "merged")
          yield* executions.completeMerged(id, summary.mergedAt ?? at, hash(reference));
        const { detail, activity } = yield* Effect.all(
          { detail: prs.detail(reference), activity: prs.activity(reference) },
          { concurrency: 2 },
        );
        const fields = {
          reference,
          state: summary.state,
          headBranch: summary.headBranch,
          reviewDecision: summary.reviewDecision ?? null,
          reviewers: detail.reviewers.map((actor) => actor.login).sort(),
          checks: [...detail.checks].sort((a, b) => a.name.localeCompare(b.name)),
          comments: [...activity.comments].sort((a, b) => a.id.localeCompare(b.id)),
          commentsTruncated: activity.commentsTruncated,
          mergedAt: summary.mergedAt ?? null,
        };
        const fingerprint = hash(fields);
        const result = yield* sql.withTransaction(
          Effect.gen(function* () {
            const previous = yield* read(id);
            const snapshot: WorkReviewSnapshot = {
              ...fields,
              fingerprint,
              revision:
                previous.snapshot?.fingerprint === fingerprint
                  ? previous.snapshot.revision
                  : (previous.snapshot?.revision ?? 0) + 1,
              syncedAt: at,
            };
            yield* sql`INSERT INTO work_item_reviews(work_item_id,snapshot_json,sync_error) VALUES (${id},${encodeSnapshot(snapshot)},NULL) ON CONFLICT(work_item_id) DO UPDATE SET snapshot_json=excluded.snapshot_json,sync_error=NULL`;
            if (previous.snapshot?.fingerprint !== fingerprint) {
              const item = yield* repo.get(id);
              if (item) {
                const next: WorkItem = { ...item, revision: item.revision + 1, updatedAt: at };
                yield* repo.save(next);
                const changes = reviewChanges(previous.snapshot, snapshot);
                for (const [index, change] of changes.entries())
                  yield* repo.record(
                    `review-observed:${id}:${snapshot.revision}:${index}`,
                    json({ fingerprint }),
                    change.kind,
                    next,
                    json({ message: change.message }),
                  );
              }
            }
            return snapshot;
          }),
        );
        yield* work.notifyChange;
        return result;
      }).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            yield* sql`INSERT INTO work_item_reviews(work_item_id,snapshot_json,sync_error) VALUES (${id},NULL,${mapError(error).message}) ON CONFLICT(work_item_id) DO UPDATE SET sync_error=excluded.sync_error`;
            yield* work.notifyChange;
            yield* Effect.logWarning("PR review sync failed; last good snapshot retained").pipe(
              Effect.annotateLogs({ workItemId: id }),
            );
            return yield* mapError(error);
          }),
        ),
      );
    },
    lock.withPermits(1),
    Effect.mapError(mapError),
  );
  const get = Effect.fn("WorkReviewService.get")(function* (id: WorkItemId) {
    const execution = yield* executions.get(id);
    const review = yield* read(id);
    const rows = yield* sql<{
      command_id: string;
      kind: string;
      occurred_at: string;
      metadata_json: string;
    }>`SELECT command_id,kind,occurred_at,metadata_json FROM work_item_events WHERE work_item_id=${id} AND (kind LIKE 'pr_%' OR kind LIKE 'work_item.review_%') ORDER BY sequence DESC LIMIT 50`;
    const history = yield* Effect.forEach(rows, (row) =>
      decodeMetadata(row.metadata_json).pipe(
        Effect.map((metadata) => ({
          id: row.command_id,
          kind: row.kind,
          occurredAt: row.occurred_at,
          message: metadata.message ?? (row.kind === "pr_created" ? "PR created" : row.kind),
        })),
      ),
    );
    return { item: execution.item, execution: execution.execution, ...review, history };
  }, Effect.mapError(mapError));
  const mutate = Effect.fn("WorkReviewService.mutate")(function* (raw: WorkReviewMutation) {
    const input = yield* decodeMutation(raw);
    if (input.kind === "refresh") {
      yield* refresh(input.id, true);
      return;
    }
    const receipts = yield* sql<{
      request_json: string;
    }>`SELECT request_json FROM work_item_execution_commands WHERE command_id=${input.commandId}`;
    if (receipts[0]) {
      if (receipts[0].request_json !== json(input))
        return yield* fail("This command ID was already used for different feedback.", "conflict");
      return;
    }
    const snapshot = yield* refresh(input.id, true);
    if (!snapshot || snapshot.state !== "open")
      return yield* fail("Refresh an open PR before sending feedback.");
    if (snapshot.revision !== input.expectedReviewRevision)
      return yield* fail(
        "The review changed. Refresh and review its latest feedback before sending.",
        "conflict",
      );
    if (snapshot.commentsTruncated)
      return yield* fail(
        "The host returned incomplete comments. Open the PR and resolve or reduce the review before retrying.",
      );
    if (
      snapshot.reviewDecision !== "changes-requested" &&
      !snapshot.comments.length &&
      !snapshot.checks.some((check) =>
        ["failure", "cancelled", "action-required"].includes(check.status),
      )
    )
      return yield* fail("There is no review feedback to send.");
    const feedback = reviewFeedback(snapshot, input.guidance);
    if (feedback.length > 100_000)
      return yield* fail(
        "Review feedback exceeds the context limit. Resolve older comments before retrying.",
      );
    yield* executions.startReview(input, snapshot, feedback);
  }, Effect.mapError(mapError));
  const refreshAll = Effect.fn("WorkReviewService.refreshAll")(function* () {
    const rows = yield* sql<{
      work_item_id: string;
    }>`SELECT p.work_item_id FROM work_item_pull_requests p JOIN work_items w ON w.id=p.work_item_id WHERE w.archived_at IS NULL AND w.status NOT IN ('done','cancelled')`;
    for (const row of rows)
      yield* refresh(WorkItemId.make(row.work_item_id)).pipe(Effect.ignoreCause({ log: true }));
  });
  const worker = yield* makeDrainableWorker((_input: void) =>
    refreshAll().pipe(Effect.ignoreCause({ log: true })),
  );
  const events = yield* engine.subscribeDomainEvents;
  yield* events.pipe(
    Stream.filter((event) =>
      [
        "thread.pull-request-linked",
        "thread.pull-request-synced",
        "thread.pull-request-unlinked",
      ].includes(event.type),
    ),
    Stream.runForEach(() => worker.enqueue(undefined)),
    Effect.forkScoped,
  );
  const merges = yield* prs.subscribeMerges;
  yield* merges.pipe(
    Stream.runForEach(() => worker.enqueue(undefined)),
    Effect.forkScoped,
  );
  yield* prs.subscribeRefreshes.pipe(
    Stream.runForEach(() => worker.enqueue(undefined)),
    Effect.forkScoped,
  );
  yield* worker.enqueue(undefined);
  return {
    get,
    mutate,
    refresh,
    requestSync: worker.enqueue,
    drain: worker.drain,
    subscribe: (id: WorkItemId) => work.changes.pipe(Stream.mapEffect(() => get(id))),
  };
});
export class WorkReviewService extends Context.Service<
  WorkReviewService,
  Effect.Success<typeof make>
>()("t3/workItems/WorkReviewService") {}
