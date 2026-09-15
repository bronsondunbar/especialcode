import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";
it.effect("preserves inbox history but excludes it from desktop delivery on upgrade", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 58 });
    yield* sql`INSERT INTO application_events(id,record_json) VALUES ('old','{}')`;
    yield* sql`INSERT INTO application_notifications(id,sequence,source,priority,record_json,read_at) VALUES ('old',1,'agents','attention','{}','read-before-upgrade')`;
    assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 59 }), [
      [59, "NotificationPreferences"],
    ]);
    const rows = yield* sql<{
      in_app: number;
      desktop: number;
      read_at: string;
    }>`SELECT in_app,desktop,read_at FROM application_notifications`;
    assert.deepEqual(rows, [{ in_app: 1, desktop: 0, read_at: "read-before-upgrade" }]);
    assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 59 }), []);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
