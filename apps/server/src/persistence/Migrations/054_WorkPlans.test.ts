import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";
it.effect("adds plans without altering existing work and issue configuration, once", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 53 });
    yield* sql`INSERT INTO github_tracked_repositories(namespace,record_json) VALUES ('github.com/owner/repo','{}')`;
    const before = yield* sql`SELECT * FROM github_tracked_repositories`;
    assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 54 }), [[54, "WorkPlans"]]);
    assert.deepEqual(yield* sql`SELECT * FROM github_tracked_repositories`, before);
    assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 54 }), []);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
