import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE work_item_executions (id TEXT PRIMARY KEY, work_item_id TEXT NOT NULL REFERENCES work_items(id), thread_id TEXT NOT NULL UNIQUE, status TEXT NOT NULL, record_json TEXT NOT NULL)`;
  yield* sql`CREATE INDEX work_item_executions_item ON work_item_executions(work_item_id)`;
  yield* sql`CREATE TABLE work_item_execution_commands (command_id TEXT PRIMARY KEY, request_json TEXT NOT NULL)`;
});
