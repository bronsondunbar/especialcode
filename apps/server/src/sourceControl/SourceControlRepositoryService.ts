import {
  normalizeGitRemoteUrl,
  parseGitHubRepositoryNameWithOwnerFromRemoteUrl,
} from "@t3tools/shared/git";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { githubAccountSecretName } from "../auth/githubAccountSecret.ts";
import * as Option from "effect/Option";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  SourceControlRepositoryError,
  type SourceControlExistingRepositoryInput,
  type SourceControlPublishBranchInput,
  type SourceControlCloneRepositoryInput,
  type SourceControlCloneRepositoryResult,
  type SourceControlCloneProtocol,
  type SourceControlProviderKind,
  type SourceControlPublishRepositoryInput,
  type SourceControlPublishRepositoryResult,
  type SourceControlRepositoryCloneUrls,
  type SourceControlRepositoryInfo,
  type SourceControlRepositoryLookupInput,
} from "@t3tools/contracts";

import { ServerConfig } from "../config.ts";
import { expandHomePathWith } from "../pathExpansion.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as SourceControlProviderRegistry from "./SourceControlProviderRegistry.ts";
const isSourceControlRepositoryError = Schema.is(SourceControlRepositoryError);

export class SourceControlRepositoryService extends Context.Service<
  SourceControlRepositoryService,
  {
    readonly existingRepository: (
      input: SourceControlExistingRepositoryInput,
    ) => Effect.Effect<{ cwd: string }, SourceControlRepositoryError>;
    readonly publishBranch: (
      input: SourceControlPublishBranchInput,
    ) => Effect.Effect<void, SourceControlRepositoryError>;
    readonly lookupRepository: (
      input: SourceControlRepositoryLookupInput,
    ) => Effect.Effect<SourceControlRepositoryInfo, SourceControlRepositoryError>;
    readonly cloneRepository: (
      input: SourceControlCloneRepositoryInput,
    ) => Effect.Effect<SourceControlCloneRepositoryResult, SourceControlRepositoryError>;
    readonly publishRepository: (
      input: SourceControlPublishRepositoryInput,
    ) => Effect.Effect<SourceControlPublishRepositoryResult, SourceControlRepositoryError>;
  }
>()("t3/sourceControl/SourceControlRepositoryService") {}

function mapRepositoryError(operation: string, provider: SourceControlProviderKind) {
  return Effect.mapError((cause: unknown) =>
    isSourceControlRepositoryError(cause)
      ? cause
      : new SourceControlRepositoryError({
          operation,
          provider,
          detail: "The source control operation could not be completed.",
          cause,
        }),
  );
}

function toRepositoryInfo(
  provider: SourceControlProviderKind,
  urls: SourceControlRepositoryCloneUrls,
): SourceControlRepositoryInfo {
  return {
    provider,
    nameWithOwner: urls.nameWithOwner,
    url: urls.url,
    sshUrl: urls.sshUrl,
  };
}

function selectRemoteUrl(
  urls: SourceControlRepositoryCloneUrls,
  protocol: SourceControlCloneProtocol | undefined,
): string {
  switch (protocol ?? "auto") {
    case "https":
      return urls.url;
    case "ssh":
    case "auto":
      return urls.sshUrl;
  }
}

function githubEnvironment(token: Uint8Array): NodeJS.ProcessEnv {
  // Process-only credentials: never persist the token in the URL or Git config.
  const credential = Buffer.from(`x-access-token:${new TextDecoder().decode(token)}`).toString(
    "base64",
  );
  return {
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${credential}`,
    GIT_CONFIG_KEY_1: "http.followRedirects",
    GIT_CONFIG_VALUE_1: "false",
    GIT_CONFIG_KEY_2: "credential.helper",
    GIT_CONFIG_VALUE_2: "",
  };
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const secrets = yield* ServerSecretStore;
  const fileSystem = yield* FileSystem.FileSystem;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const path = yield* Path.Path;
  const providers = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;

  const ensureConcreteProvider = (input: {
    readonly operation: string;
    readonly provider: SourceControlProviderKind;
  }) => {
    if (input.provider !== "unknown") {
      return Effect.succeed(input.provider);
    }

    return Effect.fail(
      new SourceControlRepositoryError({
        operation: input.operation,
        provider: input.provider,
        detail: "Choose a source control provider before continuing.",
      }),
    );
  };

  const lookupRepository = Effect.fn("SourceControlRepositoryService.lookupRepository")(function* (
    input: SourceControlRepositoryLookupInput,
  ) {
    const providerKind = yield* ensureConcreteProvider({
      operation: "lookupRepository",
      provider: input.provider,
    });
    const provider = yield* providers.get(providerKind);
    const urls = yield* provider.getRepositoryCloneUrls({
      cwd: input.cwd ?? config.cwd,
      repository: input.repository.trim(),
    });
    return toRepositoryInfo(providerKind, urls);
  });

  const normalizeDestinationPath = Effect.fn("SourceControlRepositoryService.normalizeDestination")(
    function* (destinationPath: string) {
      const trimmed = destinationPath.trim();
      if (trimmed.length === 0) {
        return yield* new SourceControlRepositoryError({
          operation: "cloneRepository",
          provider: "unknown",
          detail: "Choose a destination path before cloning.",
        });
      }

      return path.resolve(expandHomePathWith(trimmed, path));
    },
  );

  const prepareDestination = Effect.fn("SourceControlRepositoryService.prepareDestination")(
    function* (destinationPath: string) {
      const normalizedDestination = yield* normalizeDestinationPath(destinationPath);
      if (yield* fileSystem.exists(normalizedDestination)) {
        const entries = yield* fileSystem
          .readDirectory(normalizedDestination, { recursive: false })
          .pipe(
            Effect.mapError(
              (cause) =>
                new SourceControlRepositoryError({
                  operation: "cloneRepository",
                  provider: "unknown",
                  detail: "Destination path already exists and is not a directory.",
                  cause,
                }),
            ),
          );
        if (entries.length > 0) {
          return yield* new SourceControlRepositoryError({
            operation: "cloneRepository",
            provider: "unknown",
            detail: "Destination path already exists and is not empty.",
          });
        }
      } else {
        yield* fileSystem.makeDirectory(path.dirname(normalizedDestination), { recursive: true });
      }

      return {
        destinationPath: normalizedDestination,
        parentPath: path.dirname(normalizedDestination),
        directoryName: path.basename(normalizedDestination),
      };
    },
  );

  const existingRepository = Effect.fn("SourceControlRepositoryService.existingRepository")(
    function* (input: SourceControlExistingRepositoryInput) {
      const fail = (detail: string) =>
        new SourceControlRepositoryError({
          operation: "existingRepository",
          provider: "github",
          detail,
        });
      const cwd = path.resolve(expandHomePathWith(input.cwd.trim(), path));
      if (!(yield* fileSystem.exists(cwd)))
        return yield* fail(
          "That folder does not exist on the connected server. Select the folder containing your checkout.",
        );
      const root = yield* git
        .execute({
          cwd,
          operation: "existingRepository.root",
          args: ["rev-parse", "--show-toplevel"],
        })
        .pipe(
          Effect.mapError(() =>
            fail("That folder is not inside a Git checkout. Select an existing repository."),
          ),
        );
      const workspaceRoot = root.stdout.trim();
      if (!workspaceRoot || !(yield* fileSystem.exists(workspaceRoot)))
        return yield* fail("The repository root is unavailable. Select another folder.");
      const remote = yield* git
        .resolvePrimaryRemoteName(workspaceRoot)
        .pipe(
          Effect.mapError(() =>
            fail("This checkout has no remote. Add its GitHub remote before selecting it."),
          ),
        );
      const remoteUrl = yield* git.readConfigValue(workspaceRoot, `remote.${remote}.url`);
      if (
        !remoteUrl ||
        normalizeGitRemoteUrl(remoteUrl) !== `github.com/${input.repository.toLowerCase()}`
      )
        return yield* fail(
          `This checkout’s primary remote does not match ${input.repository}. Select its checkout or change the selected repository.`,
        );
      return { cwd: workspaceRoot };
    },
  );

  const cloneRepository = Effect.fn("SourceControlRepositoryService.cloneRepository")(function* (
    input: SourceControlCloneRepositoryInput,
  ) {
    const preparedDestination = yield* prepareDestination(input.destinationPath);
    let repository: SourceControlRepositoryInfo | null = null;
    let remoteUrl = input.remoteUrl?.trim() ?? null;
    let provider: SourceControlProviderKind = input.provider ?? "unknown";

    let cloneEnv: NodeJS.ProcessEnv | undefined;
    if (input.connectedGitHubRepository) {
      const token = yield* secrets.get(githubAccountSecretName);
      if (Option.isNone(token))
        return yield* new SourceControlRepositoryError({
          operation: "cloneRepository",
          provider: "github",
          detail: "Connect your GitHub account before cloning.",
        });
      provider = "github";
      remoteUrl = `https://github.com/${input.connectedGitHubRepository}.git`;
      repository = {
        provider,
        nameWithOwner: input.connectedGitHubRepository,
        url: `https://github.com/${input.connectedGitHubRepository}`,
        sshUrl: `git@github.com:${input.connectedGitHubRepository}.git`,
      };
      cloneEnv = githubEnvironment(token.value);
    } else if (input.provider && input.repository) {
      repository = yield* lookupRepository({
        provider: input.provider,
        repository: input.repository,
        cwd: preparedDestination.parentPath,
      });
      remoteUrl = selectRemoteUrl(repository, input.protocol);
      provider = input.provider;
    }

    if (!remoteUrl) {
      return yield* new SourceControlRepositoryError({
        operation: "cloneRepository",
        provider,
        detail: "Enter a repository path or clone URL before cloning.",
      });
    }

    yield* git
      .execute({
        operation: "SourceControlRepositoryService.cloneRepository",
        cwd: preparedDestination.parentPath,
        args: ["clone", remoteUrl, preparedDestination.directoryName],
        timeoutMs: 120_000,
        maxOutputBytes: 256 * 1024,
        ...(cloneEnv ? { env: cloneEnv } : {}),
      })
      .pipe(
        Effect.mapError((cause) =>
          cloneEnv
            ? new SourceControlRepositoryError({
                operation: "cloneRepository",
                provider: "github",
                detail:
                  "Could not clone this repository. Check token access and the destination folder.",
              })
            : cause,
        ),
      );

    return {
      cwd: preparedDestination.destinationPath,
      remoteUrl,
      repository,
    };
  });

  const publishRepository = Effect.fn("SourceControlRepositoryService.publishRepository")(
    function* (input: SourceControlPublishRepositoryInput) {
      const providerKind = yield* ensureConcreteProvider({
        operation: "publishRepository",
        provider: input.provider,
      });
      const provider = yield* providers.get(providerKind);
      const urls = yield* provider.createRepository({
        cwd: input.cwd,
        repository: input.repository.trim(),
        visibility: input.visibility,
      });
      const remoteUrl = selectRemoteUrl(urls, input.protocol);
      const remoteName = yield* git.ensureRemote({
        cwd: input.cwd,
        preferredName: input.remoteName?.trim() || "origin",
        url: remoteUrl,
      });

      // An empty local repo (no commits) would make `git push HEAD:...` fail
      // with an opaque "src refspec HEAD does not match any". Treat this as a
      // partial success: the remote was created and wired up, but there is
      // nothing to push yet.
      const hasCommits = yield* git
        .execute({
          operation: "SourceControlRepositoryService.publishRepository.headCheck",
          cwd: input.cwd,
          args: ["rev-parse", "--verify", "HEAD"],
        })
        .pipe(
          Effect.map(() => true),
          Effect.orElseSucceed(() => false),
        );
      if (!hasCommits) {
        const details = yield* git.statusDetails(input.cwd).pipe(Effect.orElseSucceed(() => null));
        return {
          repository: toRepositoryInfo(providerKind, urls),
          remoteName,
          remoteUrl,
          branch: details?.branch ?? "main",
          status: "remote_added" as const,
        };
      }

      const pushResult = yield* git.pushCurrentBranch(input.cwd, null, { remoteName });

      return {
        repository: toRepositoryInfo(providerKind, urls),
        remoteName,
        remoteUrl,
        branch: pushResult.branch,
        ...(pushResult.upstreamBranch ? { upstreamBranch: pushResult.upstreamBranch } : {}),
        status: "pushed" as const,
      };
    },
  );

  const publishBranch = Effect.fn("SourceControlRepositoryService.publishBranch")(function* (
    input: SourceControlPublishBranchInput,
  ) {
    const fail = (detail: string) =>
      new SourceControlRepositoryError({ operation: "publishBranch", provider: "github", detail });
    yield* git.execute({
      cwd: input.cwd,
      operation: "publishBranch.validate",
      args: ["check-ref-format", `refs/heads/${input.branch}`],
    });
    const head = yield* git.execute({
      cwd: input.cwd,
      operation: "publishBranch.head",
      args: ["symbolic-ref", "--short", "HEAD"],
    });
    if (head.stdout.trim() !== input.branch)
      return yield* fail("The checkout branch changed. Reopen the task and retry.");
    const remotes = yield* git.execute({
      cwd: input.cwd,
      operation: "publishBranch.remotes",
      args: ["remote"],
    });
    if (!remotes.stdout.trim()) return;
    const remote = yield* git.resolvePrimaryRemoteName(input.cwd);
    const url = yield* git.readConfigValue(input.cwd, `remote.${remote}.url`);
    if (!url) return; // A local-only repository has no remote branch to create.
    const repository = parseGitHubRepositoryNameWithOwnerFromRemoteUrl(url);
    let env: NodeJS.ProcessEnv = { GIT_TERMINAL_PROMPT: "0" };
    if (repository) {
      const token = yield* secrets.get(githubAccountSecretName);
      if (Option.isNone(token))
        return yield* fail("Connect GitHub before creating the remote branch.");
      env = githubEnvironment(token.value);
    }
    const target = repository ? `https://github.com/${repository}.git` : url;
    const ref = `refs/heads/${input.branch}`;
    const sha = (yield* git.execute({
      cwd: input.cwd,
      operation: "publishBranch.commit",
      args: ["rev-parse", "--verify", ref],
    })).stdout.trim();
    yield* Effect.gen(function* () {
      const existing = yield* git.execute({
        cwd: input.cwd,
        operation: "publishBranch.remote",
        args: ["ls-remote", "--heads", target, ref],
        env,
      });
      const remoteSha = existing.stdout.trim().split(/\s+/)[0];
      if (remoteSha && remoteSha !== sha)
        return yield* fail(
          "That branch already exists on the remote with different commits. Choose another branch name.",
        );
      if (!remoteSha)
        yield* git.execute({
          cwd: input.cwd,
          operation: "publishBranch.push",
          env,
          timeoutMs: 120_000,
          // The empty lease allows creation only, even if another client creates the branch concurrently.
          args: [
            "push",
            "--porcelain",
            `--force-with-lease=${ref}:`,
            "--",
            target,
            `${ref}:${ref}`,
          ],
        });
    }).pipe(
      Effect.mapError((error) =>
        isSourceControlRepositoryError(error)
          ? error
          : fail(
              "Could not create the remote branch. Check repository write access and retry; the local branch is retained.",
            ),
      ),
    );
    yield* git.execute({
      cwd: input.cwd,
      operation: "publishBranch.upstream",
      args: ["config", `branch.${input.branch}.remote`, remote],
    });
    yield* git.execute({
      cwd: input.cwd,
      operation: "publishBranch.upstream",
      args: ["config", `branch.${input.branch}.merge`, ref],
    });
    yield* git.execute({
      cwd: input.cwd,
      operation: "publishBranch.tracking",
      args: ["update-ref", `refs/remotes/${remote}/${input.branch}`, sha],
    });
  });

  return SourceControlRepositoryService.of({
    existingRepository: (input) =>
      existingRepository(input).pipe(mapRepositoryError("existingRepository", "github")),
    publishBranch: (input) =>
      publishBranch(input).pipe(mapRepositoryError("publishBranch", "github")),
    lookupRepository: (input) =>
      lookupRepository(input).pipe(mapRepositoryError("lookupRepository", input.provider)),
    cloneRepository: (input) =>
      cloneRepository(input).pipe(
        mapRepositoryError("cloneRepository", input.provider ?? "unknown"),
      ),
    publishRepository: (input) =>
      publishRepository(input).pipe(mapRepositoryError("publishRepository", input.provider)),
  });
});

export const layer = Layer.effect(SourceControlRepositoryService, make);
