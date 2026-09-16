import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE vercel_projects (project_id TEXT PRIMARY KEY, secret_name TEXT NOT NULL, record_json TEXT NOT NULL)`;
  yield* sql`CREATE TABLE vercel_threads (thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, record_json TEXT NOT NULL)`;
  yield* sql`CREATE INDEX vercel_threads_project ON vercel_threads(project_id)`;
});
