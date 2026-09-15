import type { AutomationExecutionPolicy, ServerProvider } from "@t3tools/contracts";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
export function AutomationExecutionPolicyEditor({
  value,
  onChange,
  providers,
}: {
  value: AutomationExecutionPolicy;
  onChange: (value: AutomationExecutionPolicy) => void;
  providers: ReadonlyArray<ServerProvider>;
}) {
  return (
    <fieldset className="grid gap-3 rounded-lg border p-4">
      <legend className="px-2 font-semibold">Execution safeguards</legend>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={value.trusted}
          onChange={(e) => onChange({ ...value, trusted: e.target.checked })}
        />
        Trust this rule to execute explicitly approved plans
      </label>
      <label className="grid gap-1 text-sm">
        Allowed repositories (one host/owner/repository per line)
        <Textarea
          defaultValue={value.allowedRepositories
            .map((r) => `${r.host}/${r.repository}`)
            .join("\n")}
          placeholder="github.com/owner/repository"
          onChange={(e) =>
            onChange({
              ...value,
              allowedRepositories: e.target.value
                .split("\n")
                .map((s) => s.trim())
                .filter(Boolean)
                .map((s) => {
                  const [host, ...parts] = s.split("/");
                  return { host: host ?? "", repository: parts.join("/") };
                }),
            })
          }
        />
      </label>
      <label className="grid gap-1 text-sm">
        Allowed issue labels (one per line; at least one must match)
        <Textarea
          defaultValue={value.allowedLabels.join("\n")}
          onChange={(e) =>
            onChange({
              ...value,
              allowedLabels: e.target.value
                .split("\n")
                .map((s) => s.trim())
                .filter(Boolean),
            })
          }
        />
      </label>
      <div className="grid gap-2">
        <span className="text-sm font-medium">Allowed providers</span>
        {providers.map((p) => (
          <label key={p.instanceId} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={value.allowedProviders.includes(p.instanceId)}
              onChange={(e) =>
                onChange({
                  ...value,
                  allowedProviders: e.target.checked
                    ? [...value.allowedProviders, p.instanceId]
                    : value.allowedProviders.filter((id) => id !== p.instanceId),
                })
              }
            />
            {p.displayName ?? p.driver}
          </label>
        ))}
      </div>
      <label className="grid gap-1 text-sm">
        Maximum simultaneous executions for this rule
        <Input
          type="number"
          min={1}
          max={10}
          value={value.maxConcurrentRuns}
          onChange={(e) => onChange({ ...value, maxConcurrentRuns: Number(e.target.value) })}
        />
      </label>
      <label className="grid gap-1 text-sm">
        Permission mode
        <select
          className="h-9 rounded-lg border border-input bg-background px-2"
          value={value.permissionMode}
          onChange={(e) => {
            const mode = e.target.value;
            if (mode === "approval-required" || mode === "auto-accept-edits")
              onChange({ ...value, permissionMode: mode });
          }}
        >
          <option value="approval-required">Approval required</option>
          <option value="auto-accept-edits">Accept edits; keep other approvals</option>
        </select>
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={value.requireTests}
          onChange={(e) => onChange({ ...value, requireTests: e.target.checked })}
        />
        Require validation commands
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={value.requirePullRequest}
          onChange={(e) => onChange({ ...value, requirePullRequest: e.target.checked })}
        />
        Create a PR after successful execution
      </label>
      <p className="text-xs text-muted-foreground">
        The server checks current synced labels and the checkout’s origin. T3 Code and provider
        approvals remain in force. PRs are never merged automatically.
      </p>
    </fieldset>
  );
}
