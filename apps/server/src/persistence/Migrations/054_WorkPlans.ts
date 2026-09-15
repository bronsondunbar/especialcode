import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE work_item_plans (work_item_id TEXT PRIMARY KEY REFERENCES work_items(id), record_json TEXT NOT NULL)`;
  yield* sql`CREATE TABLE work_item_plan_history (work_item_id TEXT NOT NULL REFERENCES work_items(id), revision INTEGER NOT NULL, record_json TEXT NOT NULL, PRIMARY KEY(work_item_id, revision))`;
  yield* sql`CREATE TABLE work_item_plan_commands (command_id TEXT PRIMARY KEY, request_json TEXT NOT NULL)`;
});
