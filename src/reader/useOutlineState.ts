import { useCallback, useEffect, useRef, useState } from 'react';
import type { OutlineNode } from '../../server/outlines';
import { outlineProgress, type ReaderNodeState } from './outlineProgress';
import { serverReaderStore, type ReaderStore } from './readerStore';

export function useOutlineState(courseId: string, drillId: string, nodes: OutlineNode[], store: ReaderStore = serverReaderStore) {
  const key = `${courseId}/${drillId}`;
  const [snapshot, setSnapshot] = useState<{ key: string; state: Record<string, ReaderNodeState>; hydrated: boolean }>({ key, state: {}, hydrated: false });
  const state = snapshot.key === key ? snapshot.state : {};
  const hydrated = snapshot.key === key && snapshot.hydrated;
  const request = useRef(0);
  const saveVersion = useRef<Record<string, number>>({});
  const load = useCallback(() => {
    const requestId = ++request.current;
    const versions = { ...saveVersion.current };
    return store.load(courseId, drillId).then((loaded) => {
      if (loaded === undefined || requestId !== request.current) return;
      setSnapshot((current) => {
        const local = current.key === key ? current.state : {};
        const state = { ...loaded };
        for (const [nodeId, version] of Object.entries(saveVersion.current)) {
          if (version !== versions[nodeId] && local[nodeId]) state[nodeId] = local[nodeId];
        }
        return { key, state, hydrated: true };
      });
    });
  }, [courseId, drillId, key, store]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { const refresh = () => { if (document.visibilityState !== 'hidden') void load(); }; window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh); return () => { window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); }; }, [load]);
  const patch = (id: string, value: ReaderNodeState) => {
    const version = (saveVersion.current[id] ?? 0) + 1;
    saveVersion.current[id] = version;
    let previous: ReaderNodeState = {};
    setSnapshot((current) => {
      const currentState = current.key === key ? current.state : {};
      previous = currentState[id] ?? {};
      return { key, hydrated: current.key === key && current.hydrated, state: { ...currentState, [id]: { ...previous, ...value } } };
    });
    void store.set(courseId, drillId, id, value).catch(() => setSnapshot((current) => saveVersion.current[id] === version && current.key === key ? { ...current, state: { ...current.state, [id]: previous } } : current));
  };
  return { state, hydrated, isFolded: (id: string) => state[id]?.folded ?? true, isChecked: (id: string) => state[id]?.checked ?? false, toggleFold: (id: string) => patch(id, { folded: !(state[id]?.folded ?? true) }), toggleCheck: (id: string) => patch(id, { checked: !(state[id]?.checked ?? false) }), progress: outlineProgress(nodes, state) };
}
