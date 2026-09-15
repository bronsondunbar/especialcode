import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE INDEX work_item_activity_recent ON work_item_activity(occurred_at DESC,sequence DESC,work_item_id)`;
});
