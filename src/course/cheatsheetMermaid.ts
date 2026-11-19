import DOMPurify from 'dompurify';

let nextDiagram = 0;
let renderQueue: Promise<void> = Promise.resolve();

/** Load only same-course Mermaid sources; neither source scripts nor SVG scripts are trusted. */
export function hydrateCheatsheetMermaid(root: HTMLElement, courseId: string): () => void {
  const disposers: Array<() => void> = [];
  const refresh: Array<() => void> = [];
  for (const host of root.querySelectorAll<HTMLElement>('[data-mermaid-src]')) {
    let active = true; let source = ''; let generation = 0; let resize: ResizeObserver | undefined;
    const abort = new AbortController(); const id = `cheatsheet-mermaid-${++nextDiagram}`;
    const fail = (error: unknown) => {
      if (!active || abort.signal.aborted) return;
      console.error('Diagram unavailable:', error); host.textContent = 'Diagram unavailable. See the text version below.'; host.dataset.diagramError = '';
      const figure = host.closest('figure'); const transcript = figure?.querySelector<HTMLDetailsElement>(':scope > details.figure-transcript');
      if (transcript) transcript.open = true;
      for (let parent = figure?.parentElement; parent && parent !== root; parent = parent.parentElement) if (parent instanceof HTMLDetailsElement) parent.open = true;
    };
    const render = () => {
      if (!source || !active) return;
      const current = ++generation;
      const theme = document.documentElement.getAttribute('data-mantine-color-scheme') === 'dark' ? 'dark' : 'default';
      const job = renderQueue.then(async () => {
        const { default: mermaid } = await import('mermaid');
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme, htmlLabels: false, flowchart: { htmlLabels: false, useMaxWidth: false, wrappingWidth: 240 } });
        return (await mermaid.render(`${id}-${current}`, source)).svg;
      });
      renderQueue = job.then(() => {}, () => {});
      void job.then((svgText) => {
        if (!active || generation !== current) return;
        const template = document.createElement('template');
        template.innerHTML = DOMPurify.sanitize(svgText, { USE_PROFILES: { svg: true, svgFilters: true }, FORBID_TAGS: ['style', 'script', 'foreignObject', 'iframe', 'a', 'image', 'use', 'animate', 'animateTransform', 'animateMotion', 'set', 'feImage'], FORBID_ATTR: ['style', 'href', 'xlink:href'] });
        const svg = template.content.querySelector('svg');
        const viewBox = svg?.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
        if (!svg || !viewBox || viewBox.length !== 4 || viewBox.some((n) => !Number.isFinite(n)) || viewBox[2] <= 0 || viewBox[3] <= 0) throw new Error('Invalid rendered diagram');
        svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', host.getAttribute('aria-label') || 'Diagram');
        svg.removeAttribute('height'); svg.removeAttribute('width');
        const hint = document.createElement('span'); hint.className = 'embedded-mermaid-scroll-hint';
        host.replaceChildren(hint, svg); delete host.dataset.diagramError;
        const size = () => {
          if (!active || host.clientWidth <= 0) return;
          const width = Math.max(viewBox[2], Math.min(host.clientWidth, viewBox[2] * 1.25));
          svg.style.width = `${width}px`; svg.style.height = `${width * viewBox[3] / viewBox[2]}px`;
          hint.textContent = width > host.clientWidth + 2 ? 'Scroll horizontally to see the rest of the diagram ↔' : '';
        };
        resize?.disconnect(); resize = new ResizeObserver(size); resize.observe(host); size();
      }).catch((error: unknown) => { if (generation === current) fail(error); });
    };
    refresh.push(render);
    const path = host.dataset.mermaidSrc ?? '';
    const start = async () => {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(courseId) || !/^diagrams\/mermaid\/[a-zA-Z0-9_-]+\.mmd$/.test(path)) throw new Error('Invalid diagram source');
      const response = await fetch(`/cheatsheets/${encodeURIComponent(courseId)}/${path}`, { signal: abort.signal });
      if (!response.ok) throw new Error(`Diagram request failed (${response.status})`);
      source = await response.text();
      if (!source.trim() || /%%\s*\{|^---\s*$/m.test(source)) throw new Error('Empty diagram or unsupported configuration directive');
      render();
    };
    let intersection: IntersectionObserver;
    try { intersection = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) { intersection.disconnect(); void start().catch(fail); } }, { rootMargin: '300px' }); intersection.observe(host); }
    catch (error) { fail(error); continue; }
    disposers.push(() => { active = false; abort.abort(); intersection.disconnect(); resize?.disconnect(); });
  }
  const theme = new MutationObserver(() => refresh.forEach((render) => render()));
  theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-mantine-color-scheme'] });
  return () => { theme.disconnect(); disposers.forEach((dispose) => dispose()); };
}
