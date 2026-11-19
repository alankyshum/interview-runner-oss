import { Modal, Text } from "@mantine/core";
import { Spotlight, createSpotlight, useSpotlight, type SpotlightActionData } from "@mantine/spotlight";
import { IconBook, IconFileText, IconFolder, IconSearch } from "@tabler/icons-react";
import { useAppHotkeys, useHotkey } from "@tanstack/react-hotkeys";
import { useId, useReducer, useState, type ReactNode } from "react";
import { Keycaps } from "./KeyboardShortcutsModal";
import { shortcutAccessibleLabel, shortcutParts, type AppHotkeyId } from "./appHotkeys";
import type { LibraryCategory, LibraryItem } from "./LibraryPanel";
import { matchesSearchWords, normalizeSearchText, searchWords } from "./textSearch";
import classes from "./CommandPalette.module.css";

export type MenuCommand = { id: string; label: string; icon: ReactNode; onClick: () => void; hotkey?: AppHotkeyId };
type MatchField = { kind: "category" | "tag" | "repository" | "company" | "role"; value: string };
type SearchableAction = { action: SpotlightActionData; category?: string; tags?: string[]; other?: MatchField[] };

const normalized = normalizeSearchText;
const fuzzyMatch = (text: string, query: string) => {
  if (!/^[\p{L}\p{N}]{3,}$/u.test(query)) return false;
  const wanted = [...query]; const characters = [...text];
  const maxSpan = wanted.length + Math.max(2, Math.ceil(wanted.length / 2));
  for (let start = 0; start < characters.length; start++) {
    if (characters[start] !== wanted[0]) continue;
    let position = 1;
    for (let index = start + 1; index < characters.length && index - start < maxSpan; index++) {
      if (characters[index] === wanted[position]) position++;
      if (position === wanted.length) return true;
    }
  }
  return false;
};
const wordStartMatch = (text: string, query: string) => {
  let position = text.indexOf(query);
  while (position >= 0) {
    if (position === 0 || !/[\p{L}\p{N}]/u.test(text[position - 1])) return true;
    position = text.indexOf(query, position + 1);
  }
  return false;
};
const matchExcerpt = (field: MatchField, query: string) => {
  const value = field.value.replace(/\s+/g, " ").trim();
  if (field.kind !== "role" || value.length <= 100) return value;
  const text = normalized(value);
  const matchAt = text.indexOf(query) >= 0 ? text.indexOf(query) : searchWords(query).map((word) => text.indexOf(word)).find((index) => index >= 0) ?? -1;
  const start = Math.max(0, Math.min(matchAt < 0 ? 0 : matchAt - 30, value.length - 100));
  return `${start ? "…" : ""}${value.slice(start, start + 100)}${start + 100 < value.length ? "…" : ""}`;
};
function rankAction(candidate: SearchableAction, query: string): { score: number; reason?: MatchField } | undefined {
  if (!query) return { score: 0 };
  const title = normalized(candidate.action.label ?? "");
  if (title === query) return { score: 0 };
  if (title.startsWith(query)) return { score: 1 };
  if (wordStartMatch(title, query)) return { score: 2 };
  const words = searchWords(query);
  if (words.length > 1 && matchesSearchWords(words, [title])) return { score: 2.5 };
  const metadata: MatchField[] = [
    ...(candidate.category ? [{ kind: "category" as const, value: candidate.category }] : []),
    ...(candidate.tags ?? []).map((value) => ({ kind: "tag" as const, value })),
  ];
  const rankedMetadata = metadata.map((reason) => {
    const value = normalized(reason.value);
    return { reason, score: value === query ? 3 : value.startsWith(query) ? 4 : value.includes(query) ? 5 : Infinity };
  }).sort((a, b) => a.score - b.score)[0];
  if (rankedMetadata && Number.isFinite(rankedMetadata.score)) return rankedMetadata;
  if (title.includes(query)) return { score: 6 };
  const other = candidate.other ?? [];
  const direct = other.find((field) => normalized(field.value).includes(query));
  if (direct) return { score: 6, reason: direct };
  const fields = [...metadata, ...other];
  if (words.length > 1 && matchesSearchWords(words, [title, ...fields.map((field) => field.value)])) {
    const reason = fields.find((field) => words.some((word) => !title.includes(word) && normalized(field.value).includes(word)));
    return { score: 6, reason };
  }
  if (fuzzyMatch(title, query)) return { score: 7 };
  const fuzzy = metadata.find((field) => fuzzyMatch(normalized(field.value), query));
  return fuzzy ? { score: 7, reason: fuzzy } : undefined;
}

export default function CommandPalette({ menu, courses, cheatsheets, categories, repositories, onOpenCourse, onOpenCheatsheet, onSwitchRepo }: {
  menu: MenuCommand[]; courses: LibraryItem[]; cheatsheets: LibraryItem[]; categories: LibraryCategory[]; repositories: string[];
  onOpenCourse: (item: LibraryItem) => void; onOpenCheatsheet: (item: LibraryItem) => void; onSwitchRepo: (repo: string) => void;
}) {
  const hotkeys = useAppHotkeys();
  const [[store, palette]] = useState(createSpotlight);
  const { opened } = useSpotlight(store);
  const [, refreshSelection] = useReducer((version: number) => version + 1, 0);
  const selected = store.getState().selected;
  const [query, setQuery] = useState("");
  const idPrefix = `palette-${useId().replaceAll(":", "")}`;
  const listId = `${idPrefix}-results`;
  useHotkey(hotkeys["palette.open"], (event) => {
    const target = event.target;
    if (target instanceof Element && target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false']), .monaco-editor, .excalidraw")) return;
    event.preventDefault(); event.stopPropagation();
    palette.open();
  });
  const menuActions: SpotlightActionData[] = menu.map(({ id, label, icon, onClick, hotkey }) => {
    const binding = hotkey ? shortcutParts(hotkeys[hotkey].hotkey) : [];
    return { id, label, "aria-label": `Sidebar and theme controls: ${label}${binding.length ? `, ${shortcutAccessibleLabel(binding)}` : ""}`, leftSection: icon, onClick, rightSection: binding.length ? <Keycaps label={label} bindings={[binding]} /> : undefined };
  });
  const categoryNames = new Map(categories.map((category) => [category.id, category.name]));
  const libraryAction = (item: LibraryItem, group: "Courses" | "Cheatsheets"): SearchableAction => ({
    action: { id: `${item.kind}:${item.id}`, label: item.title, "aria-label": `${group}: ${item.title}${item.repo ? `, ${item.repo}` : ""}`, description: item.repo, leftSection: item.kind === "course" ? <IconBook size={18} aria-hidden="true" /> : <IconFileText size={18} aria-hidden="true" />, onClick: () => item.kind === "course" ? onOpenCourse(item) : onOpenCheatsheet(item) },
    category: categoryNames.get(item.categoryId), tags: item.tags,
    other: [
      ...(item.repo ? [{ kind: "repository" as const, value: item.repo }] : []),
      ...(item.company ? [{ kind: "company" as const, value: item.company }] : []),
      ...(item.role ? [{ kind: "role" as const, value: item.role }] : []),
    ],
  });
  const groups: Array<{ id: string; label: string; actions: SearchableAction[] }> = [
    { id: "menu", label: "Sidebar and theme controls", actions: menuActions.map((action) => ({ action })) },
    { id: "courses", label: !query.trim() && courses.length > 3 ? `Courses · search all ${courses.length}` : "Courses", actions: (query.trim() ? courses : courses.slice(0, 3)).map((item) => libraryAction(item, "Courses")) },
    { id: "cheatsheets", label: "Cheatsheets", actions: cheatsheets.map((item) => libraryAction(item, "Cheatsheets")) },
    { id: "repositories", label: "Repositories", actions: repositories.map((repo) => ({ action: { id: `repo:${repo}`, label: repo.split("/").at(-1) ?? repo, "aria-label": `Repositories: ${repo.split("/").at(-1) ?? repo} ${repo}`, description: repo, leftSection: <IconFolder size={18} aria-hidden="true" />, onClick: () => onSwitchRepo(repo) }, other: [{ kind: "repository", value: repo }] })) },
  ];
  const search = normalized(query.trim());
  const matches = groups.flatMap((group) => group.actions.flatMap((candidate) => {
    const match = rankAction(candidate, search); if (!match) return [];
    const reason = match.reason;
    const ariaLabel = candidate.action["aria-label"] ?? "";
    const repoSuffix = reason?.kind === "repository" ? `, ${reason.value}` : "";
    const baseLabel = repoSuffix && ariaLabel.endsWith(repoSuffix) ? ariaLabel.slice(0, -repoSuffix.length) : ariaLabel;
    const hint = reason ? `${reason.kind}: ${matchExcerpt(reason, search)}` : "";
    const description = reason ? [hint, reason.kind === "repository" ? undefined : candidate.action.description].filter(Boolean).join(" · ") : candidate.action.description;
    const action = reason ? { ...candidate.action, description, "aria-label": group.id === "repositories" ? `${group.label}: ${candidate.action.label} ${description}` : candidate.action.description && reason.kind !== "repository" ? `${group.label}: ${candidate.action.label}, ${description}` : `${baseLabel}, ${hint}` } : candidate.action;
    return [{ group, action, priority: match.score }];
  })).sort((a, b) => a.priority - b.priority);
  const visibleGroups = matches.reduce<Array<{ id: string; label: string; actions: SpotlightActionData[] }>>((result, { group, action }) => {
    let existing = result.find((item) => item.id === group.id);
    if (!existing) { existing = { id: group.id, label: group.label, actions: [] }; result.push(existing); }
    existing.actions.push(action); return result;
  }, []);
  const visibleActions = visibleGroups.flatMap((group) => group.actions);
  const optionId = (id: string) => `${idPrefix}-option-${encodeURIComponent(id)}`;
  const activeId = selected >= 0 && selected < visibleActions.length ? optionId(visibleActions[selected].id) : undefined;
  let actionIndex = 0;
  return <Spotlight.Root store={store} query={query} onQueryChange={setQuery} shortcut={null} scrollable maxHeight="min(75dvh, 700px)" returnFocus trapFocus closeOnEscape styles={{ action: { minHeight: "2.75rem" } }}>
    <Modal.Title className="ir-visually-hidden">Command palette</Modal.Title>
    <Spotlight.Search role="combobox" aria-label="Search commands" aria-description="Search commands, courses, cheatsheets, and repositories" aria-expanded={opened} aria-controls={listId} aria-activedescendant={activeId} aria-autocomplete="list" placeholder="Search…" leftSection={<IconSearch size={20} aria-hidden="true" />} onKeyDown={(event) => {
      // Spotlight updates its selected index without notifying store subscribers.
      // Its own handler runs after this callback; read the index after it finishes.
      if (!event.nativeEvent.isComposing && (event.code === "ArrowDown" || event.code === "ArrowUp")) queueMicrotask(refreshSelection);
    }} />
    <Spotlight.ActionsList id={listId} role="listbox" aria-label="Command results">
      {visibleGroups.map((group) => <Spotlight.ActionsGroup key={group.id} role="group" aria-labelledby={`${idPrefix}-group-${group.id}`} className={classes.group}>
        <Text id={`${idPrefix}-group-${group.id}`} className={classes.groupLabel} size="xs" fw={700} pl="md" tt="uppercase">{group.label}</Text>
        {group.actions.map(({ id, ...action }) => { const index = actionIndex++; return <Spotlight.Action key={id} {...action} label={action.description ? `${action.label} ` : action.label} className={classes.action} ref={(node) => { if (node) node.id = optionId(id); }} role="option" aria-selected={selected === index} />; })}
      </Spotlight.ActionsGroup>)}
    </Spotlight.ActionsList>
    {visibleActions.length === 0 && <Spotlight.Empty role="status">Nothing found</Spotlight.Empty>}
  </Spotlight.Root>;
}
