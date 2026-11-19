import { Group, Modal, ScrollArea, SimpleGrid, Stack, Text, Title } from "@mantine/core";
import { IconArrowLeft, IconArrowRight, IconCopy, IconDeviceFloppy, IconEdit, IconKeyboard, IconLayoutSidebarLeftCollapse, IconListTree, IconPlayerPlay, IconSend, IconTrash, IconX } from "@tabler/icons-react";
import { IconButton } from '../ui';
import { useAppHotkeyList } from "@tanstack/react-hotkeys";
import type { ComponentProps, ComponentType } from "react";
import { shortcutAccessibleLabel, shortcutParts } from "./appHotkeys";

const GROUPS = ["COURSE RUNNER", "FILE NAVIGATION", "PANELS", "EDITOR"] as const;
const ICONS: Record<string, ComponentType<ComponentProps<typeof IconKeyboard>>> = {
  Save: IconDeviceFloppy,
  "Run tests": IconPlayerPlay,
  "Submit solution": IconSend,
  "Previous file": IconArrowLeft,
  "Next file": IconArrowRight,
  "Toggle library": IconLayoutSidebarLeftCollapse,
  "Toggle course chapters": IconListTree,
  "Keyboard shortcuts": IconKeyboard,
  "Delete line": IconTrash,
  "Duplicate line": IconCopy,
  "Rename symbol": IconEdit,
};

export function Keycaps({ bindings, label }: { bindings: string[][][]; label: string }) {
  const ariaLabel = bindings.map(shortcutAccessibleLabel).join(", or ");
  return <span aria-label={`${label}: ${ariaLabel}`} style={{ display: "inline-flex", alignItems: "center", justifyContent: "flex-end", gap: 4, flexWrap: "wrap" }}>{bindings.map((steps, bindingIndex) => <span key={bindingIndex} style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>{bindingIndex > 0 && <Text component="span" c="dimmed" size="xs">,</Text>}{steps.map((parts, stepIndex) => <span key={stepIndex} style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>{stepIndex > 0 && <Text component="span" c="dimmed" size="xs">,</Text>}{parts.map((part, partIndex) => <span key={`${part}-${partIndex}`} style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>{partIndex > 0 && <Text component="span" c="dimmed" size="xs">+</Text>}<Text component="kbd" ff="monospace" fw={600} size="xs" h="1.5rem" px={6} style={{ display: "inline-flex", alignItems: "center", border: "1px solid var(--ir-color-control-border)", borderRadius: "var(--ir-radius-sm)", background: "var(--ir-color-raised)", color: "var(--ir-color-text)", whiteSpace: "nowrap" }}>{part}</Text></span>)}</span>)}</span>)}</span>;
}

export default function KeyboardShortcutsModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const list = useAppHotkeyList();
  const rows = list.reduce<Array<{ group: string; name: string; bindings: string[][][] }>>((result, { appHotkey }) => {
    const group = appHotkey.meta?.group; const name = appHotkey.meta?.name;
    if (!group || !name || !appHotkey.hotkey) return result;
    const existing = result.find((row) => row.group === group && row.name === name);
    const binding = shortcutParts(appHotkey.hotkey);
    if (existing) existing.bindings.push(binding); else result.push({ group, name, bindings: [binding] });
    return result;
  }, []);
  return <Modal.Root opened={opened} onClose={onClose} size="lg" centered trapFocus returnFocus closeOnEscape scrollAreaComponent={ScrollArea.Autosize} styles={{ content: { maxHeight: "calc(100dvh - 2rem)" }, body: { paddingBottom: "var(--mantine-spacing-lg)" } }}><Modal.Overlay /><Modal.Content><Modal.Header role="presentation"><Modal.Title><Group gap="xs" wrap="nowrap"><IconKeyboard aria-hidden="true" size={20} /><Text component="span" fw={600}>Keyboard Shortcuts</Text></Group></Modal.Title><IconButton variant="subtle" label="Close keyboard shortcuts" icon={<IconX size={20} aria-hidden="true" />} tooltipWithinPortal={false} onClick={onClose} /></Modal.Header><Modal.Body>
    <Text id="keyboard-shortcuts-description" size="sm" mb="lg">Use these keyboard shortcuts to navigate and work efficiently.</Text>
    <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="xl" verticalSpacing="xl">{GROUPS.map((group) => <section key={group} aria-labelledby={`shortcut-group-${group.replaceAll(" ", "-").toLowerCase()}`}><Title id={`shortcut-group-${group.replaceAll(" ", "-").toLowerCase()}`} order={3} size="xs" fw={700} mb="sm" style={{ letterSpacing: "0.06em" }}>{group}</Title><Stack component="ul" gap="sm" m={0} p={0} style={{ listStyle: "none" }}>{rows.filter((row) => row.group === group).map((row) => { const Icon = ICONS[row.name] ?? IconKeyboard; return <li key={row.name} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", alignItems: "center", gap: "var(--mantine-spacing-sm)" }}><Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}><Icon aria-hidden="true" size={16} /><Text size="sm">{row.name}</Text></Group><Keycaps label={row.name} bindings={row.bindings} /></li>; })}</Stack></section>)}</SimpleGrid>
  </Modal.Body></Modal.Content></Modal.Root>;
}
