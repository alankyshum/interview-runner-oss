import '@testing-library/jest-dom';

// jsdom has no layout engine, so matchMedia never matches on its own. Evaluate
// `min-width`/`max-width` against window.innerWidth so components that branch on
// a breakpoint can be tested at a chosen viewport width.
//
// Real browsers return a stable MediaQueryList per query. Hooks such as Mantine's
// useMediaQuery subscribe to that object inside an effect keyed on its identity, so
// handing back a fresh object per call makes them re-subscribe and re-render on every
// render. Cache per query to preserve the identity contract.
if (typeof window !== 'undefined') {
  let storageAvailable = true;
  try { storageAvailable = typeof window.localStorage?.getItem === 'function'; } catch { storageAvailable = false; }
  if (!storageAvailable) {
    const values = new Map<string, string>();
    const storage = { get length() { return values.size; }, key: (index: number) => [...values.keys()][index] ?? null, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key), clear: () => values.clear() };
    Object.defineProperty(window, 'localStorage', { value: storage });
    Object.defineProperty(globalThis, 'localStorage', { value: storage });
  }
  const mediaQueryLists = new Map<string, MediaQueryList>();
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => {
      const cached = mediaQueryLists.get(query);
      if (cached) return cached;
      const list = {
        get matches() {
          const bound = /(min|max)-width:\s*([\d.]+)(px|em|rem)/.exec(query);
          if (bound) {
            const px = bound[3] === 'px' ? Number(bound[2]) : Number(bound[2]) * 16;
            return bound[1] === 'min' ? window.innerWidth >= px : window.innerWidth <= px;
          }
          // jsdom reports no OS preference, so pin a deterministic one: tests that
          // care about `auto` assert the resolved scheme rather than the OS value.
          if (query === '(prefers-color-scheme: dark)') return false;
          if (query === '(prefers-color-scheme: light)') return true;
          return false;
        },
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      } as unknown as MediaQueryList;
      mediaQueryLists.set(query, list);
      return list;
    },
  });

  // jsdom ships no ResizeObserver; Mantine's ScrollArea (used by Select's dropdown)
  // constructs one on mount.
  if (!('ResizeObserver' in globalThis)) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }

  if (!('IntersectionObserver' in globalThis)) {
    globalThis.IntersectionObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() { return []; }
      root = null;
      rootMargin = '200px';
      thresholds = [];
    } as unknown as typeof IntersectionObserver;
  }

  // jsdom does not implement scrollIntoView; Mantine's Combobox calls it when
  // highlighting the active option.
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
}
