import {
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthRelayReadScope,
  AuthRelayWriteScope,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { RPC_REQUIRED_SCOPES, requiredScopeForRpcMethod } from "./RpcAuthorization.ts";

describe("RPC authorization scopes", () => {
  it("declares exactly one scope for every RPC in the server group", () => {
    expect(new Set(Object.keys(RPC_REQUIRED_SCOPES))).toEqual(new Set(WsRpcGroup.requests.keys()));
  });

  it("separates Slack inbox access, task operations and administrator-owned credentials", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.slackAdmin)).toBe(AuthAccessWriteScope);
    expect(requiredScopeForRpcMethod(WS_METHODS.slackMutate)).toBe(AuthOrchestrationOperateScope);
    for (const method of [WS_METHODS.slackGet, WS_METHODS.slackList, WS_METHODS.slackSubscribe])
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationReadScope);
  });

  it("allows read-only clients to inspect WorkItem activity", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.workAutomationsControl)).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.workAutomationsList)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.workAutomationsSubscribe)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.workAutomationsMutate)).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.workDashboardList)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.workDashboardSubscribe)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.workActivityList)).toBe(AuthOrchestrationReadScope);
    expect(requiredScopeForRpcMethod(WS_METHODS.workActivitySubscribe)).toBe(
      AuthOrchestrationReadScope,
    );
  });

  it("authorizes background policy reporting and observation deliberately", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.serverReportClientActivity)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverReportHostPowerState)).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverGetBackgroundPolicy)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.subscribeBackgroundPolicy)).toBe(
      AuthOrchestrationReadScope,
    );
  });

  it("allows relay status reads without granting relay installation access", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.cloudGetRelayClientStatus)).toBe(
      AuthRelayReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.cloudInstallRelayClient)).toBe(AuthRelayWriteScope);
  });

  it("requires permission to operate on a thread before uploading feedback", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.providerUploadFeedback)).toBe(
      AuthOrchestrationOperateScope,
    );
  });

  it("requires write access to import agent session history", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.agentSessionsScan)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.agentSessionsImport)).toBe(
      AuthOrchestrationOperateScope,
    );
  });

  it("reads the reviewer menu under the same scope as the pull request it belongs to", () => {
    // The candidate list is a read like the detail beside it, and asking somebody for a review is
    // a write like every other pull request operation.
    expect(requiredScopeForRpcMethod(WS_METHODS.pullRequestsReviewerCandidates)).toBe(
      requiredScopeForRpcMethod(WS_METHODS.pullRequestsDetail),
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.pullRequestsRequestReviewers)).toBe(
      requiredScopeForRpcMethod(WS_METHODS.pullRequestsComment),
    );
  });

  it("rejects unknown RPC method names", () => {
    for (const method of ["server.notRegistered", "toString", "constructor"]) {
      expect(() => requiredScopeForRpcMethod(method)).toThrow(
        `RPC method ${method} has no declared authorization scope.`,
      );
    }
  });
});
