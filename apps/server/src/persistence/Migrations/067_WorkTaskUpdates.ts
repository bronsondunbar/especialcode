import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Reserve the request before sending: an interrupted write must never be replayed blindly.
  yield* sql`CREATE TABLE work_task_updates (command_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, url TEXT)`;
  yield* sql`CREATE INDEX work_items_thread ON work_items(json_extract(record_json, '$.agentThreadId'))`;
});
