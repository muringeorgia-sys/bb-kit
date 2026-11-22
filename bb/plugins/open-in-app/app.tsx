// Open In App — panel file tab for .pptx/.pdf/office files: opens the file in
// the default Windows app on first view and offers a button to open it again.
import { useEffect, useState } from "react";
import { definePluginApp, useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginFileOpenerProps } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";

const EXTENSIONS = ["pptx", "ppt", "pdf", "docx", "doc", "xlsx", "xls"];
// Auto-open once per file per app session, so switching tabs does not reopen it.
const autoOpened = new Set<string>();

type State = { kind: "idle" | "opening" | "done" | "error"; text?: string };

function OpenInApp({ path, source }: PluginFileOpenerProps) {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<State>({ kind: "idle" });
  const name = path.split(/[\\/]/).pop() ?? path;
  const key = `${source.kind}:${source.environmentId ?? source.threadId ?? ""}:${path}`;

  const open = () => {
    setState({ kind: "opening" });
    rpc.call("open_file", { path, source }).then(
      () => setState({ kind: "done" }),
      (e: unknown) => setState({ kind: "error", text: e instanceof Error ? e.message : String(e) }),
    );
  };

  useEffect(() => {
    if (autoOpened.has(key)) return;
    autoOpened.add(key);
    open();
  }, [key]);

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <Icon name="FileText" className="size-8 text-muted-foreground" />
      <div className="break-all text-sm font-medium">{name}</div>
      <Button onClick={open} disabled={state.kind === "opening"}>
        <Icon name="ExternalLink" className="size-4" />
        Открыть в приложении
      </Button>
      {state.kind === "done" ? (
        <p className="text-xs text-muted-foreground">Открыто в приложении по умолчанию</p>
      ) : null}
      {state.kind === "error" ? (
        <p role="alert" className="text-xs text-destructive">{state.text}</p>
      ) : null}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.fileOpener({
    id: "open-in-app",
    title: "Открыть в приложении",
    extensions: EXTENSIONS,
    component: OpenInApp,
  });
});
