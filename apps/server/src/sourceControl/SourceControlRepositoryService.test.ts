import * as Option from "effect/Option";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/unstable/process";

import { GitCommandError, SourceControlProviderError } from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import type * as SourceControlProvider from "./SourceControlProvider.ts";
import * as SourceControlProviderRegistry from "./SourceControlProviderRegistry.ts";
import * as SourceControlRepositoryService from "./SourceControlRepositoryService.ts";

const CLONE_URLS = {
  nameWithOwner: "octocat/t3code",
  url: "https://github.com/octocat/t3code",
  sshUrl: "git@github.com:octocat/t3code.git",
};

function makeProvider(
  overrides: Partial<SourceControlProvider.SourceControlProvider["Service"]> = {},
): SourceControlProvider.SourceControlProvider["Service"] {
  const unsupported = (operation: string) =>
    Effect.die(`unexpected provider operation ${operation}`) as Effect.Effect<
      never,
      SourceControlProviderError
    >;

  return {
    kind: "github",
    listChangeRequests: () => unsupported("listChangeRequests"),
    getChangeRequest: () => unsupported("getChangeRequest"),
    createChangeRequest: () => unsupported("createChangeRequest"),
    getRepositoryCloneUrls: () => Effect.succeed(CLONE_URLS),
    createRepository: () => Effect.succeed(CLONE_URLS),
    getDefaultBranch: () => Effect.succeed(null),
    checkoutChangeRequest: () => unsupported("checkoutChangeRequest"),
    ...overrides,
  };
}

function processOutput(): GitVcsDriver.ExecuteGitResult {
  return {
    exitCode: ChildProcessSpawner.ExitCode(0),
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

function makeLayer(input: {
  readonly token?: string;
  readonly provider?: SourceControlProvider.SourceControlProvider["Service"];
  readonly git?: Partial<GitVcsDriver.GitVcsDriver["Service"]>;
  readonly fileSystem?: FileSystem.FileSystem;
}) {
  const serviceLayer = SourceControlRepositoryService.layer.pipe(
    Layer.provide(
      Layer.mock(ServerSecretStore)({
        get: () =>
          Effect.succeed(
            input.token ? Option.some(new TextEncoder().encode(input.token)) : Option.none(),
          ),
      }),
    ),
    Layer.provide(
      Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
        get: () => Effect.succeed(input.provider ?? makeProvider()),
      }),
    ),
    Layer.provide(
      Layer.mock(GitVcsDriver.GitVcsDriver)({
        execute: () => Effect.succeed(processOutput()),
        ensureRemote: () => Effect.succeed("origin"),
        pushCurrentBranch: () =>
          Effect.succeed({
            status: "pushed" as const,
            branch: "feature/remote-v1",
            upstreamBranch: "origin/feature/remote-v1",
            setUpstream: true,
          }),
        ...input.git,
      }),
    ),
    Layer.provide(
      ServerConfig.layerTest(
        process.cwd(),
        input.fileSystem ? "/tmp/t3-source-control-repos" : { prefix: "t3-source-control-repos-" },
      ),
    ),
  );

  return input.fileSystem
    ? serviceLayer.pipe(
        Layer.provide(Layer.succeed(FileSystem.FileSystem, input.fileSystem)),
        Layer.provideMerge(NodePath.layer),
      )
    : serviceLayer.pipe(Layer.provideMerge(NodeServices.layer));
}

it.effect("looks up repositories through the requested provider without search", () => {
  const calls: Array<{ cwd: string; repository: string }> = [];
  const provider = makeProvider({
    getRepositoryCloneUrls: (input) =>
      Effect.sync(() => {
        calls.push({ cwd: input.cwd, repository: input.repository });
        return CLONE_URLS;
      }),
  });

  return Effect.gen(function* () {
    const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
    const result = yield* service.lookupRepository({
      provider: "github",
      repository: "octocat/t3code",
      cwd: "/workspace",
    });

    assert.deepStrictEqual(result, { provider: "github", ...CLONE_URLS });
    assert.deepStrictEqual(calls, [{ cwd: "/workspace", repository: "octocat/t3code" }]);
  }).pipe(Effect.provide(makeLayer({ provider })));
});

it.effect("preserves provider failures without deriving the repository message from them", () => {
  const providerCause = new SourceControlProviderError({
    provider: "github",
    operation: "getRepositoryCloneUrls",
    cwd: "/workspace",
    repository: "octocat/t3code",
    detail: "credential token abc123 was rejected",
  });
  const provider = makeProvider({
    getRepositoryCloneUrls: () => Effect.fail(providerCause),
  });

  return Effect.gen(function* () {
    const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
    const error = yield* Effect.flip(
      service.lookupRepository({
        provider: "github",
        repository: "octocat/t3code",
        cwd: "/workspace",
      }),
    );

    assert.strictEqual(error.provider, "github");
    assert.strictEqual(error.operation, "lookupRepository");
    assert.strictEqual(error.detail, "The source control operation could not be completed.");
    assert.strictEqual(
      error.message,
      "Source control repository operation lookupRepository failed for github: The source control operation could not be completed.",
    );
    assert.strictEqual(error.cause, providerCause);
  }).pipe(Effect.provide(makeLayer({ provider })));
});

it.effect("clones a looked-up repository into the requested destination", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const parent = yield* fs.makeTempDirectoryScoped({
      prefix: "t3-source-control-clone-parent-",
    });
    const destinationPath = path.join(parent, "t3code");
    const cloneCalls: Array<{ cwd: string; args: ReadonlyArray<string> }> = [];

    yield* Effect.gen(function* () {
      const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
      const result = yield* service.cloneRepository({
        provider: "github",
        repository: "octocat/t3code",
        destinationPath,
        protocol: "https",
      });

      assert.deepStrictEqual(result, {
        cwd: destinationPath,
        remoteUrl: CLONE_URLS.url,
        repository: { provider: "github", ...CLONE_URLS },
      });
      assert.deepStrictEqual(cloneCalls, [
        {
          cwd: parent,
          args: ["clone", CLONE_URLS.url, "t3code"],
        },
      ]);
    }).pipe(
      Effect.provide(
        makeLayer({
          git: {
            execute: (input) =>
              Effect.sync(() => {
                cloneCalls.push({ cwd: input.cwd, args: input.args });
                return processOutput();
              }),
          },
        }),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("preserves destination probe failures instead of treating them as missing paths", () => {
  const fileSystemCause = PlatformError.systemError({
    _tag: "PermissionDenied",
    module: "FileSystem",
    method: "exists",
    pathOrDescriptor: "/restricted/t3code",
  });

  return Effect.gen(function* () {
    const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
    const error = yield* Effect.flip(
      service.cloneRepository({
        remoteUrl: CLONE_URLS.sshUrl,
        destinationPath: "/restricted/t3code",
      }),
    );

    assert.strictEqual(error.provider, "unknown");
    assert.strictEqual(error.operation, "cloneRepository");
    assert.strictEqual(error.cause, fileSystemCause);
  }).pipe(
    Effect.provide(
      makeLayer({
        fileSystem: FileSystem.makeNoop({
          exists: () => Effect.fail(fileSystemCause),
          makeDirectory: () => Effect.void,
        }),
      }),
    ),
  );
});

it.effect("publishes by creating the repository, adding a remote, and pushing upstream", () => {
  const createCalls: Array<{ cwd: string; repository: string; visibility: string }> = [];
  const remoteCalls: Array<{ cwd: string; preferredName: string; url: string }> = [];
  const pushCalls: Array<{ cwd: string; remoteName: string | null | undefined }> = [];
  const provider = makeProvider({
    createRepository: (input) =>
      Effect.sync(() => {
        createCalls.push({
          cwd: input.cwd,
          repository: input.repository,
          visibility: input.visibility,
        });
        return CLONE_URLS;
      }),
  });

  return Effect.gen(function* () {
    const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
    const result = yield* service.publishRepository({
      cwd: "/workspace",
      provider: "github",
      repository: "octocat/t3code",
      visibility: "private",
      remoteName: "origin",
      protocol: "ssh",
    });

    assert.deepStrictEqual(result, {
      repository: { provider: "github", ...CLONE_URLS },
      remoteName: "origin",
      remoteUrl: CLONE_URLS.sshUrl,
      branch: "feature/remote-v1",
      upstreamBranch: "origin/feature/remote-v1",
      status: "pushed",
    });
    assert.deepStrictEqual(createCalls, [
      { cwd: "/workspace", repository: "octocat/t3code", visibility: "private" },
    ]);
    assert.deepStrictEqual(remoteCalls, [
      { cwd: "/workspace", preferredName: "origin", url: CLONE_URLS.sshUrl },
    ]);
    assert.deepStrictEqual(pushCalls, [{ cwd: "/workspace", remoteName: "origin" }]);
  }).pipe(
    Effect.provide(
      makeLayer({
        provider,
        git: {
          ensureRemote: (input) =>
            Effect.sync(() => {
              remoteCalls.push(input);
              return "origin";
            }),
          pushCurrentBranch: (cwd, _fallbackBranch, options) =>
            Effect.sync(() => {
              pushCalls.push({ cwd, remoteName: options?.remoteName });
              return {
                status: "pushed" as const,
                branch: "feature/remote-v1",
                upstreamBranch: "origin/feature/remote-v1",
                setUpstream: true,
              };
            }),
        },
      }),
    ),
  );
});

it.effect("publishes to the remote name returned by ensureRemote", () => {
  const pushCalls: Array<{ cwd: string; remoteName: string | null | undefined }> = [];

  return Effect.gen(function* () {
    const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
    const result = yield* service.publishRepository({
      cwd: "/workspace",
      provider: "github",
      repository: "octocat/t3code",
      visibility: "private",
      remoteName: "origin",
      protocol: "ssh",
    });

    assert.equal(result.remoteName, "origin-1");
    assert.deepStrictEqual(pushCalls, [{ cwd: "/workspace", remoteName: "origin-1" }]);
  }).pipe(
    Effect.provide(
      makeLayer({
        git: {
          ensureRemote: () => Effect.succeed("origin-1"),
          pushCurrentBranch: (cwd, _fallbackBranch, options) =>
            Effect.sync(() => {
              pushCalls.push({ cwd, remoteName: options?.remoteName });
              return {
                status: "pushed" as const,
                branch: "feature/remote-v1",
                upstreamBranch: `${options?.remoteName ?? "missing"}/feature/remote-v1`,
                setUpstream: true,
              };
            }),
        },
      }),
    ),
  );
});

it.effect("publish succeeds with status remote_added when the local repo has no commits", () => {
  let pushCalls = 0;
  return Effect.gen(function* () {
    const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
    const result = yield* service.publishRepository({
      cwd: "/workspace",
      provider: "github",
      repository: "octocat/t3code",
      visibility: "private",
      remoteName: "origin",
      protocol: "ssh",
    });

    assert.deepStrictEqual(result, {
      repository: { provider: "github", ...CLONE_URLS },
      remoteName: "origin",
      remoteUrl: CLONE_URLS.sshUrl,
      branch: "main",
      status: "remote_added",
    });
    assert.strictEqual(pushCalls, 0);
  }).pipe(
    Effect.provide(
      makeLayer({
        git: {
          execute: (input) =>
            input.args[0] === "rev-parse"
              ? Effect.fail(
                  new GitCommandError({
                    operation: input.operation,
                    command: "git rev-parse --verify HEAD",
                    cwd: input.cwd,
                    detail: "fatal: Needed a single revision",
                  }),
                )
              : Effect.succeed(processOutput()),
          statusDetails: () =>
            Effect.succeed({
              isRepo: true,
              hasOriginRemote: true,
              isDefaultBranch: true,
              branch: "main",
              upstreamRef: null,
              hasWorkingTreeChanges: false,
              workingTree: { files: [], insertions: 0, deletions: 0 },
              hasUpstream: false,
              aheadCount: 0,
              behindCount: 0,
              aheadOfDefaultCount: 0,
            }),
          pushCurrentBranch: () =>
            Effect.sync(() => {
              pushCalls += 1;
              return {
                status: "pushed" as const,
                branch: "main",
                upstreamBranch: "origin/main",
                setUpstream: true,
              };
            }),
        },
      }),
    ),
  );
});

it.effect(
  "clones connected GitHub repositories with ephemeral token credentials and a clean origin URL",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const parent = yield* fs.makeTempDirectoryScoped({ prefix: "t3-account-clone-" });
      const calls: GitVcsDriver.ExecuteGitInput[] = [];
      yield* Effect.gen(function* () {
        const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
        const result = yield* service.cloneRepository({
          connectedGitHubRepository: "org/private",
          destinationPath: `${parent}/private`,
          remoteUrl: "https://other.example/repo.git",
        });
        assert.strictEqual(result.remoteUrl, "https://github.com/org/private.git");
        assert.strictEqual(result.repository?.nameWithOwner, "org/private");
        assert.deepEqual(calls[0]?.args, [
          "clone",
          "https://github.com/org/private.git",
          "private",
        ]);
        assert.strictEqual(calls[0]?.env?.GIT_CONFIG_KEY_0, "http.https://github.com/.extraheader");
        assert.strictEqual(
          calls[0]?.env?.GIT_CONFIG_VALUE_0,
          `AUTHORIZATION: basic ${Buffer.from("x-access-token:test-token").toString("base64")}`,
        );
        assert.strictEqual(calls[0]?.env?.GIT_CONFIG_VALUE_1, "false");
      }).pipe(
        Effect.provide(
          makeLayer({
            token: "test-token",
            git: {
              execute: (input) =>
                Effect.sync(() => {
                  calls.push(input);
                  return processOutput();
                }),
            },
          }),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "refuses a connected-account clone without a token rather than using machine Git credentials",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const parent = yield* fs.makeTempDirectoryScoped({ prefix: "t3-account-clone-" });
      yield* Effect.gen(function* () {
        const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
        const error = yield* service
          .cloneRepository({
            connectedGitHubRepository: "org/private",
            destinationPath: `${parent}/private`,
          })
          .pipe(Effect.flip);
        assert.include(error.detail, "Connect your GitHub account");
      }).pipe(
        Effect.provide(makeLayer({ git: { execute: () => Effect.die("Must not invoke Git") } })),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);

const branchSha = "1".repeat(40);
const branchInput = { cwd: "/repo/worktree", branch: "codex/fix-issue" };
function branchGit(
  calls: GitVcsDriver.ExecuteGitInput[],
  remoteSha = "",
  noRemote = false,
): Partial<GitVcsDriver.GitVcsDriver["Service"]> {
  return {
    resolvePrimaryRemoteName: () => Effect.succeed("origin"),
    readConfigValue: () => Effect.succeed("git@github.com:org/private.git"),
    execute: (input) =>
      Effect.sync(() => {
        calls.push(input);
        const stdout =
          input.operation === "publishBranch.head"
            ? branchInput.branch
            : input.operation === "publishBranch.remotes"
              ? noRemote
                ? ""
                : "origin"
              : input.operation === "publishBranch.commit"
                ? branchSha
                : input.operation === "publishBranch.remote"
                  ? remoteSha
                    ? `${remoteSha}\trefs/heads/${branchInput.branch}`
                    : ""
                  : "";
        return { ...processOutput(), stdout };
      }),
  };
}

it.effect(
  "creates the remote branch using the connected token with a creation-only lease and sets its upstream",
  () => {
    const calls: GitVcsDriver.ExecuteGitInput[] = [];
    return Effect.gen(function* () {
      const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
      yield* service.publishBranch(branchInput);
      const push = calls.find((call) => call.operation === "publishBranch.push")!;
      assert.deepEqual(push.args, [
        "push",
        "--porcelain",
        "--force-with-lease=refs/heads/codex/fix-issue:",
        "--",
        "https://github.com/org/private.git",
        "refs/heads/codex/fix-issue:refs/heads/codex/fix-issue",
      ]);
      assert.strictEqual(
        push.env?.GIT_CONFIG_VALUE_0,
        `AUTHORIZATION: basic ${Buffer.from("x-access-token:test-token").toString("base64")}`,
      );
      assert.deepEqual(calls.at(-1)?.args, [
        "update-ref",
        "refs/remotes/origin/codex/fix-issue",
        branchSha,
      ]);
    }).pipe(Effect.provide(makeLayer({ token: "test-token", git: branchGit(calls) })));
  },
);

it.effect("reuses an already published branch on retry without pushing it again", () => {
  const calls: GitVcsDriver.ExecuteGitInput[] = [];
  return Effect.gen(function* () {
    const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
    yield* service.publishBranch(branchInput);
    assert.isFalse(calls.some((call) => call.operation === "publishBranch.push"));
    assert.isTrue(calls.some((call) => call.operation === "publishBranch.upstream"));
  }).pipe(Effect.provide(makeLayer({ token: "test-token", git: branchGit(calls, branchSha) })));
});

it.effect("does not overwrite a remote branch containing different commits", () => {
  const calls: GitVcsDriver.ExecuteGitInput[] = [];
  return Effect.gen(function* () {
    const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
    const error = yield* service.publishBranch(branchInput).pipe(Effect.flip);
    assert.include(error.detail, "different commits");
    assert.isFalse(calls.some((call) => call.operation === "publishBranch.push"));
  }).pipe(
    Effect.provide(makeLayer({ token: "test-token", git: branchGit(calls, "2".repeat(40)) })),
  );
});

it.effect("does not fall back to machine credentials for a GitHub branch", () => {
  const calls: GitVcsDriver.ExecuteGitInput[] = [];
  return Effect.gen(function* () {
    const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
    const error = yield* service.publishBranch(branchInput).pipe(Effect.flip);
    assert.include(error.detail, "Connect GitHub");
    assert.isFalse(calls.some((call) => call.operation === "publishBranch.remote"));
  }).pipe(Effect.provide(makeLayer({ git: branchGit(calls) })));
});

it.effect("keeps local-only repositories usable without a remote or GitHub account", () => {
  const calls: GitVcsDriver.ExecuteGitInput[] = [];
  return Effect.gen(function* () {
    const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
    yield* service.publishBranch(branchInput);
    assert.isFalse(calls.some((call) => call.operation === "publishBranch.remote"));
  }).pipe(Effect.provide(makeLayer({ git: branchGit(calls, "", true) })));
});

it.effect(
  "finds an existing checkout outside the app directory and resolves a selected subfolder to its root",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-existing-repo-" });
      yield* fs.makeDirectory(`${root}/src`);
      const calls: GitVcsDriver.ExecuteGitInput[] = [];
      yield* Effect.gen(function* () {
        const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
        assert.deepEqual(
          yield* service.existingRepository({ cwd: `${root}/src`, repository: "Org/Private" }),
          { cwd: root },
        );
        assert.deepEqual(
          calls.map((call) => call.args),
          [["rev-parse", "--show-toplevel"]],
        );
      }).pipe(
        Effect.provide(
          makeLayer({
            git: {
              execute: (input) =>
                Effect.sync(() => {
                  calls.push(input);
                  return { ...processOutput(), stdout: root + "\n" };
                }),
              resolvePrimaryRemoteName: () => Effect.succeed("origin"),
              readConfigValue: () => Effect.succeed("https://user@github.com/org/private.git"),
            },
          }),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("rejects missing folders, non-Git folders, and checkouts for another repository", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-existing-repo-" });
    yield* Effect.gen(function* () {
      const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
      const missing = yield* service
        .existingRepository({ cwd: `${root}/missing`, repository: "org/private" })
        .pipe(Effect.flip);
      assert.include(missing.detail, "does not exist");
      const different = yield* service
        .existingRepository({ cwd: root, repository: "org/private" })
        .pipe(Effect.flip);
      assert.include(different.detail, "does not match");
    }).pipe(
      Effect.provide(
        makeLayer({
          git: {
            execute: () => Effect.succeed({ ...processOutput(), stdout: root }),
            resolvePrimaryRemoteName: () => Effect.succeed("origin"),
            readConfigValue: () => Effect.succeed("git@github.com:other/repo.git"),
          },
        }),
      ),
    );
    yield* Effect.gen(function* () {
      const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
      const error = yield* service
        .existingRepository({ cwd: root, repository: "org/private" })
        .pipe(Effect.flip);
      assert.include(error.detail, "not inside a Git checkout");
    }).pipe(
      Effect.provide(
        makeLayer({
          git: {
            execute: () =>
              Effect.fail(
                new GitCommandError({
                  operation: "test",
                  command: "git",
                  cwd: root,
                  detail: "Not a repo",
                }),
              ),
          },
        }),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
