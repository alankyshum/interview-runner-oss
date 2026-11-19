import { Transformer } from 'markmap-lib';
import { Markmap } from 'markmap-view';
import type { INode } from 'markmap-common';
import { sanitizeMapNode } from '../reader/MapRecall';
import { expandMap, reflowMap, setImmediateMapLayout } from '../reader/mapNavigation';
import { MAP_MAX_WIDTH } from '../reader/mapWidth';

const MIN_SCALE = 12 / 14;
export const CHEATSHEET_HYDRATE_EVENT = 'interview-runner:hydrate-cheatsheet-map';

/** Reserve enough canvas for the whole tree without shrinking 14px code below 12px. */
export function embeddedMapSize(rect: { x1: number; y1: number; x2: number; y2: number }, width: number, fitRatio: number) {
  if (![rect.x1, rect.x2, rect.y1, rect.y2, width, fitRatio].every(Number.isFinite) || width <= 0 || fitRatio <= 0 || rect.x2 <= rect.x1 || rect.y2 <= rect.y1) throw new Error('Invalid map layout');
  return { width: Math.max(width, Math.ceil((rect.x2 - rect.x1) * MIN_SCALE / fitRatio + 32)), height: Math.max(180, Math.ceil((rect.y2 - rect.y1) * MIN_SCALE / fitRatio + 32)) };
}

/** Hydrate only same-course Markdown assets. The transcript remains the no-JS fallback. */
export function hydrateCheatsheetMaps(root: HTMLElement, courseId: string): () => void {
  const disposers: Array<() => void> = [];
  for (const host of root.querySelectorAll<HTMLElement>('[data-markmap-src]')) {
    let active = true; let instance: Markmap | undefined; let resize: ResizeObserver | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = new AbortController();
    const fail = (error: unknown) => {
      if (!active || abort.signal.aborted) return;
      console.error('Mind map unavailable:', error);
      host.textContent = 'Mind map unavailable. See the text version below.';
      host.dataset.mapError = '';
      const figure = host.closest('figure');
      const transcript = figure?.querySelector<HTMLDetailsElement>(':scope > details.figure-transcript');
      if (transcript) transcript.open = true;
      for (let parent = figure?.parentElement; parent && parent !== root; parent = parent.parentElement) if (parent instanceof HTMLDetailsElement) parent.open = true;
    };
    const source = host.dataset.markmapSrc ?? '';
    const start = async () => {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(courseId) || !/^diagrams\/mindmaps\/[a-zA-Z0-9_-]+\.md$/.test(source)) throw new Error('Invalid map source');
      const response = await fetch(`/cheatsheets/${encodeURIComponent(courseId)}/${source}`, { signal: abort.signal });
      if (!response.ok) throw new Error(`Map request failed (${response.status})`);
      const markdown = await response.text();
      if (!markdown.trim()) throw new Error('Map source is empty');
      const transformed = new Transformer().transform(markdown);
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('role', 'group'); svg.setAttribute('aria-label', host.getAttribute('aria-label') || 'Mind map');
      const controls = document.createElement('div'); controls.className = 'embedded-map-controls';
      const hint = document.createElement('span'); hint.className = 'embedded-map-scroll-hint';
      host.replaceChildren(controls, hint, svg);
      const options = transformed.frontmatter?.markmap;
      const numeric = Object.fromEntries((['initialExpandLevel', 'spacingVertical'] as const).flatMap((key) => typeof options?.[key] === 'number' && Number.isFinite(options[key]) ? [[key, options[key]]] : []));
      const nodeWidth = () => Math.min(MAP_MAX_WIDTH, Math.max(120, Math.floor(host.clientWidth - 32)));
      instance = new Markmap(svg, { autoFit: false, spacingHorizontal: 20, ...numeric, maxWidth: nodeWidth(), duration: 0 });
      const map = instance;
      setImmediateMapLayout(map);
      const fit = async () => {
        if (!active || host.clientWidth <= 0) return;
        const size = embeddedMapSize(map.state.rect, host.clientWidth, map.options.fitRatio);
        svg.style.width = `${size.width}px`; svg.style.height = `${size.height}px`;
        hint.textContent = size.width > host.clientWidth + 2 ? 'Scroll horizontally to see the rest of the map ↔' : '';
        await map.fit(1);
        const rootNode = svg.querySelector<SVGGElement>('g.markmap-node[data-depth="1"]');
        host.scrollLeft = rootNode && size.width > host.clientWidth ? Math.max(0, rootNode.getBoundingClientRect().left - svg.getBoundingClientRect().left - 16) : 0;
      };
      const toggle = map.toggleNode.bind(map);
      map.toggleNode = async (...args) => { const expanding = Boolean(args[0].payload?.fold); await toggle(...args); await fit(); if (expanding) map.findElement(args[0])?.g.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' }); };
      for (const [label, action] of [['Zoom out', () => { const scale = (map.svg.property('__zoom') as { k?: number })?.k ?? 1; return map.rescale(Math.max(MIN_SCALE / scale, 0.8)); }], ['Zoom in', () => map.rescale(1.25)], ['Fit map', fit], ['Fit all', async () => { await expandMap(map); await fit(); }]] as const) {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.addEventListener('click', () => { void action().catch(fail); }); controls.appendChild(button);
      }
      instance.svg.on('wheel', null);
      instance.zoom.scaleExtent([MIN_SCALE, 4]);
      instance.zoom.filter((event: Event & { ctrlKey?: boolean; button?: number }) => event.type === 'wheel' ? Boolean(event.ctrlKey) : !event.button && !event.ctrlKey);
      await document.fonts?.ready;
      if (!active) return;
      await instance.setData(sanitizeMapNode(transformed.root));
      if (!active) return;
      await fit();
      if (!active) return;
      host.dataset.mapReady = '';
      const decorate = () => {
        for (const group of svg.querySelectorAll<SVGGElement>('g.markmap-node')) {
          const circle = group.querySelector(':scope > circle');
          const node = (group as SVGGElement & { __data__: INode }).__data__;
          if (!circle || !node?.children.length) continue;
          circle.setAttribute('tabindex', '0'); circle.setAttribute('role', 'button');
          circle.setAttribute('aria-expanded', String(!node.payload?.fold));
          circle.setAttribute('aria-label', `${node.payload?.fold ? 'Expand' : 'Collapse'} ${group.querySelector('foreignObject')?.textContent?.trim() || 'branch'}`);
          if (!circle.hasAttribute('data-map-keyboard')) {
            circle.setAttribute('data-map-keyboard', '');
            circle.addEventListener('keydown', (event) => { if (event instanceof KeyboardEvent && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); void map.toggleNode((group as SVGGElement & { __data__: INode }).__data__).then(decorate).catch(fail); } });
          }
        }
      };
      const changes = new MutationObserver(decorate); changes.observe(svg, { childList: true, subtree: true }); disposers.push(() => changes.disconnect()); decorate();
      let previousWidth = host.clientWidth;
      resize = new ResizeObserver(() => {
        const width = host.clientWidth;
        if (width <= 0 || width === previousWidth) return;
        previousWidth = width;
        clearTimeout(timer);
        timer = setTimeout(() => { if (active && host.clientWidth > 0) void reflowMap(map, nodeWidth()).then(fit).catch(fail); }, 120);
      });
      resize.observe(host);
    };
    let intersection: IntersectionObserver; let started = false;
    const hydrate = () => { if (!active || started) return; started = true; intersection.disconnect(); void start().catch(fail); };
    try {
      intersection = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) hydrate(); }, { rootMargin: '300px' });
      intersection.observe(host); host.addEventListener(CHEATSHEET_HYDRATE_EVENT, hydrate);
    } catch (error) { fail(error); continue; }
    disposers.push(() => { active = false; host.removeEventListener(CHEATSHEET_HYDRATE_EVENT, hydrate); abort.abort(); clearTimeout(timer); intersection.disconnect(); resize?.disconnect(); instance?.destroy(); });
  }
  return () => disposers.forEach((dispose) => dispose());
}
