import { Group, Progress, Stack, Text } from "@mantine/core";
import { Button, Panel } from "../ui";
import { IconBulb, IconEye, IconEyeOff, IconLock } from "@tabler/icons-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { type KeyboardEvent, type PointerEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";

export type MilestoneHintContent = { title: string; approach: string; solution: string };
const HOLD_MS = 3_000;

export function HoldForHint({ title, headingId, headingLevel = 2, headingSize, hint, onUnlock, onHoldTransition, initiallyUnlocked = false, initiallyVisible = false, onVisibilityChange, allowWrap = false, renderHintText }: { title: string; headingId?: string; headingLevel?: 2 | 3 | 4 | 5 | 6; headingSize?: string; hint: MilestoneHintContent; onUnlock: (title: string) => void; onHoldTransition?: (title: string, state: "started" | "cancelled") => void; initiallyUnlocked?: boolean; initiallyVisible?: boolean; onVisibilityChange?: (title: string, visible: boolean) => void; allowWrap?: boolean; renderHintText?: (source: string) => ReactNode }) {
  const [unlocked, setUnlocked] = useState(initiallyUnlocked); const [visible, setVisible] = useState(initiallyUnlocked && initiallyVisible); const [holding, setHolding] = useState(false); const [progress, setProgress] = useState(initiallyUnlocked ? 100 : 0);
  const startedAt = useRef(0); const timeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined); const interval = useRef<ReturnType<typeof setInterval> | undefined>(undefined); const holdingRef = useRef(false); const completedHold = useRef(false);
  useEffect(() => { if (initiallyUnlocked) { setUnlocked(true); setProgress(100); setVisible(initiallyVisible); } }, [initiallyUnlocked, initiallyVisible]);
  const cancel = useCallback((announce = true) => { const wasHolding = holdingRef.current; if (timeout.current) clearTimeout(timeout.current); if (interval.current) clearInterval(interval.current); timeout.current = undefined; interval.current = undefined; holdingRef.current = false; setHolding(false); setProgress(0); if (wasHolding && announce) onHoldTransition?.(title, "cancelled"); }, [onHoldTransition, title]);
  const finish = useCallback(() => { if (!holdingRef.current) return; if (interval.current) clearInterval(interval.current); timeout.current = undefined; interval.current = undefined; holdingRef.current = false; completedHold.current = true; setHolding(false); setProgress(100); setUnlocked(true); setVisible(true); onUnlock(title); onVisibilityChange?.(title, true); }, [onUnlock, onVisibilityChange, title]);
  const start = useCallback(() => { if (unlocked || holdingRef.current) return; holdingRef.current = true; startedAt.current = Date.now(); setHolding(true); setProgress(0); onHoldTransition?.(title, "started"); interval.current = setInterval(() => setProgress(Math.min(99, (Date.now() - startedAt.current) / HOLD_MS * 100)), 50); timeout.current = setTimeout(finish, HOLD_MS); }, [finish, onHoldTransition, title, unlocked]);
  useEffect(() => { const blur = () => cancel(); window.addEventListener("blur", blur); return () => { window.removeEventListener("blur", blur); cancel(false); }; }, [cancel]);
  const keyDown = (event: KeyboardEvent<HTMLButtonElement>) => { if (event.key !== " " && event.key !== "Enter") return; if (unlocked) { completedHold.current = false; return; } event.preventDefault(); if (!event.repeat) start(); };
  const keyUp = (event: KeyboardEvent<HTMLButtonElement>) => { if (!unlocked && (event.key === " " || event.key === "Enter")) { event.preventDefault(); cancel(); } };
  const pointerDown = (event: PointerEvent<HTMLButtonElement>) => { if (!event.isPrimary || event.button !== 0) return; if (unlocked) { completedHold.current = false; return; } event.preventDefault(); start(); };
  const buttonLabel = unlocked ? visible ? `Hide hint for ${title}` : `Show hint for ${title}` : `Hold 3s for hint · ${title} (hold for 3 seconds)`;
  return <>
    <Group justify="space-between" align="center" wrap={allowWrap ? "wrap" : "nowrap"} gap="sm">
      <Text component={`h${headingLevel}` as "h2" | "h3" | "h4" | "h5" | "h6"} id={headingId} size={headingSize} fw={700} style={{ minWidth: 0 }}>{title}</Text>
      <Button variant="secondary" leftSection={unlocked ? visible ? <IconEyeOff size={16} /> : <IconEye size={16} /> : <IconLock size={16} />} style={{ touchAction: "none" }} aria-label={buttonLabel} onContextMenu={(event) => event.preventDefault()} onPointerDown={pointerDown} onPointerUp={() => { if (!unlocked) cancel(); }} onPointerLeave={() => { if (!unlocked) cancel(); }} onPointerCancel={() => { if (!unlocked) cancel(); }} onLostPointerCapture={() => { if (!unlocked) cancel(); }} onKeyDown={keyDown} onKeyUp={keyUp} onBlur={() => { if (!unlocked) cancel(); }} onClick={(event) => { if (completedHold.current) { completedHold.current = false; event.preventDefault(); return; } if (!unlocked) { event.preventDefault(); return; } setVisible((current) => { const next = !current; onVisibilityChange?.(title, next); return next; }); }} aria-expanded={unlocked ? visible : false}>{unlocked ? visible ? "Hide hint" : "Show hint" : "Hold 3s for hint"}</Button>
    </Group>
    {holding && <Stack gap={4} mt={4} mb="xs" aria-label={`Hint lock for ${title}`}><Progress value={progress} aria-label={`Hold progress for ${title}`} /><Text size="xs" c="dimmed">{`Keep holding… ${Math.max(0, (HOLD_MS - (Date.now() - startedAt.current)) / 1_000).toFixed(1)}s`}</Text></Stack>}
    {unlocked && visible && <Panel label={`Hint for ${title}`} padding="sm" style={{ marginTop: 'var(--mantine-spacing-xs)', marginBottom: 'var(--mantine-spacing-sm)' }}><Stack gap="sm"><div><Group gap="xs"><IconBulb size={17} aria-hidden="true" /><Text fw={700}>Approach</Text></Group>{renderHintText ? renderHintText(hint.approach) : <Text size="sm">{hint.approach}</Text>}</div><div><Text fw={700}>Solution</Text>{renderHintText ? renderHintText(hint.solution) : <Markdown remarkPlugins={[remarkGfm]}>{hint.solution}</Markdown>}</div></Stack></Panel>}
  </>;
}
