import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE vercel_connection (id INTEGER PRIMARY KEY CHECK (id=1), secret_name TEXT NOT NULL, record_json TEXT NOT NULL)`;
  // Only a single legacy connection can be promoted without choosing an account for the user.
  // Keep legacy secret references until reconnect/disconnect can remove them from the secret store.
  yield* sql`INSERT INTO vercel_connection(id, secret_name, record_json)
    SELECT 1, secret_name, json_object('teamId', json_extract(record_json, '$.teamId'))
    FROM vercel_projects WHERE (SELECT COUNT(*) FROM vercel_projects)=1`;
  yield* sql`DELETE FROM vercel_threads WHERE json_extract(record_json, '$.enabled')=0
    OR NOT EXISTS (SELECT 1 FROM vercel_connection)
    OR project_id NOT IN (SELECT project_id FROM vercel_projects)`;
  yield* sql`UPDATE vercel_threads SET record_json=json_remove(record_json, '$.enabled')`;
});
