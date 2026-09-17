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
import { cloneWorkRepository } from "./workRepository.ts";

const input = {
  projectId: ProjectId.make("cloned-project"),
  repository: "org/private",
  destinationPath: "~/Projects/private",
  createdAt: "2026-09-17T00:00:00.000Z",
};
const setup = Effect.fn(function* (
  options: { failClone?: boolean; failRegisterOnce?: boolean } = {},
) {
  const clones: SourceControlCloneRepositoryInput[] = [];
  const commands: ClientOrchestrationCommand[] = [];
  const client = {
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
  return { clones, commands, provide: Effect.provideService(EnvironmentSupervisor, supervisor) };
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
