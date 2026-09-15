import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE github_tracked_repositories (
    namespace TEXT PRIMARY KEY, record_json TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE github_issues (
    namespace TEXT NOT NULL REFERENCES github_tracked_repositories(namespace) ON DELETE CASCADE,
    external_id TEXT NOT NULL, number INTEGER NOT NULL, state TEXT NOT NULL,
    updated_at TEXT NOT NULL, record_json TEXT NOT NULL,
    PRIMARY KEY(namespace, external_id), UNIQUE(namespace, number)
  )`;
  yield* sql`CREATE INDEX github_issues_queue ON github_issues(state, updated_at DESC)`;
});
