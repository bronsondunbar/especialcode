import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Multiple review cycles share a thread; only one may own it at a time.
  yield* sql`CREATE TABLE work_item_executions_next (id TEXT PRIMARY KEY, work_item_id TEXT NOT NULL REFERENCES work_items(id), thread_id TEXT NOT NULL, status TEXT NOT NULL, record_json TEXT NOT NULL)`;
  yield* sql`INSERT INTO work_item_executions_next SELECT * FROM work_item_executions ORDER BY rowid`;
  yield* sql`DROP TABLE work_item_executions`;
  yield* sql`ALTER TABLE work_item_executions_next RENAME TO work_item_executions`;
  yield* sql`CREATE INDEX work_item_executions_item ON work_item_executions(work_item_id)`;
  yield* sql`CREATE UNIQUE INDEX work_item_executions_active_thread ON work_item_executions(thread_id) WHERE status IN ('preparing','running','validating','publishing','stopping')`;
  yield* sql`CREATE INDEX work_item_executions_thread ON work_item_executions(thread_id,status)`;
  yield* sql`CREATE TABLE work_item_reviews (work_item_id TEXT PRIMARY KEY REFERENCES work_items(id), snapshot_json TEXT, sync_error TEXT)`;
});
