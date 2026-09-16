import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Keep only identifiers: retries and source syncs must not recreate deleted tasks.
  yield* sql`CREATE TABLE deleted_work_items (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, command_id TEXT NOT NULL UNIQUE)`;
  yield* sql`CREATE TABLE deleted_work_item_resources (source TEXT NOT NULL, namespace TEXT NOT NULL, external_id TEXT NOT NULL, PRIMARY KEY(source, namespace, external_id))`;
});
