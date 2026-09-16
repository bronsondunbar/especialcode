import * as NodeCrypto from "node:crypto";
import { VercelError, VercelProject, type VercelDeployment } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest, FetchHttpClient } from "effect/unstable/http";
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeProject = Schema.decodeUnknownEffect(VercelProject);
const decodeProjects = Schema.decodeUnknownEffect(
  Schema.Union([
    Schema.Array(VercelProject),
    Schema.Struct({ projects: Schema.Array(VercelProject) }),
  ]),
);
const decodeDeployments = Schema.decodeUnknownEffect(
  Schema.Struct({
    deployments: Schema.Array(
      Schema.Struct({
        uid: Schema.String,
        name: Schema.String,
        url: Schema.NullOr(Schema.String),
        created: Schema.Finite,
        state: Schema.optionalKey(Schema.String),
        readyState: Schema.optionalKey(Schema.String),
        target: Schema.optionalKey(Schema.NullOr(Schema.String)),
        meta: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
      }),
    ),
  }),
);
const decodeLogs = Schema.decodeUnknownEffect(
  Schema.NullOr(
    Schema.Array(
      Schema.Struct({
        created: Schema.Finite,
        type: Schema.String,
        payload: Schema.Struct({ text: Schema.optionalKey(Schema.String) }),
      }),
    ),
  ),
);
const isError = Schema.is(VercelError);
export const fail = (message: string) => new VercelError({ message });
export interface VercelCredentials {
  token: string;
  teamId: string | null;
}
export const make = Effect.gen(function* () {
  const http = yield* HttpClient.HttpClient;
  const cooldowns = new Map<string, number>();
  const read = Effect.fn("VercelAdapter.read")(
    function* (credentials: VercelCredentials, path: string, params: Record<string, string> = {}) {
      const now = yield* Clock.currentTimeMillis;
      for (const [key, until] of cooldowns) if (until <= now) cooldowns.delete(key);
      const key = NodeCrypto.createHash("sha256").update(credentials.token).digest("hex");
      if (cooldowns.has(key))
        return yield* fail("Vercel is rate limiting requests. Wait before refreshing.");
      const query = new URLSearchParams({
        ...params,
        ...(credentials.teamId ? { teamId: credentials.teamId } : {}),
      });
      const response = yield* http
        .execute(
          HttpClientRequest.get(`https://api.vercel.com${path}?${query}`).pipe(
            HttpClientRequest.bearerToken(credentials.token),
            HttpClientRequest.setHeader("Accept", "application/json"),
          ),
        )
        .pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }));
      if (response.status === 401 || response.status === 403)
        return yield* fail("Vercel access was denied. Check the token, team and project access.");
      if (response.status === 404)
        return yield* fail("This Vercel project or deployment is unavailable.");
      if (response.status === 429) {
        const retry = response.headers["retry-after"];
        const seconds = retry && /^\d+$/.test(retry) ? Number(retry) : 60;
        cooldowns.set(key, now + Math.min(Math.max(seconds, 1), 3600) * 1000);
        return yield* fail("Vercel is rate limiting requests. Wait before refreshing.");
      }
      if (response.status !== 200) return yield* fail("Vercel could not complete the request.");
      let size = 0;
      const decoder = new TextDecoder();
      const chunks = yield* response.stream.pipe(
        Stream.mapEffect((chunk) => {
          size += chunk.length;
          return size > 2_000_000
            ? fail("Vercel response exceeded the preview limit.")
            : Effect.succeed(decoder.decode(chunk, { stream: true }));
        }),
        Stream.runCollect,
      );
      return yield* decodeJson(chunks.join("") + decoder.decode());
    },
    Effect.timeout("20 seconds"),
    Effect.mapError((error) =>
      isError(error) ? error : fail("Could not read Vercel. Check the connection and try again."),
    ),
  );
  const project = (credentials: VercelCredentials, id: string) =>
    read(credentials, `/v9/projects/${encodeURIComponent(id)}`).pipe(
      Effect.flatMap(decodeProject),
      Effect.mapError((error) =>
        isError(error) ? error : fail("Vercel returned an invalid project."),
      ),
    );
  const deployments = Effect.fn("VercelAdapter.deployments")(function* (
    credentials: VercelCredentials,
    projectId: string,
    branch: string | null,
  ) {
    const response = yield* read(credentials, "/v7/deployments", {
      projectId,
      limit: "20",
      ...(branch ? { branch } : {}),
    }).pipe(
      Effect.flatMap(decodeDeployments),
      Effect.mapError((error) =>
        isError(error) ? error : fail("Vercel returned invalid deployments."),
      ),
    );
    return response.deployments
      .slice(0, 20)
      .map((deployment): VercelDeployment => ({
        id: deployment.uid,
        name: deployment.name,
        state: deployment.readyState ?? deployment.state ?? "UNKNOWN",
        url:
          deployment.url && /^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(deployment.url)
            ? `https://${deployment.url}`
            : null,
        createdAt: deployment.created,
        target: deployment.target ?? null,
        commit:
          typeof deployment.meta?.githubCommitSha === "string"
            ? deployment.meta.githubCommitSha
            : typeof deployment.meta?.gitlabCommitSha === "string"
              ? deployment.meta.gitlabCommitSha
              : typeof deployment.meta?.bitbucketCommitSha === "string"
                ? deployment.meta.bitbucketCommitSha
                : null,
      }))
      .sort((a, b) => b.createdAt - a.createdAt);
  });
  const logs = Effect.fn("VercelAdapter.logs")(function* (
    credentials: VercelCredentials,
    deploymentId: string,
  ) {
    const rows = yield* read(
      credentials,
      `/v3/deployments/${encodeURIComponent(deploymentId)}/events`,
      {
        builds: "1",
        follow: "0",
        direction: "backward",
        limit: "200",
      },
    ).pipe(
      Effect.flatMap(decodeLogs),
      Effect.mapError((error) =>
        isError(error) ? error : fail("Vercel returned invalid build logs."),
      ),
    );
    const text = (rows ?? [])
      .slice(0, 200)
      .sort((a, b) => a.created - b.created)
      .map((event) => event.payload.text ?? "")
      .filter(Boolean)
      .join("\n");
    return {
      text: text.slice(-64_000),
      truncated: (rows?.length ?? 0) >= 200 || text.length > 64_000,
    };
  });
  const projects = Effect.fn("VercelAdapter.projects")(function* (
    credentials: VercelCredentials,
    search: string,
  ) {
    const result = yield* read(credentials, "/v10/projects", {
      limit: "20",
      ...(search ? { search } : {}),
    }).pipe(
      Effect.flatMap(decodeProjects),
      Effect.mapError((error) =>
        isError(error) ? error : fail("Vercel returned invalid projects."),
      ),
    );
    return ("projects" in result ? result.projects : result).slice(0, 20);
  });
  return { project, projects, deployments, logs };
});
export class VercelAdapter extends Context.Service<VercelAdapter, Effect.Success<typeof make>>()(
  "t3/integrations/vercel/VercelAdapter",
) {}
