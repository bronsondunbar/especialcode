import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";
it.effect("adds emergency controls without granting execution trust to existing rules", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 62 });
    yield* sql`INSERT INTO work_automation_rules(id,revision,starts_after,record_json) VALUES ('old',1,0,'{"name":"Old","enabled":true}')`;
    assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 63 }), [[63, "AutonomousWork"]]);
    assert.deepEqual(yield* sql`SELECT paused,revision FROM work_automation_control`, [
      { paused: 0, revision: 0 },
    ]);
    assert.deepEqual(
      yield* sql`SELECT json_extract(record_json,'$.execution') AS execution FROM work_automation_rules`,
      [{ execution: null }],
    );
    assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 63 }), []);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
