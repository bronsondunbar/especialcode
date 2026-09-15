import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE work_item_pull_requests (work_item_id TEXT PRIMARY KEY REFERENCES work_items(id), record_json TEXT NOT NULL)`;
  yield* sql`CREATE TABLE work_item_pull_request_commands (command_id TEXT PRIMARY KEY, request_json TEXT NOT NULL)`;
});
