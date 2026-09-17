import { useState } from "react";
import { FolderIcon, ArrowUpIcon } from "lucide-react";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  ensureBrowseDirectoryPath,
  getBrowseParentPath,
} from "@t3tools/client-runtime/state/projects";
import { useEnvironment } from "../../state/environments";
import { filesystemEnvironment } from "../../state/filesystem";
import { useEnvironmentQuery } from "../../state/query";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";

export function RepositoryFolderPicker({
  environmentId,
  value,
  disabled,
  onSelect,
}: {
  environmentId: EnvironmentId;
  value: string;
  disabled?: boolean;
  onSelect: (path: string) => void;
}) {
  const environment = useEnvironment(environmentId);
  const [open, setOpen] = useState(false);
  const [hideHidden, setHideHidden] = useState(true);
  const [picking, setPicking] = useState(false);
  const [path, setPath] = useState("~/");
  const [location, setLocation] = useState("~/");
  const folders = useEnvironmentQuery(
    open
      ? filesystemEnvironment.browse({
          environmentId,
          input: { partialPath: ensureBrowseDirectoryPath(path) },
        })
      : null,
  );
  const navigate = (next: string) => {
    setPath(next);
    setLocation(next);
  };
  const choose = async () => {
    if (picking || disabled) return;
    setPicking(true);
    try {
      const bridge = window.desktopBridge;
      // A native selection is only meaningful for this desktop's own backend.
      // WSL and remote environments use the server picker to keep paths on the right machine.
      const local = environment?.displayUrl
        ? bridge
            ?.getLocalEnvironmentBootstraps()
            .find((entry) => entry.httpBaseUrl === environment.displayUrl)
        : undefined;
      const native =
        local &&
        !local.runningDistro &&
        !local.id.startsWith("wsl:") &&
        !(
          navigator.platform.startsWith("Win") &&
          environment?.serverConfig?.environment.platform.os === "linux"
        );
      if (bridge && native) {
        const selected = await bridge.pickFolder({
          targetEnvironmentId: local.id,
          ...(value ? { initialPath: value } : {}),
        });
        if (selected) onSelect(selected);
        return;
      }
    } catch {
      // The server picker also works when the desktop dialog is unavailable.
    } finally {
      setPicking(false);
    }
    navigate(value || "~/");
    setOpen(true);
  };
  const current = folders.data;
  const entries = (current?.entries ?? []).filter(
    (entry) => !hideHidden || !entry.name.startsWith("."),
  );
  const parent = current
    ? getBrowseParentPath(ensureBrowseDirectoryPath(current.parentPath))
    : null;
  return (
    <>
      <div className="flex items-center gap-3 rounded-lg border p-3">
        <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
        <p className="min-w-0 flex-1 break-all text-sm text-muted-foreground">
          {value || "No folder selected"}
        </p>
        <Button
          type="button"
          variant="outline"
          disabled={disabled || picking}
          onClick={() => void choose()}
        >
          {picking ? "Opening…" : value ? "Change folder" : "Choose folder"}
        </Button>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Select repository folder</DialogTitle>
            <DialogDescription>
              Choose the cloned repository on {environment?.label ?? "the connected server"}.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="grid gap-3">
            <div className="flex gap-2">
              <Input
                aria-label="Folder location"
                value={location}
                onChange={(event) => setLocation(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    if (location.trim()) navigate(location.trim());
                  }
                }}
              />
              <Button
                type="button"
                variant="outline"
                disabled={!location.trim()}
                onClick={() => navigate(location.trim())}
              >
                Go
              </Button>
            </div>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!parent || folders.isPending}
                onClick={() => {
                  if (parent) navigate(parent);
                }}
              >
                <ArrowUpIcon className="size-4" />
                Up
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={() => navigate("~/")}>
                Home
              </Button>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={hideHidden} onCheckedChange={setHideHidden} />
              Hide hidden files and folders
            </label>
            {folders.isPending && (
              <p role="status" className="text-sm text-muted-foreground">
                Loading folders…
              </p>
            )}
            {folders.error && (
              <p role="alert" className="text-sm text-destructive">
                {folders.error}
              </p>
            )}
            {current && !folders.error && (
              <>
                <p className="break-all text-xs text-muted-foreground">{current.parentPath}</p>
                <div
                  className="grid max-h-64 min-h-32 content-start gap-1 overflow-y-auto rounded-lg border p-1"
                  aria-label="Folders"
                >
                  {entries.map((entry) => (
                    <Button
                      type="button"
                      key={entry.fullPath}
                      variant="ghost"
                      className="justify-start"
                      disabled={folders.isPending}
                      onClick={() => navigate(entry.fullPath)}
                    >
                      <FolderIcon className="size-4 shrink-0" />
                      <span className="truncate">{entry.name}</span>
                    </Button>
                  ))}
                  {!entries.length && (
                    <p className="p-3 text-sm text-muted-foreground">No visible subfolders.</p>
                  )}
                </div>
              </>
            )}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={disabled || folders.isPending || !folders.isSuccess || !current}
              onClick={() => {
                if (current) {
                  onSelect(current.parentPath);
                  setOpen(false);
                }
              }}
            >
              Select folder
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
