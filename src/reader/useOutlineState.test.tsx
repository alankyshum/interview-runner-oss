import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useOutlineState } from './useOutlineState';

const nodes = [{ id: 'leaf', type: 'step' as const, text: 'Leaf' }];

describe('useOutlineState', () => {
  it('reconciles a local toggle made before the initial load completes', async () => {
    let resolveLoad!: (state: Record<string, { checked?: boolean }>) => void;
    const store = {
      load: vi.fn(() => new Promise<Record<string, { checked?: boolean }>>((resolve) => { resolveLoad = resolve; })),
      set: vi.fn(async () => {}),
    };
    const reader = renderHook(() => useOutlineState('book', 'chapter', nodes, store));

    await act(async () => { reader.result.current.toggleCheck('leaf'); });
    expect(reader.result.current.progress.checked).toBe(1);
    expect(reader.result.current.hydrated).toBe(false);

    await act(async () => { resolveLoad({ leaf: { checked: false } }); });
    await waitFor(() => expect(reader.result.current.hydrated).toBe(true));
    expect(reader.result.current.progress.checked).toBe(1);
  });

  it('lets two readers converge after a visibility refetch', async () => {
    let serverChecked = false;
    const store = {
      load: vi.fn(async () => ({ leaf: { checked: serverChecked } })),
      set: vi.fn(async (_course: string, _drill: string, _id: string, patch: { checked?: boolean }) => { serverChecked = patch.checked ?? serverChecked; }),
    };
    const first = renderHook(() => useOutlineState('book', 'chapter', nodes, store));
    const second = renderHook(() => useOutlineState('book', 'chapter', nodes, store));
    await waitFor(() => expect(first.result.current.progress.checked).toBe(0));
    await act(async () => { first.result.current.toggleCheck('leaf'); });
    await waitFor(() => expect(second.result.current.progress.checked).toBe(0));
    document.dispatchEvent(new Event('visibilitychange'));
    await waitFor(() => expect(second.result.current.progress.checked).toBe(1));
    expect(first.result.current.progress.checked).toBe(1);
  });
});
