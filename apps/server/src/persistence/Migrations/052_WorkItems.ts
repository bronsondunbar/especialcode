import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE work_items (
    id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT REFERENCES work_items(id),
    assigned_agent TEXT, source TEXT NOT NULL, status TEXT NOT NULL,
    priority TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
    archived_at TEXT, updated_at TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision > 0),
    record_json TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX work_items_queue ON work_items(archived_at, status, updated_at DESC, id)`;
  yield* sql`CREATE INDEX work_items_project ON work_items(project_id, status, updated_at DESC)`;
  yield* sql`CREATE INDEX work_items_parent ON work_items(parent_id)`;
  yield* sql`CREATE TABLE work_item_resources (
    source TEXT NOT NULL, namespace TEXT NOT NULL, external_id TEXT NOT NULL,
    work_item_id TEXT NOT NULL REFERENCES work_items(id),
    PRIMARY KEY(source, namespace, external_id)
  )`;
  yield* sql`CREATE INDEX work_item_resources_item ON work_item_resources(work_item_id)`;
  yield* sql`CREATE TABLE work_item_commands (
    command_id TEXT PRIMARY KEY, request_json TEXT NOT NULL, result_json TEXT NOT NULL,
    work_item_id TEXT NOT NULL REFERENCES work_items(id), created_at TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE work_item_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    work_item_id TEXT NOT NULL REFERENCES work_items(id), command_id TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL, revision INTEGER NOT NULL, occurred_at TEXT NOT NULL,
    metadata_json TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX work_item_events_item ON work_item_events(work_item_id, sequence)`;
});
