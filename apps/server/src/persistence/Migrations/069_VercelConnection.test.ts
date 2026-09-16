import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

it.effect("promotes a single legacy connection and preserves only explicit thread links", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 68 });
    yield* sql`INSERT INTO vercel_projects VALUES ('local','secret-1','{"project":{"id":"prj_app","name":"app"},"teamId":"team_1"}')`;
    yield* sql`INSERT INTO vercel_threads VALUES
      ('linked','local','{"project":{"id":"prj_docs","name":"docs"},"branch":null,"enabled":true}'),
      ('unlinked','local','{"project":{"id":"prj_app","name":"app"},"branch":null,"enabled":false}')`;
    yield* runMigrations({ toMigrationInclusive: 69 });
    const connection = yield* sql<{
      secret_name: string;
      record_json: string;
    }>`SELECT * FROM vercel_connection`;
    assert.strictEqual(connection[0]?.secret_name, "secret-1");
    assert.deepEqual(decodeJson(connection[0]!.record_json), { teamId: "team_1" });
    const links = yield* sql<{
      thread_id: string;
      record_json: string;
    }>`SELECT * FROM vercel_threads`;
    assert.strictEqual(links.length, 1);
    assert.strictEqual(links[0]?.thread_id, "linked");
    assert.deepEqual(decodeJson(links[0]!.record_json), {
      project: { id: "prj_docs", name: "docs" },
      branch: null,
    });
    assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 69 }), []);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect(
  "requires reconnecting ambiguous legacy accounts without selecting credentials arbitrarily",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 68 });
      yield* sql`INSERT INTO vercel_projects VALUES
      ('local','secret-1','{"project":{"id":"prj_app","name":"app"},"teamId":"team_1"}'),
      ('other','secret-2','{"project":{"id":"prj_other","name":"other"},"teamId":"team_2"}')`;
      yield* sql`INSERT INTO vercel_threads VALUES ('linked','local','{"project":{"id":"prj_app","name":"app"},"branch":null,"enabled":true}')`;
      yield* runMigrations({ toMigrationInclusive: 69 });
      assert.deepEqual(yield* sql`SELECT * FROM vercel_connection`, []);
      assert.deepEqual(yield* sql`SELECT * FROM vercel_threads`, []);
      assert.strictEqual((yield* sql`SELECT * FROM vercel_projects`).length, 2);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
