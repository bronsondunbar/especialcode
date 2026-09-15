import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";
it.effect("adds Slack tables without changing existing notification history", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 59 });
    yield* sql`INSERT INTO application_events(id,record_json) VALUES ('existing','{}')`;
    assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 60 }), [[60, "Slack"]]);
    yield* sql`INSERT INTO slack_workspaces(id,record_json) VALUES ('T123','{}')`;
    yield* sql`INSERT INTO slack_channels(workspace_id,channel_id,record_json) VALUES ('T123','C123','{}')`;
    yield* sql`INSERT INTO slack_messages(workspace_id,channel_id,ts,record_json) VALUES ('T123','C123','1760000000.000000','{}')`;
    assert.strictEqual(
      (yield* sql<{ n: number }>`SELECT count(*) AS n FROM application_events`)[0]?.n,
      1,
    );
    assert.strictEqual(
      (yield* sql<{ ignored: number }>`SELECT ignored FROM slack_messages`)[0]?.ignored,
      0,
    );
    assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 60 }), []);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
