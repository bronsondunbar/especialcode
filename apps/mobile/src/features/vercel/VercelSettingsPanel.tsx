import type { EnvironmentId } from "@t3tools/contracts";
import { VercelPanel } from "./VercelButton";
export function VercelSettingsPanel({ environmentId }: { environmentId: EnvironmentId }) {
  return (
    <VercelPanel
      key={environmentId}
      environmentId={environmentId}
      settings
      onClose={() => undefined}
    />
  );
}
