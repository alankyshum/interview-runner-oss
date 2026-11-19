import { Alert, Group, Loader, Stack, Text } from "@mantine/core";
import { Button } from "../ui";
import { useAppHotkeys } from "@tanstack/react-hotkeys";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { matchesSandboxForwardedHotkey, SANDBOX_HOTKEY_EVENT, sandboxForwardedHotkeys } from "./appHotkeys";

export type SandboxFrameHandle = { focus(): void };

const SandboxFrame = forwardRef<SandboxFrameHandle, {
  url: string;
  onRetry: () => void;
}>(({ url, onRetry }, forwardedRef) => {
  const iframe = useRef<HTMLIFrameElement>(null);
  const [state, setState] = useState<"starting" | "ready" | "failed">("starting");
  const hotkeys = useAppHotkeys();
  useImperativeHandle(forwardedRef, () => ({ focus: () => iframe.current?.contentWindow?.focus() }));

  useEffect(() => { setState("starting"); }, [url]);
  useEffect(() => {
    if (state !== "starting") return;
    const timeout = window.setTimeout(() => setState("failed"), 30_000);
    return () => window.clearTimeout(timeout);
  }, [state, url]);
  useEffect(() => {
    const frame = iframe.current;
    if (!frame || state !== "ready") return;
    let target: Window;
    try { target = frame.contentWindow!; void target.location.href; }
    catch { return; }
    const keydown = (event: KeyboardEvent) => {
      const matched = sandboxForwardedHotkeys(hotkeys).find((hotkey) => matchesSandboxForwardedHotkey(event, hotkey));
      if (!matched) return;
      event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
      window.dispatchEvent(new CustomEvent(SANDBOX_HOTKEY_EVENT, { detail: { id: matched.id } }));
    };
    target.addEventListener("keydown", keydown, true);
    return () => target.removeEventListener("keydown", keydown, true);
  }, [state, url, hotkeys]);

  return <div style={{ position: "relative", height: "100%", minHeight: 0 }}>
    <iframe ref={iframe} title="Sandbox editor" src={url} onLoad={() => setState("ready")} onError={() => setState("failed")} style={{ width: "100%", height: "100%", border: 0, visibility: state === "ready" ? "visible" : "hidden" }} />
    {state !== "ready" && <Group justify="center" align="center" style={{ position: "absolute", inset: 0 }}>
      {state === "starting" ? <Stack align="center" gap="xs"><Loader aria-hidden="true" /><Text>Starting sandbox…</Text></Stack> : <Alert color="red" title="Sandbox failed"><Stack gap="sm"><Text>The editor could not be loaded.</Text><Button onClick={onRetry}>Retry</Button></Stack></Alert>}
    </Group>}
  </div>;
});

SandboxFrame.displayName = "SandboxFrame";
export default SandboxFrame;
