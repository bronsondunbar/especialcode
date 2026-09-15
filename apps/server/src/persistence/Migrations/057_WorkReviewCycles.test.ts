import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";
it.effect("preserves execution order and permits sequential cycles on the same thread", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 56 });
    yield* sql`INSERT INTO work_items(id,source,status,priority,title,body,updated_at,revision,record_json) VALUES ('task','manual','review','medium','Task','','now',1,'{}')`;
    yield* sql`PRAGMA foreign_keys = ON`;
    yield* sql`INSERT INTO work_item_executions(id,work_item_id,thread_id,status,record_json) VALUES ('first','task','thread','succeeded','{}')`;
    assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 57 }), [
      [57, "WorkReviewCycles"],
    ]);
    yield* sql`INSERT INTO work_item_executions(id,work_item_id,thread_id,status,record_json) VALUES ('second','task','thread','running','{}')`;
    yield* sql`INSERT INTO work_item_executions(id,work_item_id,thread_id,status,record_json) VALUES ('third','task','thread','running','{}')`.pipe(
      Effect.flip,
    );
    const rows = yield* sql<{ id: string }>`SELECT id FROM work_item_executions ORDER BY rowid`;
    assert.deepEqual(
      rows.map((row) => row.id),
      ["first", "second"],
    );
    assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 57 }), []);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
