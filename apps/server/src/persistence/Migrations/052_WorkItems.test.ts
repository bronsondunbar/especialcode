import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

it.effect(
  "upgrades a populated version 51 database without changing orchestration data and runs once",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 51 });
      yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at)
    VALUES ('existing','Existing project','/tmp/existing','[]','2026-01-01','2026-01-01')`;
      const before = yield* sql`SELECT * FROM projection_projects`;
      assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 52 }), [[52, "WorkItems"]]);
      assert.deepEqual(yield* sql`SELECT * FROM projection_projects`, before);
      const tables = yield* sql<{
        name: string;
      }>`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'work_item%'`;
      assert.deepEqual(tables.map((row) => row.name).sort(), [
        "work_item_commands",
        "work_item_events",
        "work_item_resources",
        "work_items",
      ]);
      assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 52 }), []);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
