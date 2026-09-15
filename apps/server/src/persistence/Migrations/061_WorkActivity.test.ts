import { assert, it } from "@effect/vitest";
import { WorkItemId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";
import * as Work from "../../workItems/WorkItemService.ts";
it.effect("preserves existing receipts and initializes replay at the beginning of history", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 60 });
    const work = yield* Work.make;
    yield* work.mutate({
      kind: "create",
      commandId: "old",
      id: WorkItemId.make("old-task"),
      title: "Old task",
      source: "manual",
      fields: {},
    });
    assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 61 }), [[61, "WorkActivity"]]);
    assert.strictEqual(
      (yield* sql<{ n: number }>`SELECT count(*) AS n FROM work_item_events`)[0]?.n,
      1,
    );
    assert.deepEqual(
      yield* sql<{
        source: string;
        sequence: number;
      }>`SELECT source,sequence FROM work_activity_cursors ORDER BY source`,
      [
        { source: "orchestration", sequence: 0 },
        { source: "snapshots", sequence: 0 },
        { source: "work", sequence: 0 },
      ],
    );
    assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 61 }), []);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
