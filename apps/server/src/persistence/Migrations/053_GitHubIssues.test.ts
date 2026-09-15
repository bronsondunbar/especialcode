import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";
it.effect("upgrades version 52 without altering work items and runs once", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 52 });
    yield* sql`INSERT INTO work_items(id,source,status,priority,title,body,updated_at,revision,record_json) VALUES ('existing','manual','review','high','Local work','Body','2026',1,'{}')`;
    const before = yield* sql`SELECT * FROM work_items`;
    assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 53 }), [[53, "GitHubIssues"]]);
    assert.deepEqual(yield* sql`SELECT * FROM work_items`, before);
    assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 53 }), []);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
