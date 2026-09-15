import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE work_automation_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,record_json TEXT NOT NULL)`;
  yield* sql`CREATE TABLE work_automation_cursors (source TEXT PRIMARY KEY,sequence INTEGER NOT NULL)`;
  // Installing automations must never act on historical work.
  yield* sql`INSERT INTO work_automation_cursors SELECT 'work',coalesce(max(sequence),0) FROM work_item_events`;
  yield* sql`INSERT INTO work_automation_cursors VALUES ('events',0)`;
  yield* sql`CREATE TABLE work_automation_rules (id TEXT PRIMARY KEY,revision INTEGER NOT NULL,starts_after INTEGER NOT NULL,record_json TEXT NOT NULL)`;
  yield* sql`CREATE TABLE work_automation_runs (sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,rule_id TEXT NOT NULL,event_id TEXT NOT NULL,status TEXT NOT NULL,record_json TEXT NOT NULL,rule_json TEXT NOT NULL,event_json TEXT NOT NULL,UNIQUE(rule_id,event_id))`;
  yield* sql`CREATE INDEX work_automation_run_history ON work_automation_runs(rule_id,sequence DESC)`;
  yield* sql`CREATE INDEX work_automation_run_pending ON work_automation_runs(status,sequence)`;
});
