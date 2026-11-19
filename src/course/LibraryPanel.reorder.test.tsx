import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import LibraryPanel, { persistedMoveIndex, type LibraryItem, type LibrarySnapshot } from "./LibraryPanel";

const item = (id: string, position: number, status: LibraryItem["status"] = "active", inProgress = false): LibraryItem => ({ kind: "course", id, title: id, manifestTitle: id, categoryId: "uncategorized", position, status, statusExplicit: true, inProgress, tags: [], doneDrills: 0, totalDrills: 2, remainingMinutes: 10 });
const fixture = (): LibrarySnapshot => ({ categories: [{ id: "uncategorized", name: "Uncategorized", position: 0, fixed: true }], items: [item("archived", 0, "archived"), item("Alpha", 1, "active", true), item("done", 2, "done"), item("Initech", 3)], courseRepos: [] });
function Harness({ initial }: { initial: LibrarySnapshot }) {
  const [snapshot, setSnapshot] = useState(initial);
  return <MantineProvider><LibraryPanel snapshot={snapshot} onChange={setSnapshot} onOpen={() => {}} /></MantineProvider>;
}
const courseName = (title: string) => `${title} 0/2 · 10m left, 0 of 2 drills complete, 10 minutes left`;
const rowOrder = () => screen.getAllByRole("button").filter((button) => [courseName("Alpha"), courseName("Initech")].includes(button.getAttribute("aria-label") ?? '')).map((button) => button.querySelector('.library-item-title')!.textContent!.trim());

describe("persisted library ordering", () => {
  it("maps visible insertion positions into the full category, including hidden statuses", () => {
    const { items } = fixture();
    expect(persistedMoveIndex(items, items[3], "uncategorized", 0)).toBe(1);
    expect(persistedMoveIndex(items, items[1], "uncategorized", 1)).toBe(3);
    expect(persistedMoveIndex(items, items[3], "new-category", 0)).toBe(0);
  });

  it("moves Initech above an in-progress course, persists on remount, and supports moving back down", async () => {
    let persisted = fixture();
    const fetchMock = vi.fn(async (path: string, options: RequestInit) => {
      const { categoryId, position } = JSON.parse(String(options.body));
      const moved = persisted.items.find((candidate) => path.includes(`/course/${candidate.id}/`))!;
      const remaining = persisted.items.filter((candidate) => candidate.id !== moved.id).sort((a, b) => a.position - b.position);
      remaining.splice(position, 0, { ...moved, categoryId });
      persisted = { ...persisted, items: remaining.map((candidate, index) => ({ ...candidate, position: index })) };
      return new Response(JSON.stringify(persisted));
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = render(<Harness initial={persisted} />);
    expect(rowOrder()).toEqual(["Alpha", "Initech"]);
    const source = screen.getByRole("button", { name: courseName("Initech") });
    const alpha = screen.getByRole("button", { name: courseName("Alpha") }).closest("li")!;
    source.setPointerCapture = vi.fn();
    vi.stubGlobal("PointerEvent", MouseEvent);
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => alpha });
    const send = (type: string, x: number, y: number) => { const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 }); Object.defineProperties(event, { pointerId: { value: 1 }, isPrimary: { value: true } }); fireEvent(source, event); };
    send("pointerdown", 0, 0); send("pointermove", 10, -1);
    expect(document.querySelector(".library-drag-preview")).toHaveTextContent("Initech");
    expect(document.body).toHaveClass("library-dragging");
    send("pointerup", 10, -1);
    await waitFor(() => expect(rowOrder()).toEqual(["Initech", "Alpha"]));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({ categoryId: "uncategorized", position: 1 });
    view.unmount();
    render(<Harness initial={persisted} />);
    expect(rowOrder()).toEqual(["Initech", "Alpha"]);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Actions for Initech" }));
    await user.click(await screen.findByRole("menuitem", { name: "Move down" }));
    await waitFor(() => expect(rowOrder()).toEqual(["Alpha", "Initech"]));
  });

  it("issues only one mutation when dropping onto the category list", async () => {
    const snapshot = fixture();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(snapshot)));
    vi.stubGlobal("fetch", fetchMock);
    render(<Harness initial={snapshot} />);
    const dataTransfer = { getData: () => "course:Alpha" };
    const list = screen.getByRole("button", { name: courseName("Initech") }).closest("ul")!;
    fireEvent.drop(list, { dataTransfer });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });

  it("moves a row onto another category without collapsing panels", async () => {
    const snapshot = fixture();
    snapshot.categories.push({ id: "other", name: "Other", position: 1, fixed: false });
    const fetchMock = vi.fn(async (_path: string, _options: RequestInit) => new Response(JSON.stringify(snapshot)));
    const onExpandedChange = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<MantineProvider><LibraryPanel snapshot={snapshot} onChange={() => {}} onOpen={() => {}} onExpandedChange={onExpandedChange} /></MantineProvider>);
    const source = screen.getByRole("button", { name: courseName("Alpha") });
    const target = screen.getByRole("button", { name: "Collapse Other 0 in Up next" });
    source.setPointerCapture = vi.fn();
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => target });
    const send = (type: string, x: number) => { const event = new MouseEvent(type, { bubbles: true, clientX: x, button: 0 }); Object.defineProperties(event, { pointerId: { value: 1 }, isPrimary: { value: true } }); fireEvent(source, event); };
    send("pointerdown", 0); send("pointermove", 10); send("pointerup", 10);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({ categoryId: "other", position: 0 });
    expect(onExpandedChange).not.toHaveBeenCalled();
  });

  it("keeps clicks and action controls usable, and cancels pointer drags", async () => {
    const onOpen = vi.fn();
    render(<MantineProvider><LibraryPanel snapshot={fixture()} onChange={() => {}} onOpen={onOpen} /></MantineProvider>);
    const title = screen.getByRole("button", { name: courseName("Alpha") });
    title.setPointerCapture = vi.fn();
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => title });
    const send = (type: string, x: number) => { const event = new MouseEvent(type, { bubbles: true, clientX: x, button: 0 }); Object.defineProperties(event, { pointerId: { value: 1 }, isPrimary: { value: true } }); fireEvent(title, event); };
    send("pointerdown", 0); send("pointermove", 3); send("pointerup", 3); fireEvent.click(title);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".library-drag-preview")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Actions for Alpha" }));
    expect(await screen.findByRole("menuitem", { name: "Move down" })).toBeInTheDocument();
    expect(onOpen).toHaveBeenCalledTimes(1);
    send("pointerdown", 0); send("pointermove", 10); send("pointercancel", 10);
    expect(document.querySelector(".library-drag-preview")).toBeNull();
    expect(document.body).not.toHaveClass("library-dragging");
    fireEvent.click(title);
    expect(onOpen).toHaveBeenCalledTimes(2);
  });
});
