import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE work_item_activity (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, work_item_id TEXT NOT NULL REFERENCES work_items(id), occurred_at TEXT NOT NULL, record_json TEXT NOT NULL)`;
  yield* sql`CREATE INDEX work_item_activity_history ON work_item_activity(work_item_id,occurred_at DESC,sequence DESC)`;
  yield* sql`CREATE TABLE work_activity_cursors (source TEXT PRIMARY KEY, sequence INTEGER NOT NULL)`;
  yield* sql`INSERT INTO work_activity_cursors(source,sequence) VALUES ('work',0),('orchestration',0),('snapshots',0)`;
  yield* sql`CREATE INDEX work_item_events_time ON work_item_events(work_item_id,occurred_at DESC,sequence DESC)`;
  yield* sql`CREATE INDEX work_item_command_thread ON work_item_commands(json_extract(result_json,'$.agentThreadId'),created_at)`;
});
