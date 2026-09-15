import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";
it.effect(
  "starts at existing history heads without generating a historical notification storm",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 57 });
      yield* sql`INSERT INTO work_items(id,source,status,priority,title,body,updated_at,revision,record_json) VALUES ('task','manual','review','medium','Task','','now',1,'{}')`;
      yield* sql`INSERT INTO work_item_events(work_item_id,command_id,kind,revision,occurred_at,metadata_json) VALUES ('task','old','pr_merged',1,'now','{}')`;
      yield* sql`INSERT INTO orchestration_events(event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,actor_kind,payload_json,metadata_json) VALUES ('old','thread','thread',1,'thread.session-set','now','system','{}','{}')`;
      assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 58 }), [
        [58, "ApplicationNotifications"],
      ]);
      const cursors = yield* sql<{
        source: string;
        sequence: number;
      }>`SELECT source,sequence FROM application_event_cursors ORDER BY source`;
      assert.deepEqual(cursors, [
        { source: "notifications", sequence: 0 },
        { source: "orchestration", sequence: 1 },
        { source: "work", sequence: 1 },
      ]);
      assert.deepEqual(yield* sql`SELECT * FROM application_notifications`, []);
      assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 58 }), []);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
