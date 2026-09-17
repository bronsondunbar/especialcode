import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ORCHESTRATION_WS_METHODS,
  WS_METHODS,
  WorkItemError,
  type ClientOrchestrationCommand,
  type SourceControlCloneRepositoryInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import {
  cloneWorkRepository,
  workRepositoryChoices,
  workRepositoryProjectId,
  workRepositoryValue,
} from "./workRepository.ts";

const input = {
  projectId: ProjectId.make("cloned-project"),
  repository: "org/private",
  destinationPath: "~/Projects/private",
  createdAt: "2026-09-17T00:00:00.000Z",
};
const setup = Effect.fn(function* (
  options: { failClone?: boolean; failRegisterOnce?: boolean; failExisting?: boolean } = {},
) {
  const clones: SourceControlCloneRepositoryInput[] = [];
  const existingChecks: Array<{ cwd: string; repository: string }> = [];
  const commands: ClientOrchestrationCommand[] = [];
  const client = {
    [WS_METHODS.sourceControlExistingRepository]: (input: { cwd: string; repository: string }) =>
      Effect.gen(function* () {
        existingChecks.push(input);
        if (options.failExisting)
          return yield* new WorkItemError({ code: "invalid", message: "Wrong repository" });
        return { cwd: "/remote/Projects/private" };
      }),
    [WS_METHODS.sourceControlCloneRepository]: (input: SourceControlCloneRepositoryInput) =>
      Effect.gen(function* () {
        clones.push(input);
        if (options.failClone)
          return yield* new WorkItemError({ code: "invalid", message: "Clone failed" });
        return {
          cwd: "/remote/Projects/private",
          remoteUrl: "https://github.com/org/private.git",
          repository: null,
        };
      }),
    [ORCHESTRATION_WS_METHODS.dispatchCommand]: (command: ClientOrchestrationCommand) =>
      Effect.gen(function* () {
        commands.push(command);
        if (options.failRegisterOnce && commands.length === 1)
          return yield* new WorkItemError({ code: "invalid", message: "Registration failed" });
        return { sequence: commands.length };
      }),
  } as unknown as WsRpcProtocolClient;
  const session: RpcSession = {
    client,
    initialConfig: Effect.never,
    subscribeServerConfig: (input) => client.subscribeServerConfig(input),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
  const supervisor = EnvironmentSupervisor.of({
    target: new PrimaryConnectionTarget({
      environmentId: EnvironmentId.make("remote"),
      label: "Remote",
      httpBaseUrl: "https://remote.example.test",
      wsBaseUrl: "wss://remote.example.test",
    }),
    state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
    session: yield* SubscriptionRef.make(Option.some(session)),
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  return {
    clones,
    commands,
    existingChecks,
    provide: Effect.provideService(EnvironmentSupervisor, supervisor),
  };
});

it.effect(
  "registers the checkout path returned by the remote server without starting an agent",
  () =>
    Effect.gen(function* () {
      const harness = yield* setup();
      const result = yield* cloneWorkRepository(input).pipe(harness.provide);
      assert.isTrue(result.registered);
      assert.deepEqual(harness.clones, [
        { connectedGitHubRepository: "org/private", destinationPath: "~/Projects/private" },
      ]);
      assert.strictEqual(harness.commands.length, 1);
      assert.deepInclude(harness.commands[0], {
        type: "project.create",
        projectId: input.projectId,
        workspaceRoot: "/remote/Projects/private",
      });
    }),
);

it.effect("does not register a project after cloning fails", () =>
  Effect.gen(function* () {
    const harness = yield* setup({ failClone: true });
    yield* cloneWorkRepository(input).pipe(harness.provide, Effect.flip);
    assert.strictEqual(harness.commands.length, 0);
  }),
);

it.effect("retries project registration using the same clone and command identity", () =>
  Effect.gen(function* () {
    const harness = yield* setup({ failRegisterOnce: true });
    const first = yield* cloneWorkRepository(input).pipe(harness.provide);
    assert.isFalse(first.registered);
    const second = yield* cloneWorkRepository({ ...input, clonedCwd: first.cwd }).pipe(
      harness.provide,
    );
    assert.isTrue(second.registered);
    assert.strictEqual(harness.clones.length, 1);
    assert.deepEqual(harness.commands[0], harness.commands[1]);
  }),
);

it("combines a saved clone and GitHub repository into one choice and reuses it for later issues", () => {
  const project = {
    id: ProjectId.make("clone"),
    title: "private",
    workspaceRoot: "/repo/private",
    repositoryIdentity: {
      canonicalKey: "github.com/org/private",
      locator: {
        source: "git-remote" as const,
        remoteName: "origin",
        remoteUrl: "git@github.com:org/private.git",
      },
    },
  };
  const choices = workRepositoryChoices(
    [project],
    [{ repository: "Org/Private", private: true }],
    "github:org/private",
  );
  assert.deepEqual(choices, [{ value: "github:org/private", label: "Org/Private" }]);
  assert.strictEqual(workRepositoryProjectId("github:org/private", [project]), project.id);
  assert.strictEqual(workRepositoryValue(project), "github:org/private");
  const second = { ...project, id: ProjectId.make("second") };
  assert.strictEqual(workRepositoryProjectId("github:org/private", [second, project]), project.id);
  assert.strictEqual(
    workRepositoryProjectId("github:org/private", [project, second], second.id),
    second.id,
  );
  assert.isNull(workRepositoryProjectId("github:elsewhere/repo", [project]));
  assert.isNull(workRepositoryProjectId("github:org/private", []));
});

it.effect("registers a verified existing checkout without cloning or moving it", () =>
  Effect.gen(function* () {
    const harness = yield* setup();
    const result = yield* cloneWorkRepository({
      ...input,
      destinationPath: "/other/location/private/src",
      useExisting: true,
    }).pipe(harness.provide);
    assert.isTrue(result.registered);
    assert.deepEqual(harness.existingChecks, [
      { cwd: "/other/location/private/src", repository: "org/private" },
    ]);
    assert.strictEqual(harness.clones.length, 0);
    assert.deepInclude(harness.commands[0], {
      type: "project.create",
      workspaceRoot: "/remote/Projects/private",
    });
  }),
);

it.effect(
  "reuses an already registered checkout and rejects an unrelated folder before registration",
  () =>
    Effect.gen(function* () {
      const harness = yield* setup();
      const existingId = ProjectId.make("existing");
      const result = yield* cloneWorkRepository({
        ...input,
        useExisting: true,
        projects: [{ id: existingId, workspaceRoot: "/remote/Projects/private/" }],
      }).pipe(harness.provide);
      assert.strictEqual(result.projectId, existingId);
      assert.strictEqual(harness.commands.length, 0);
      assert.strictEqual(harness.clones.length, 0);
      const rejected = yield* setup({ failExisting: true });
      yield* cloneWorkRepository({ ...input, useExisting: true }).pipe(
        rejected.provide,
        Effect.flip,
      );
      assert.strictEqual(rejected.commands.length, 0);
      assert.strictEqual(rejected.clones.length, 0);
    }),
);
