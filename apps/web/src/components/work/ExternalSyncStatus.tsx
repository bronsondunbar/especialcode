export function ExternalSyncStatus({
  value,
}: {
  value: { syncStatus?: string; syncError?: string | null; lastSyncedAt?: string | null };
}) {
  if (!value.syncStatus && !value.syncError) return null;
  return (
    <div className="grid gap-1 text-xs text-muted-foreground">
      <span>
        {value.syncStatus === "ready"
          ? "Synced"
          : value.syncStatus === "partial"
            ? "Partially synced"
            : "Cached copy"}
        {value.lastSyncedAt
          ? ` · Last success ${new Date(value.lastSyncedAt).toLocaleString()}`
          : " · No successful refresh recorded"}
      </span>
      {value.syncError && <p className="text-destructive">{value.syncError}</p>}
    </div>
  );
}
