import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE INDEX work_items_agent_thread ON work_items(json_extract(record_json,'$.agentThreadId'))`;
  yield* sql`CREATE TABLE application_agent_sessions (thread_id TEXT PRIMARY KEY, status TEXT NOT NULL, active_turn_id TEXT)`;
  yield* sql`INSERT INTO application_agent_sessions(thread_id,status,active_turn_id) SELECT thread_id,status,active_turn_id FROM projection_thread_sessions`;
  yield* sql`CREATE TABLE application_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    record_json TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE application_event_cursors (source TEXT PRIMARY KEY, sequence INTEGER NOT NULL)`;
  // Installation starts at the current head; subsequent restarts replay everything missed.
  yield* sql`INSERT INTO application_event_cursors VALUES ('work', (SELECT coalesce(max(sequence),0) FROM work_item_events))`;
  yield* sql`INSERT INTO application_event_cursors VALUES ('orchestration', (SELECT coalesce(max(sequence),0) FROM orchestration_events))`;
  yield* sql`INSERT INTO application_event_cursors VALUES ('notifications', 0)`;
  yield* sql`CREATE TABLE application_notifications (
    id TEXT PRIMARY KEY REFERENCES application_events(id),
    sequence INTEGER NOT NULL UNIQUE,
    source TEXT NOT NULL,
    priority TEXT NOT NULL CHECK(priority IN ('info','attention','urgent')),
    read_at TEXT,
    record_json TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX application_notifications_unread ON application_notifications(read_at, sequence)`;
  yield* sql`CREATE INDEX application_notifications_source ON application_notifications(source, sequence)`;
});
