import { assert, it } from "@effect/vitest";
import { ProjectId, ThreadId, type VercelDeployment } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import { VercelAdapter, fail } from "./VercelAdapter.ts";
import { make } from "./VercelService.ts";
const projectId = ProjectId.make("local");
const threadId = ThreadId.make("thread");
const input = { projectId, threadId };
const connect = {
  kind: "connect" as const,
  teamId: "team_1",
  token: "private-token",
};
const deployment: VercelDeployment = {
  id: "dpl_1",
  name: "app",
  state: "BUILDING",
  url: null,
  createdAt: 1,
  target: null,
  commit: null,
};
const setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES ('local','Local','/tmp/local','[]','2026-01-01','2026-01-01'), ('other','Other','/tmp/other','[]','2026-01-01','2026-01-01')`;
  yield* sql`INSERT INTO projection_threads(thread_id,project_id,title,branch,model_selection_json,created_at,updated_at) VALUES ('thread','local','Thread','codex/fix','{"instanceId":"codex","model":"gpt-5.4"}','2026-01-01','2026-01-01')`;
  const tokens = new Map<string, Uint8Array>();
  const calls: Array<{ project: string; branch: string | null; teamId: string | null }> = [];
  const logCalls: string[] = [];
  const options = { logsFail: false, deploymentsFail: false };
  const service = yield* make.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(ServerSecretStore)({
          get: (key) => Effect.sync(() => Option.fromNullishOr(tokens.get(key))),
          set: (key, token) =>
            Effect.sync(() => {
              tokens.set(key, token);
            }),
          remove: (key) =>
            Effect.sync(() => {
              tokens.delete(key);
            }),
        }),
        Layer.mock(VercelAdapter)({
          projects: (credentials) =>
            credentials.token === "invalid"
              ? fail("Invalid token")
              : Effect.succeed([{ id: "prj_app", name: "app" }]),
          project: (_credentials, name) =>
            name === "missing"
              ? fail("Unavailable project")
              : Effect.succeed({ id: `prj_${name}`, name }),
          deployments: (credentials, project, branch) =>
            Effect.gen(function* () {
              calls.push({ project, branch, teamId: credentials.teamId });
              if (options.deploymentsFail) return yield* fail("Temporarily unavailable");
              return [deployment];
            }),
          logs: (_credentials, id) =>
            Effect.gen(function* () {
              logCalls.push(id);
              if (options.logsFail) return yield* fail("Logs unavailable");
              return { text: "Building…", truncated: false };
            }),
        }),
      ),
    ),
  );
  return { service, tokens, calls, logCalls, sql, options };
});
it.effect(
  "requires a thread project selection and follows its live branch with shared credentials",
  () =>
    Effect.gen(function* () {
      const { service, tokens, calls, logCalls, sql } = yield* setup;
      assert.isNull((yield* service.read(input)).connection);
      yield* service.admin(connect);
      assert.isNull((yield* service.read(input)).link);
      assert.deepEqual(calls, []);
      yield* service.link({ ...input, kind: "link", vercelProject: "app", branch: null });
      const snapshot = yield* service.read(input);
      assert.deepEqual(snapshot.connection, {
        teamId: "team_1",
      });
      assert.deepEqual(calls, [{ project: "prj_app", branch: "codex/fix", teamId: "team_1" }]);
      assert.deepEqual(logCalls, []);
      assert.strictEqual(tokens.size, 1);
      const rows = yield* sql<{ record_json: string }>`SELECT record_json FROM vercel_connection`;
      assert.notInclude(rows[0]!.record_json, "private-token");
      yield* sql`UPDATE projection_threads SET branch='codex/next' WHERE thread_id=${threadId}`;
      assert.strictEqual((yield* service.read(input)).link?.branch, "codex/next");
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
it.effect("supports choosing, unlinking, relinking and disconnecting", () =>
  Effect.gen(function* () {
    const { service, tokens, calls, sql } = yield* setup;
    yield* service.admin(connect);
    yield* service.link({ ...input, kind: "link", vercelProject: "docs", branch: "preview" });
    assert.deepEqual((yield* service.read(input)).link, {
      project: { id: "prj_docs", name: "docs" },
      branch: "preview",
    });
    yield* service.link({ ...input, kind: "unlink" });
    assert.isNull((yield* service.read(input)).link);
    assert.strictEqual(calls.length, 1);
    yield* service.link({ ...input, kind: "link", vercelProject: "docs", branch: null });
    assert.strictEqual((yield* service.read(input)).link?.branch, "codex/fix");
    yield* service.admin({ kind: "disconnect" });
    assert.isNull((yield* service.read(input)).connection);
    assert.strictEqual(tokens.size, 0);
    assert.deepEqual(yield* sql`SELECT * FROM vercel_threads`, []);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
it.effect("bounds log access to the linked branch and preserves deployments when logs fail", () =>
  Effect.gen(function* () {
    const { service, logCalls, options } = yield* setup;
    yield* service.admin(connect);
    yield* service.link({ ...input, kind: "link", vercelProject: "app", branch: null });
    const denied = yield* service.read({
      ...input,
      deploymentId: "dpl_foreign",
      includeLogs: true,
    });
    assert.isNotNull(denied.logsError);
    assert.deepEqual(logCalls, []);
    assert.strictEqual((yield* service.read({ ...input, includeLogs: true })).logs, "Building…");
    options.logsFail = true;
    const failed = yield* service.read({ ...input, includeLogs: true });
    assert.strictEqual(failed.logsError, "Logs unavailable");
    assert.strictEqual(failed.deployments.length, 1);
    options.deploymentsFail = true;
    assert.strictEqual((yield* service.read(input)).error, "Temporarily unavailable");
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
it.effect("rejects mismatched and deleted projects and requires a branch for threads", () =>
  Effect.gen(function* () {
    const { service, calls, sql } = yield* setup;
    yield* service.admin(connect);
    const mismatched = { ...input, projectId: ProjectId.make("other") };
    yield* service.read(mismatched).pipe(Effect.flip);
    yield* service
      .link({ ...mismatched, kind: "link", vercelProject: "docs", branch: "main" })
      .pipe(Effect.flip);
    assert.deepEqual(calls, []);
    assert.isNotNull((yield* service.read({ projectId: ProjectId.make("other") })).connection);
    yield* service.read({ threadId }).pipe(Effect.flip);
    yield* service.link({ ...input, kind: "link", vercelProject: "app", branch: null });
    yield* sql`UPDATE projection_threads SET branch=NULL WHERE thread_id=${threadId}`;
    assert.include((yield* service.read(input)).error!, "Choose a branch");
    assert.deepEqual(calls, []);
    yield* sql`UPDATE projection_projects SET deleted_at='2026-09-16' WHERE project_id=${projectId}`;
    yield* service.read(input).pipe(Effect.flip);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
it.effect(
  "keeps the existing connection on failed validation, rotates secrets and clears cross-team overrides",
  () =>
    Effect.gen(function* () {
      const { service, tokens } = yield* setup;
      yield* service.admin(connect);
      yield* service.admin({ ...connect, token: "invalid" }).pipe(Effect.flip);
      assert.strictEqual((yield* service.read(input)).connection?.teamId, "team_1");
      assert.strictEqual(tokens.size, 1);
      yield* service.link({ ...input, kind: "link", vercelProject: "docs", branch: "main" });
      yield* service.admin({ ...connect, teamId: "team_2", token: "new-token" });
      assert.isNull((yield* service.read(input)).link);
      assert.strictEqual(tokens.size, 1);
      assert.strictEqual(new TextDecoder().decode([...tokens.values()][0]), "new-token");
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect(
  "lists projects using the saved connection and keeps settings reads free of deployment requests",
  () =>
    Effect.gen(function* () {
      const { service, calls } = yield* setup;
      assert.deepEqual(yield* service.projects({}), { connection: null, projects: [] });
      yield* service.admin(connect);
      const projects = yield* service.projects({ search: "app" });
      assert.deepEqual(projects.projects, [{ id: "prj_app", name: "app" }]);
      assert.isNotNull((yield* service.read({ configurationOnly: true })).connection);
      assert.deepEqual(calls, []);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect(
  "connects without a local repository and shares project discovery across repositories",
  () =>
    Effect.gen(function* () {
      const { service, sql, calls } = yield* setup;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_projects`;
      yield* service.admin(connect);
      assert.deepEqual((yield* service.read({})).connection, { teamId: "team_1" });
      assert.deepEqual((yield* service.projects({})).projects, [{ id: "prj_app", name: "app" }]);
      assert.deepEqual(calls, []);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
it.effect(
  "links different local repositories independently and preserves links on token rotation",
  () =>
    Effect.gen(function* () {
      const { service, sql, calls } = yield* setup;
      yield* sql`INSERT INTO projection_threads(thread_id,project_id,title,branch,model_selection_json,created_at,updated_at)
      VALUES ('other-thread','other','Other thread','main','{"instanceId":"codex","model":"gpt-5.4"}','2026-01-01','2026-01-01')`;
      const other = { projectId: ProjectId.make("other"), threadId: ThreadId.make("other-thread") };
      yield* service.admin(connect);
      yield* service.link({ ...input, kind: "link", vercelProject: "app", branch: null });
      yield* service.link({ ...other, kind: "link", vercelProject: "docs", branch: null });
      yield* service.admin({ ...connect, token: "rotated-token" });
      assert.strictEqual((yield* service.read(input)).link?.project.id, "prj_app");
      assert.strictEqual((yield* service.read(other)).link?.project.id, "prj_docs");
      assert.deepEqual(calls, [
        { project: "prj_app", branch: "codex/fix", teamId: "team_1" },
        { project: "prj_docs", branch: "main", teamId: "team_1" },
      ]);
      yield* service.admin({ kind: "disconnect" });
      assert.isNull((yield* service.read(input)).link);
      assert.isNull((yield* service.read(other)).link);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
