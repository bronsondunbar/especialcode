import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/unstable/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";
export function createVercelAtoms<R, E>(runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>) {
  return {
    sidebarConfiguration: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "vercel:sidebar-configuration",
      tag: WS_METHODS.vercelRead,
      staleTimeMs: 0,
      idleTtlMs: 0,
      refreshIntervalMs: 15_000,
    }),
    projects: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "vercel:projects",
      tag: WS_METHODS.vercelProjects,
      staleTimeMs: 0,
      idleTtlMs: 0,
    }),
    configuration: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "vercel:configuration",
      tag: WS_METHODS.vercelRead,
      staleTimeMs: 0,
      idleTtlMs: 0,
    }),
    read: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "vercel:read",
      tag: WS_METHODS.vercelRead,
      staleTimeMs: 0,
      idleTtlMs: 0,
      refreshIntervalMs: 15_000,
    }),
    admin: createEnvironmentRpcCommand(runtime, {
      label: "vercel:admin",
      tag: WS_METHODS.vercelAdmin,
    }),
    link: createEnvironmentRpcCommand(runtime, {
      label: "vercel:link",
      tag: WS_METHODS.vercelLink,
    }),
  };
}
