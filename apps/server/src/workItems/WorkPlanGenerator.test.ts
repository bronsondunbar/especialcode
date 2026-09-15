import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  type ServerProvider,
  WorkItem,
  WorkItemId,
  type WorkPlanContent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import { VcsDriverRegistry, type VcsDriverHandle } from "../vcs/VcsDriverRegistry.ts";
import { make } from "./WorkPlanGenerator.ts";
const plan: WorkPlanContent = {
  summary: "Plan",
  proposedChanges: [],
  affectedFiles: [
    "src/app.ts",
    "../outside.txt",
    "linked.ts",
    ".env",
    "config.ts",
    "ignored-link.ts",
    "source-link.ts",
  ],
  steps: ["Review"],
  tests: ["Unit tests"],
  risks: [],
  questions: [],
  complexity: "low",
};
it.effect(
  "inspects agent-selected snapshots, blocks traversal/secrets/symlink escape and never runs in the repository",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const parent = yield* fs.makeTempDirectoryScoped({ prefix: "t3-plan-test-" });
      const root = `${parent}/repo`;
      yield* fs.makeDirectory(`${root}/src`, { recursive: true });
      yield* fs.writeFileString(`${root}/AGENTS.md`, "Use repository conventions.");
      yield* fs.writeFileString(`${root}/src/app.ts`, "export const untouched = true;");
      yield* fs.writeFileString(`${root}/.env`, "SECRET_MUST_NOT_BE_READ");
      yield* fs.writeFileString(`${parent}/outside.txt`, "OUTSIDE_MUST_NOT_BE_READ");
      yield* fs.symlink(`${parent}/outside.txt`, `${root}/linked.ts`);
      yield* fs.symlink(`${root}/.env`, `${root}/config.ts`);
      yield* fs.writeFileString(`${root}/ignored.txt`, "IGNORED_MUST_NOT_BE_READ");
      yield* fs.symlink(`${root}/ignored.txt`, `${root}/ignored-link.ts`);
      yield* fs.symlink(`${root}/src/app.ts`, `${root}/source-link.ts`);
      const prompts: string[] = [];
      const directories: string[] = [];
      // Only the generator-facing fields are exercised; accessing another provider/VCS operation fails the test.
      const instance = {
        enabled: true,
        textGeneration: {
          generateWorkPlan: (input: { cwd: string; prompt: string }) => {
            prompts.push(input.prompt);
            directories.push(input.cwd);
            return Effect.succeed(plan);
          },
        },
      } as unknown as ProviderInstance;
      const handle = {
        driver: {
          listWorkspaceFiles: () =>
            Effect.succeed({
              paths: [
                "AGENTS.md",
                "src/app.ts",
                "linked.ts",
                ".env",
                "../outside.txt",
                "config.ts",
                "ignored-link.ts",
                "source-link.ts",
              ],
              truncated: false,
            }),
        },
      } as unknown as VcsDriverHandle;
      const generator = yield* make.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(ProviderInstanceRegistry)({ getInstance: () => Effect.succeed(instance) }),
            Layer.mock(VcsDriverRegistry)({ resolve: () => Effect.succeed(handle) }),
          ),
        ),
      );
      const item = WorkItem.make({
        id: WorkItemId.make("task"),
        title: "Plan feature",
        body: "Description",
        projectId: ProjectId.make("project"),
        priority: "medium",
        repository: "owner/repo",
        branch: null,
        assignedAgent: null,
        agentThreadId: null,
        parentWorkItemId: null,
        failureReason: null,
        source: "manual",
        externalId: null,
        externalUrl: null,
        resources: [],
        status: "ready",
        revision: 1,
        createdAt: "2026",
        updatedAt: "2026",
        completedAt: null,
        archivedAt: null,
      });
      const generated = yield* generator.generate({
        item,
        cwd: root,
        projectTitle: "Project",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test-model" },
        externalContext: "GitHub comments",
        feedback: "Keep compatible",
      });
      assert.strictEqual(prompts.length, 2);
      assert.include(prompts[0]!, "Use repository conventions");
      assert.include(prompts[1]!, "export const untouched = true");
      assert.include(prompts[1]!, "GitHub comments");
      assert.notInclude(prompts.join(""), "SECRET_MUST_NOT_BE_READ");
      assert.notInclude(prompts.join(""), "OUTSIDE_MUST_NOT_BE_READ");
      assert.notInclude(prompts.join(""), "IGNORED_MUST_NOT_BE_READ");
      assert.isTrue(directories.every((cwd) => cwd !== root && !cwd.startsWith(root + "/")));
      assert.deepEqual(generated.inspectedFiles, ["AGENTS.md", "src/app.ts", "source-link.ts"]);
      assert.strictEqual(
        yield* fs.readFileString(`${root}/src/app.ts`),
        "export const untouched = true;",
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("advertises only installed, authenticated providers with protected planning", () =>
  Effect.gen(function* () {
    const snapshot: ServerProvider = {
      instanceId: ProviderInstanceId.make("claude"),
      driver: ProviderDriverKind.make("claude"),
      enabled: true,
      installed: true,
      status: "ready",
      version: "test",
      auth: { status: "authenticated" },
      checkedAt: "2026-01-01T00:00:00Z",
      models: [],
      slashCommands: [],
      skills: [],
    };
    const supported = {
      enabled: true,
      textGeneration: { generateWorkPlan: () => Effect.succeed(plan) },
      snapshot: { getSnapshot: Effect.succeed(snapshot) },
    } as unknown as ProviderInstance;
    const unsupported = { ...supported, textGeneration: {} } as unknown as ProviderInstance;
    const signedOut = {
      ...supported,
      snapshot: {
        getSnapshot: Effect.succeed({ ...snapshot, auth: { status: "unauthenticated" } }),
      },
    } as unknown as ProviderInstance;
    const generator = yield* make.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(ProviderInstanceRegistry)({
            listInstances: Effect.succeed([
              unsupported,
              signedOut,
              { ...supported, enabled: false },
              supported,
            ]),
            getInstance: () => Effect.succeed(unsupported),
          }),
          Layer.mock(VcsDriverRegistry)({}),
        ),
      ),
    );
    assert.deepEqual(yield* generator.agents(), [snapshot]);
  }).pipe(Effect.provide(NodeServices.layer)),
);
