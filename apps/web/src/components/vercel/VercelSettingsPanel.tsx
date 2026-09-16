import { useState } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import { VercelPanel } from "./VercelPanel";
export function VercelSettingsPanel({ environmentId }: { environmentId: EnvironmentId }) {
  const [pending, setPending] = useState(false);
  return (
    <section className="flex-1 overflow-auto p-6">
      <div className="mx-auto grid max-w-3xl gap-4">
        <h2 className="text-xl font-semibold">Vercel</h2>
        <VercelPanel
          key={environmentId}
          environmentId={environmentId}
          settings
          pending={pending}
          setPending={setPending}
        />
      </div>
    </section>
  );
}
