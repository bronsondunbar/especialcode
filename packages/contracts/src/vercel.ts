import * as Schema from "effect/Schema";
import { ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
const Identifier = TrimmedNonEmptyString.check(
  Schema.isMaxLength(200),
  Schema.isPattern(/^[a-zA-Z0-9_-]+$/),
);
const Branch = TrimmedNonEmptyString.check(Schema.isMaxLength(500));
export const VercelThreadSelection = Schema.Struct({ project: Schema.NullOr(Identifier) });
export type VercelThreadSelection = typeof VercelThreadSelection.Type;
export const VercelProject = Schema.Struct({ id: Identifier, name: Schema.String });
export type VercelProject = typeof VercelProject.Type;
export const VercelConnection = Schema.Struct({
  teamId: Schema.NullOr(Identifier),
});
export type VercelConnection = typeof VercelConnection.Type;
export const VercelProjectsInput = Schema.Struct({
  search: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
});
export const VercelProjectsResult = Schema.Struct({
  connection: Schema.NullOr(VercelConnection),
  projects: Schema.Array(VercelProject),
});
export const VercelThreadLink = Schema.Struct({
  project: VercelProject,
  branch: Schema.NullOr(Branch),
});
export type VercelThreadLink = typeof VercelThreadLink.Type;
export const VercelReadInput = Schema.Struct({
  projectId: Schema.optionalKey(ProjectId),
  threadId: Schema.optionalKey(ThreadId),
  deploymentId: Schema.optionalKey(Identifier),
  includeLogs: Schema.optionalKey(Schema.Boolean),
  configurationOnly: Schema.optionalKey(Schema.Boolean),
});
export type VercelReadInput = typeof VercelReadInput.Type;
export const VercelAdminInput = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("connect"),
    teamId: Schema.NullOr(Identifier),
    token: Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(2000),
      Schema.isPattern(/^\S+$/),
    ),
  }),
  Schema.Struct({ kind: Schema.Literal("disconnect") }),
]);
export type VercelAdminInput = typeof VercelAdminInput.Type;
export const VercelLinkInput = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("link"),
    projectId: ProjectId,
    threadId: ThreadId,
    vercelProject: Identifier,
    branch: Schema.NullOr(Branch),
  }),
  Schema.Struct({
    kind: Schema.Literal("unlink"),
    projectId: ProjectId,
    threadId: ThreadId,
  }),
]);
export type VercelLinkInput = typeof VercelLinkInput.Type;
export const VercelDeployment = Schema.Struct({
  id: Identifier,
  name: Schema.String,
  state: Schema.String,
  url: Schema.NullOr(Schema.String),
  createdAt: Schema.Finite,
  target: Schema.NullOr(Schema.String),
  commit: Schema.NullOr(Schema.String),
});
export type VercelDeployment = typeof VercelDeployment.Type;
export const VercelSnapshot = Schema.Struct({
  connection: Schema.NullOr(VercelConnection),
  link: Schema.NullOr(VercelThreadLink),
  deployments: Schema.Array(VercelDeployment),
  selectedDeploymentId: Schema.NullOr(Identifier),
  logs: Schema.String,
  logsTruncated: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
  logsError: Schema.NullOr(Schema.String),
  checkedAt: Schema.NullOr(Schema.String),
});
export type VercelSnapshot = typeof VercelSnapshot.Type;
export class VercelError extends Schema.TaggedError<VercelError>()("VercelError", {
  message: Schema.String,
}) {}
