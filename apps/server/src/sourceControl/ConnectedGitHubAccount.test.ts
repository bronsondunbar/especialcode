import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";
import { ServerSecretStore, SecretStoreReadError } from "../auth/ServerSecretStore.ts";
import { githubAccountSecretName } from "../auth/githubAccountSecret.ts";
import * as GitHubCli from "./GitHubCli.ts";
import * as GitHubProvider from "./GitHubSourceControlProvider.ts";
import * as GitHubPullRequestCli from "../pullRequest/GitHubPullRequestCli.ts";
import * as GitHubGraphQlBudget from "./githubGraphQlBudget.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";

const output = (stdout: string): VcsProcess.VcsProcessOutput => ({
  stdout,
  stderr: "",
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdoutTruncated: false,
  stderrTruncated: false,
});
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const setup = Effect.gen(function* () {
  const state = { token: "connected-token" as string | null, fail: false, cliSignedIn: false };
  const calls: VcsProcess.VcsProcessInput[] = [];
  const store = Layer.mock(ServerSecretStore)({
    get: (key) =>
      Effect.gen(function* () {
        assert.strictEqual(key, githubAccountSecretName);
        if (state.fail)
          return yield* new SecretStoreReadError({
            resource: "test",
            cause: new Error("private storage error"),
          });
        return state.token === null
          ? Option.none()
          : Option.some(new TextEncoder().encode(state.token));
      }),
  });
  const process = {
    run: (input: VcsProcess.VcsProcessInput) =>
      Effect.sync(() => {
        calls.push(input);
        if (input.args[0] === "--version") return output("gh 2.81.0");
        if (input.args[0] === "auth" && input.args[1] === "token") return output("cli-token");
        if (input.args[0] === "auth")
          return output(
            encodeJson({
              hosts: state.cliSignedIn
                ? {
                    "github.com": [
                      {
                        state: "success",
                        active: true,
                        host: "github.com",
                        login: "another-user",
                        tokenSource: "keyring",
                        gitProtocol: "ssh",
                      },
                    ],
                  }
                : {},
            }),
          );
        if (input.args[0] === "api") return output('{"id":123,"login":"connected-user"}');
        if (input.args.includes("list")) return output("[]");
        return output("");
      }),
  };
  const github = yield* GitHubCli.make.pipe(
    Effect.provideService(VcsProcess.VcsProcess, process),
    Effect.provide(store),
  );
  const provider = yield* GitHubProvider.make.pipe(
    Effect.provideService(GitHubCli.GitHubCli, github),
  );
  const cli = yield* GitHubPullRequestCli.make.pipe(
    Effect.provideService(GitHubCli.GitHubCli, github),
    Effect.provide(GitHubGraphQlBudget.layer),
  );
  const discovery = yield* GitHubProvider.makeDiscovery.pipe(
    Effect.provideService(GitHubCli.GitHubCli, github),
    Effect.provideService(VcsProcess.VcsProcess, process),
    Effect.provide(store),
  );
  return { state, calls, github, provider, cli, discovery };
});
const context = {
  provider: { kind: "github" as const, name: "GitHub", baseUrl: "https://github.com" },
  remoteName: "origin",
  remoteUrl: "git@github.com:owner/repo.git",
};

it.effect("uses Work's account for PR routing, listing and thread creation without gh login", () =>
  Effect.gen(function* () {
    const { cli, provider, calls } = yield* setup;
    assert.deepEqual(yield* cli.getRoutingIdentity({ cwd: "/repo", host: "github.com" }), {
      accountId: "123",
      viewer: "connected-user",
    });
    yield* provider.listChangeRequests({
      cwd: "/repo",
      context,
      state: "open",
      headSelector: "feature",
    });
    yield* provider.createChangeRequest({
      cwd: "/repo",
      context,
      baseRefName: "main",
      headSelector: "feature",
      title: "Fix",
      bodyFile: "/tmp/body.md",
    });
    assert.isFalse(calls.some((call) => call.args[0] === "auth"));
    assert.strictEqual(calls.length, 3);
    for (const call of calls) {
      assert.strictEqual(call.env?.GH_TOKEN, "connected-token");
      assert.strictEqual(call.env?.GH_DEBUG, "");
      assert.notInclude(call.args.join(" "), "connected-token");
    }
    assert.include(calls[2]!.args, "github.com/owner/repo");
  }),
);

it.effect(
  "pins active reads, rotates cache identity on token changes, and requires reconnection after disconnect",
  () =>
    Effect.gen(function* () {
      const { cli, state, calls } = yield* setup;
      const target = { cwd: "/repo", host: "github.com" };
      const first = yield* cli.withVerifiedCredential(target, (identity) =>
        Effect.gen(function* () {
          state.token = "replacement-token";
          yield* cli.commentOnPullRequest({
            ...target,
            repository: "owner/repo",
            number: 1,
            body: "Reviewed update",
          });
          return identity;
        }),
      );
      const second = yield* cli.withVerifiedCredential(target, Effect.succeed);
      assert.notStrictEqual(first.credentialFingerprint, second.credentialFingerprint);
      assert.strictEqual(
        calls.find((call) => call.args[0] === "pr")?.env?.GH_TOKEN,
        "connected-token",
      );
      state.token = null;
      const count = calls.length;
      const error = yield* cli.getRoutingIdentity(target).pipe(Effect.flip);
      assert.strictEqual(error._tag, "GitHubCliAuthenticationError");
      assert.strictEqual(calls.length, count);
      assert.isFalse(calls.some((call) => call.args[0] === "auth"));
    }),
);

it.effect("ignores request environment credentials in favor of the connected account", () =>
  Effect.gen(function* () {
    const { github, state, calls } = yield* setup;
    const input = {
      cwd: "/repo",
      args: ["api", "user", "--hostname", "github.com"],
      env: { GH_TOKEN: "another-account", GITHUB_TOKEN: "another-account" },
    };
    yield* github.execute(input);
    assert.strictEqual(calls[0]?.env?.GH_TOKEN, "connected-token");
    state.token = null;
    const error = yield* github.execute(input).pipe(Effect.flip);
    assert.strictEqual(error._tag, "GitHubCliAuthenticationError");
    assert.strictEqual(calls.length, 1);
  }),
);

it.effect(
  "never forwards the account token to enterprise or implicit hosts and fails closed on storage errors",
  () =>
    Effect.gen(function* () {
      const { github, state, calls } = yield* setup;
      for (const args of [
        ["api", "user", "--hostname", "github.enterprise.test"],
        ["api", "user"],
      ]) {
        yield* github.execute({ cwd: "/repo", args });
      }
      assert.isTrue(calls.every((call) => call.env?.GH_TOKEN === undefined));
      state.fail = true;
      const error = yield* github
        .execute({ cwd: "/repo", args: ["api", "user", "--hostname", "github.com"] })
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "GitHubCliAuthenticationError");
      assert.include(error.message, "Work → GitHub");
      assert.strictEqual(calls.length, 2);
    }),
);

it.effect(
  "reports the connected account in source-control discovery even when gh is signed out",
  () =>
    Effect.gen(function* () {
      const { discovery, state } = yield* setup;
      assert.strictEqual(discovery.type, "managed-cli");
      if (discovery.type !== "managed-cli") return;
      const connected = yield* discovery.probe("/repo");
      assert.strictEqual(connected.auth.status, "authenticated");
      assert.deepEqual(connected.auth.account, Option.some("connected-user"));
      state.token = null;
      state.cliSignedIn = true;
      assert.strictEqual((yield* discovery.probe("/repo")).auth.status, "unauthenticated");
    }),
);
