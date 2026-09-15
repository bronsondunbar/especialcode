import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";
it.effect("adds pull request records and receipts without changing executions", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 55 });
    const before = yield* sql`SELECT * FROM work_item_executions`;
    assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 56 }), [
      [56, "WorkPullRequests"],
    ]);
    assert.deepEqual(yield* sql`SELECT * FROM work_item_executions`, before);
    assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 55 }), []);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
