import { assert, it } from "@effect/vitest";
import { WorkItemId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";
import * as Work from "../../workItems/WorkItemService.ts";
it.effect(
  "starts automation projection after historical work without changing existing records",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 61 });
      const work = yield* Work.make;
      yield* work.mutate({
        kind: "create",
        commandId: "old",
        id: WorkItemId.make("old-task"),
        title: "Old task",
        source: "manual",
        fields: {},
      });
      assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 62 }), [
        [62, "WorkAutomations"],
      ]);
      assert.deepEqual(
        yield* sql`SELECT source,sequence FROM work_automation_cursors ORDER BY source`,
        [
          { source: "events", sequence: 0 },
          { source: "work", sequence: 1 },
        ],
      );
      assert.strictEqual((yield* work.list({})).total, 1);
      assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 62 }), []);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
