import {
  WorkDashboardInput,
  WorkDashboardItem,
  WorkDashboardError,
  WorkActivityEvent,
  WORK_DASHBOARD_SECTIONS,
  type WorkDashboardSection,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { WorkItemService } from "./WorkItemService.ts";
import { WorkActivityService } from "./WorkActivityService.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
const decodeInput = Schema.decodeUnknownEffect(WorkDashboardInput);
const decodeItem = Schema.decodeUnknownEffect(Schema.fromJsonString(WorkDashboardItem));
const decodeActivity = Schema.decodeUnknownEffect(Schema.fromJsonString(WorkActivityEvent));
const failure = () =>
  new WorkDashboardError({ message: "Could not load the dashboard. Refresh and retry." });
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const work = yield* WorkItemService;
  const activity = yield* WorkActivityService;
  const engine = yield* OrchestrationEngineService;
  const list = Effect.fn("WorkDashboardService.list")(
    function* (raw: WorkDashboardInput) {
      const input = yield* decodeInput(raw);
      const filter = sql`w.archived_at IS NULL
      AND (${input.projectId ?? null} IS NULL OR w.project_id=${input.projectId ?? null})
      AND (${input.repository ?? null} IS NULL OR json_extract(w.record_json,'$.repository')=${input.repository ?? null})
      AND (${input.source ?? null} IS NULL OR w.source=${input.source ?? null})
      AND (${input.status ?? null} IS NULL OR w.status=${input.status ?? null})
      AND (${input.priority ?? null} IS NULL OR w.priority=${input.priority ?? null})
      AND (${input.agent ?? null} IS NULL OR coalesce(CASE WHEN w.status IN ('planning','awaiting_approval','ready') THEN json_extract(p.record_json,'$.modelSelection.instanceId') END,json_extract(e.record_json,'$.modelSelection.instanceId'),w.assigned_agent,json_extract(p.record_json,'$.modelSelection.instanceId'))=${input.agent ?? null})`;
      // Only a short description preview crosses the wire; full bodies and agent logs stay out.
      const base = sql`WITH source AS (
      SELECT w.id,w.title,w.project_id,w.source,w.status,w.priority,w.updated_at,w.revision,
        substr(coalesce(json_extract(w.record_json,'$.body'),''),1,500) AS body_preview,
        projects.title AS project, json_extract(w.record_json,'$.repository') AS repository,
        coalesce(CASE WHEN w.status IN ('planning','awaiting_approval','ready') THEN json_extract(p.record_json,'$.modelSelection.instanceId') END,json_extract(e.record_json,'$.modelSelection.instanceId'),w.assigned_agent,json_extract(p.record_json,'$.modelSelection.instanceId')) AS agent,
        coalesce(CASE WHEN w.status IN ('planning','awaiting_approval','ready') THEN json_extract(p.record_json,'$.agentName') END,json_extract(e.record_json,'$.agentName'),json_extract(p.record_json,'$.agentName')) AS agent_name,
        json_extract(w.record_json,'$.agentThreadId') AS thread_id,
        substr(CASE WHEN json_extract(p.record_json,'$.status')='generating' THEN 'Generating plan' WHEN e.status IN ('preparing','running','validating','publishing','stopping') THEN json_extract(e.record_json,'$.activity') WHEN w.status='blocked' THEN coalesce(json_extract(w.record_json,'$.failureReason'),json_extract(e.record_json,'$.error'),'Task blocked') END,1,500) AS activity,
        e.status AS execution_status,json_extract(p.record_json,'$.status') AS plan_status,json_extract(p.record_json,'$.approvedWorkItemRevision') AS approved_revision,
        coalesce(t.pending_approval_count,0)+coalesce(t.pending_user_input_count,0) AS questions,
        json_extract(r.snapshot_json,'$.state') AS pr_state,
        json_extract(r.snapshot_json,'$.reviewDecision') AS review_decision,
        coalesce(json_array_length(r.snapshot_json,'$.reviewers'),0) AS reviewers,
        EXISTS(SELECT 1 FROM json_each(r.snapshot_json,'$.checks') c WHERE json_extract(c.value,'$.status') IN ('failure','action-required','cancelled')) AS failed_checks,
        r.sync_error AS sync_error,
        json_extract(pr.record_json,'$.status') AS publish_status
      FROM work_items w
      LEFT JOIN work_item_executions e ON e.rowid=(SELECT max(latest.rowid) FROM work_item_executions latest WHERE latest.work_item_id=w.id)
      LEFT JOIN work_item_plans p ON p.work_item_id=w.id
      LEFT JOIN work_item_reviews r ON r.work_item_id=w.id
      LEFT JOIN work_item_pull_requests pr ON pr.work_item_id=w.id
      LEFT JOIN projection_projects projects ON projects.project_id=w.project_id AND projects.deleted_at IS NULL
      LEFT JOIN projection_threads t ON t.thread_id=json_extract(w.record_json,'$.agentThreadId') AND t.deleted_at IS NULL
      WHERE ${filter}
    ), classified AS (
      SELECT *,
        status NOT IN ('done','cancelled') AND (questions>0 OR execution_status='failed' OR plan_status='failed' OR publish_status='failed' OR status='awaiting_approval' OR (pr_state='open' AND (review_decision IN ('changes-requested','review-required') OR reviewers>0 OR failed_checks)) OR sync_error IS NOT NULL) AS attention,
        status NOT IN ('done','cancelled') AND (execution_status IN ('preparing','running','validating','publishing','stopping') OR plan_status='generating') AS running,
        status='ready' AND project_id IS NOT NULL AND plan_status='approved' AND approved_revision=revision AND coalesce(execution_status,'') NOT IN ('preparing','running','validating','publishing','stopping') AS ready,
        status NOT IN ('done','cancelled') AND (status='review' OR pr_state='open' OR (publish_status='linked' AND pr_state IS NULL)) AS review,
        status='blocked' AS blocked,status='inbox' AS inbox
      FROM source
    )`;
      const predicates = {
        attention: sql`attention`,
        running: sql`running`,
        ready: sql`ready`,
        review: sql`review`,
        blocked: sql`blocked`,
        inbox: sql`inbox`,
      };
      const counts = (yield* sql<
        Record<WorkDashboardSection, number | null>
      >`${base} SELECT sum(attention) AS attention,sum(running) AS running,sum(ready) AS ready,sum(review) AS review,sum(blocked) AS blocked,sum(inbox) AS inbox FROM classified`)[0]!;
      const sections = yield* Effect.forEach(
        WORK_DASHBOARD_SECTIONS.filter((s) => !input.section || s.id === input.section),
        (section) =>
          Effect.gen(function* () {
            const rows = yield* sql<{
              record: string;
              questions: number;
              execution_status: string | null;
              plan_status: string | null;
              publish_status: string | null;
              pr_state: string | null;
              review_decision: string | null;
              reviewers: number;
              failed_checks: number;
              sync_error: string | null;
            }>` ${base} SELECT json_object('id',id,'title',title,'bodyPreview',body_preview,'projectId',project_id,'project',project,'repository',repository,'source',source,'status',status,'priority',priority,'agent',agent,'agentName',agent_name,'threadId',thread_id,'activity',activity,'reasons',json('[]'),'updatedAt',updated_at) AS record,
      questions,execution_status,plan_status,publish_status,pr_state,review_decision,reviewers,failed_checks,sync_error
      FROM classified WHERE ${predicates[section.id]}
      ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,updated_at DESC,id
      LIMIT ${input.limit ?? 8} OFFSET ${input.section ? (input.offset ?? 0) : 0}`;
            const items = yield* Effect.forEach(rows, (row) =>
              Effect.gen(function* () {
                const item = yield* decodeItem(row.record);
                const reasons = [
                  row.questions > 0 ? "Agent needs input" : null,
                  row.execution_status === "failed" ? "Execution failed" : null,
                  row.plan_status === "failed" ? "Planning failed" : null,
                  row.publish_status === "failed" ? "PR creation failed" : null,
                  item.status === "awaiting_approval" ? "Plan needs approval" : null,
                  row.pr_state === "open" && row.review_decision === "changes-requested"
                    ? "Changes requested"
                    : null,
                  row.pr_state === "open" &&
                  (row.reviewers > 0 || row.review_decision === "review-required")
                    ? "Review requested"
                    : null,
                  row.pr_state === "open" && row.failed_checks ? "Checks failed" : null,
                  row.sync_error ? "PR sync needs attention" : null,
                  item.status === "blocked" ? "Task blocked" : null,
                ].filter((reason): reason is string => reason !== null);
                return { ...item, reasons };
              }),
            );
            return { id: section.id, total: counts[section.id] ?? 0, items };
          }),
      );
      const rows = yield* sql<{ record_json: string; title: string }>` ${base}
      SELECT a.record_json,c.title FROM work_item_activity a JOIN classified c ON c.id=a.work_item_id
      ORDER BY a.occurred_at DESC,a.sequence DESC LIMIT 12`;
      const recent = yield* Effect.forEach(rows, (row) =>
        decodeActivity(row.record_json).pipe(
          Effect.map((event) => ({ ...event, workItemTitle: row.title })),
        ),
      );
      return { sections, activity: recent };
    },
    sql.withTransaction,
    Effect.mapError(failure),
  );
  return {
    list,
    subscribe: (input: WorkDashboardInput) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const domain = yield* engine.subscribeDomainEvents;
          const agentChanges = domain.pipe(
            Stream.filter(
              (e) =>
                e.type === "thread.session-set" ||
                (e.type === "thread.activity-appended" &&
                  /^(approval|user-input)\./.test(e.payload.activity.kind)),
            ),
          );
          return Stream.mergeAll(
            [work.changes, activity.changes, agentChanges.pipe(Stream.map(() => 0))],
            {
              concurrency: 3,
            },
          ).pipe(
            Stream.mapEffect(() => list(input)),
            Stream.changesWith((a, b) => JSON.stringify(a) === JSON.stringify(b)),
          );
        }),
      ),
  };
});
export class WorkDashboardService extends Context.Service<
  WorkDashboardService,
  Effect.Success<typeof make>
>()("t3/workItems/WorkDashboardService") {}
