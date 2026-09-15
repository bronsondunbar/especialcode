import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE slack_workspaces (id TEXT PRIMARY KEY, record_json TEXT NOT NULL)`;
  yield* sql`CREATE TABLE slack_channels (workspace_id TEXT NOT NULL REFERENCES slack_workspaces(id) ON DELETE CASCADE, channel_id TEXT NOT NULL, record_json TEXT NOT NULL, PRIMARY KEY(workspace_id,channel_id))`;
  yield* sql`CREATE TABLE slack_messages (workspace_id TEXT NOT NULL, channel_id TEXT NOT NULL, ts TEXT NOT NULL, ignored INTEGER NOT NULL DEFAULT 0, record_json TEXT NOT NULL, PRIMARY KEY(workspace_id,channel_id,ts), FOREIGN KEY(workspace_id,channel_id) REFERENCES slack_channels(workspace_id,channel_id) ON DELETE CASCADE)`;
  yield* sql`CREATE INDEX slack_inbox ON slack_messages(ignored,ts DESC)`;
});
