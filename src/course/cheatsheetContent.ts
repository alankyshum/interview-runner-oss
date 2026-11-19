import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/core';
import python from 'highlight.js/lib/languages/python';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';

hljs.registerLanguage('python', python);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('typescript', typescript);

const sanitize = (html: string) => DOMPurify.sanitize(html, { FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form', 'button'], FORBID_ATTR: ['style', 'data-ir-origin'] });
type Section = { id: string; html: string };

/** Attach explicitly parented fragments after either composition path has assembled them. */
function nestSheetFragments(root: HTMLElement, fallbackWrappers?: ReadonlySet<Element>): string {
  const fragments = [...root.querySelectorAll<HTMLElement>('[data-sheet-parent]')];
  for (const fragment of fragments) {
    const id = fragment.getAttribute('data-sheet-parent') ?? '';
    if (!id) throw new Error('Sheet parent id must not be empty.');
    const matches = [...root.querySelectorAll<HTMLElement>('[id]')].filter((element) => element.id === id);
    if (matches.length !== 1) throw new Error(`Sheet parent "${id}" must identify exactly one element (found ${matches.length}).`);
    const target = matches[0];
    if (!(target instanceof HTMLDetailsElement)) throw new Error(`Sheet parent "${id}" must be a details element.`);
    if (fragment === target || fragment.contains(target)) throw new Error(`Sheet parent "${id}" creates a cycle.`);
    const previousParent = fragment.parentElement;
    target.appendChild(fragment);
    if (previousParent && fallbackWrappers?.has(previousParent) && !previousParent.children.length && !previousParent.textContent?.trim()) previousParent.remove();
  }
  return root.innerHTML;
}

/** Rebuild the document from current section files, using the old page only as a layout template. */
export function composeCheatsheetContent(layout: string | null, sections: Section[]): string {
  const parsed = sections.map((section) => {
    const template = document.createElement('template'); template.innerHTML = sanitize(section.html);
    template.content.querySelectorAll('[data-sheet-section]').forEach((element) => element.removeAttribute('data-sheet-section'));
    const heading = template.content.querySelector('h1,h2,h3,h4,h5,h6');
    if (!heading && !/^(?:\d+-)?introduction$/.test(section.id)) throw new Error(`Section ${section.id} must contain a heading.`);
    (heading ?? template.content.firstElementChild)?.setAttribute('data-sheet-section', section.id);
    return template.content;
  });
  const fallback = () => {
    const root = document.createElement('div'); const wrappers = new Set<Element>();
    parsed.forEach((fragment, index) => {
      const wrapper = document.createElement('section'); wrappers.add(wrapper);
      if (!fragment.querySelector('[data-sheet-section]')) wrapper.setAttribute('data-sheet-section', sections[index].id);
      wrapper.append(fragment); root.append(wrapper);
    });
    return nestSheetFragments(root, wrappers);
  };
  if (!layout) return fallback();
  const source = document.createElement('div'); source.innerHTML = sanitize(layout);
  const markers = [...source.querySelectorAll('[data-sheet-section]')];
  const markerIndices = new Map(markers.map((marker, index) => [marker.getAttribute('data-sheet-section'), index]));
  if (!markers.length || markerIndices.size !== markers.length) return fallback();
  let lastIndex = -1;
  for (const section of sections) { const index = markerIndices.get(section.id); if (index !== undefined) { if (index <= lastIndex) return fallback(); lastIndex = index; } }
  [...source.querySelectorAll('*')].forEach((element, index) => element.setAttribute('data-ir-origin', String(index)));

  // The range clones retain ancestor identities. Match the current fragment's
  // elements to those clones so adjacent portions of one original grid/card can
  // be rejoined, even when the fragment's text or children were edited.
  const signature = (element: Element) => `${element.tagName}\0${element.getAttribute('id') ?? ''}\0${element.getAttribute('class') ?? ''}`;
  const annotate = (baseline: ParentNode, current: ParentNode) => {
    const left = [...baseline.children]; const right = [...current.children];
    if (left.length * right.length > 65_536) {
      const positions = new Map<string, { indices: number[]; cursor: number }>();
      left.forEach((element, index) => { const key = signature(element); const entry = positions.get(key); if (entry) entry.indices.push(index); else positions.set(key, { indices: [index], cursor: 0 }); });
      let next = 0;
      for (const element of right) {
        const candidates = positions.get(signature(element)); if (!candidates) continue;
        while (candidates.cursor < candidates.indices.length && candidates.indices[candidates.cursor] < next) candidates.cursor++;
        const index = candidates.indices[candidates.cursor++]; if (index === undefined) continue;
        const origin = left[index].getAttribute('data-ir-origin'); if (origin !== null) element.setAttribute('data-ir-origin', origin);
        annotate(left[index], element); next = index + 1;
      }
      return;
    }
    const table = Array.from({ length: left.length + 1 }, () => new Uint32Array(right.length + 1));
    for (let i = left.length - 1; i >= 0; i--) for (let j = right.length - 1; j >= 0; j--) table[i][j] = signature(left[i]) === signature(right[j]) ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    let i = 0; let j = 0;
    while (i < left.length && j < right.length) {
      if (signature(left[i]) === signature(right[j])) {
        const origin = left[i].getAttribute('data-ir-origin'); if (origin !== null) right[j].setAttribute('data-ir-origin', origin);
        annotate(left[i], right[j]); i++; j++;
      } else if (table[i + 1][j] >= table[i][j + 1]) i++; else j++;
    }
  };
  const result = document.createElement('div');
  const merge = (parent: Node, fragment: ParentNode) => {
    for (const child of [...fragment.childNodes]) {
      let previous = parent.lastChild;
      while (previous?.nodeType === Node.TEXT_NODE && !previous.textContent?.trim()) previous = previous.previousSibling;
      if (child instanceof Element && previous instanceof Element && child.hasAttribute('data-ir-origin') && child.getAttribute('data-ir-origin') === previous.getAttribute('data-ir-origin')) merge(previous, child);
      else parent.appendChild(child);
    }
  };
  const ensureParent = (ancestor: Element): Element => {
    if (ancestor === source) return result;
    const origin = ancestor.getAttribute('data-ir-origin');
    const existing = origin === null ? null : result.querySelector(`[data-ir-origin="${origin}"]`);
    if (existing) return existing;
    const parent = ancestor.parentElement ? ensureParent(ancestor.parentElement) : result;
    const copy = ancestor.cloneNode(false) as Element; parent.appendChild(copy); return copy;
  };
  let lastParent: Element = result;
  parsed.forEach((fragment, index) => {
    const markerIndex = markerIndices.get(sections[index].id);
    if (markerIndex === undefined) {
      const next = sections.slice(index + 1).map((section) => markerIndices.get(section.id)).find((value) => value !== undefined);
      const placeholder = lastParent.lastElementChild; const origin = placeholder?.getAttribute('data-ir-origin');
      const original = origin === null || origin === undefined ? null : source.querySelector(`[data-ir-origin="${origin}"]`);
      if (next !== undefined && placeholder && original?.contains(markers[next]) && !placeholder.textContent?.trim() && !placeholder.querySelector('img,svg,table,pre,[data-sheet-section]')) placeholder.remove();
      merge(lastParent, fragment); return;
    }
    const range = document.createRange(); range.setStartBefore(markers[markerIndex]);
    if (markers[markerIndex + 1]) range.setEndBefore(markers[markerIndex + 1]); else range.setEnd(source, source.childNodes.length);
    const baseline = range.cloneContents();
    annotate(baseline, fragment);
    const ancestor = range.commonAncestorContainer instanceof Element ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement;
    lastParent = ancestor ? ensureParent(ancestor) : result; merge(lastParent, fragment);
  });
  const active = new Set(sections.map((section) => section.id));
  for (const marker of markers) if (!active.has(marker.getAttribute('data-sheet-section') ?? '')) {
    for (let ancestor = marker.parentElement; ancestor && ancestor !== source; ancestor = ancestor.parentElement) {
      const origin = ancestor.getAttribute('data-ir-origin'); const copy = origin === null ? null : result.querySelector(`[data-ir-origin="${origin}"]`);
      if (copy && !copy.textContent?.trim() && !copy.querySelector('img,svg,table,pre,[data-sheet-section]')) copy.remove();
    }
  }
  result.querySelectorAll('[data-ir-origin]').forEach((element) => element.removeAttribute('data-ir-origin'));
  return nestSheetFragments(result);
}

/** Sanitize before creating DOM, then highlight only known languages or pseudocode. */
export function prepareCheatsheetContent(html: string): string {
  const template = document.createElement('template');
  template.innerHTML = sanitize(html);
  for (const link of template.content.querySelectorAll<HTMLAnchorElement>('.reference-figure a[href]')) {
    if (!link.querySelector('img')) continue;
    link.target = '_blank'; link.rel = 'noopener noreferrer';
    const image = link.querySelector('img');
    link.setAttribute('aria-label', `Open image: ${image?.getAttribute('alt') || 'reference figure'} (opens in a new tab)`);
  }
  for (const code of template.content.querySelectorAll('pre code')) {
    const declared = [...code.classList].map((name) => /^(?:language|lang)-(.+)$/.exec(name)?.[1]).find(Boolean);
    const language = declared ?? (code.closest('pre.logic-pseudocode') ? 'python' : undefined);
    if (!language || !hljs.getLanguage(language)) continue;
    code.innerHTML = hljs.highlight(code.textContent ?? '', { language }).value;
    code.classList.add('hljs');
    if (!declared) code.classList.add('language-python');
  }
  return template.innerHTML;
}

/** Make only horizontally overflowing code blocks keyboard-scrollable. */
export function watchCheatsheetCodeOverflow(root: HTMLElement): () => void {
  const blocks = [...root.querySelectorAll<HTMLElement>('pre')].filter((pre) => !pre.closest('[aria-hidden="true"]'));
  const originals = new Map(blocks.map((pre) => [pre, { tabindex: pre.getAttribute('tabindex'), role: pre.getAttribute('role'), label: pre.getAttribute('aria-label') }]));
  const restore = (element: HTMLElement, name: string, value: string | null) => { if (value === null) element.removeAttribute(name); else element.setAttribute(name, value); };
  const update = (pre: HTMLElement) => {
    const original = originals.get(pre)!;
    if (pre.clientWidth > 0 && pre.scrollWidth > pre.clientWidth + 1) {
      let title = 'Code example';
      for (const heading of root.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')) if (heading.compareDocumentPosition(pre) & Node.DOCUMENT_POSITION_FOLLOWING) title = heading.textContent?.replace(/\s+/g, ' ').trim() || title;
      pre.tabIndex = 0; pre.setAttribute('role', 'region');
      if (!original.label && !pre.hasAttribute('aria-labelledby')) pre.setAttribute('aria-label', `${title}: code, scroll horizontally`);
    } else {
      restore(pre, 'tabindex', original.tabindex); restore(pre, 'role', original.role); restore(pre, 'aria-label', original.label);
    }
  };
  const updateAll = () => blocks.forEach(update);
  const observer = new ResizeObserver((entries) => { for (const entry of entries) if (originals.has(entry.target as HTMLElement)) update(entry.target as HTMLElement); });
  let active = true;
  blocks.forEach((pre) => observer.observe(pre)); window.addEventListener('resize', updateAll); updateAll();
  void document.fonts?.ready.then(() => { if (active) updateAll(); }).catch((error: unknown) => console.warn('Cheatsheet code font check failed:', error));
  return () => { active = false; observer.disconnect(); window.removeEventListener('resize', updateAll); for (const [pre, original] of originals) { restore(pre, 'tabindex', original.tabindex); restore(pre, 'role', original.role); restore(pre, 'aria-label', original.label); } };
}

/** Reveal the text alternative if a static atlas diagram cannot load. */
export function watchCheatsheetDiagramFailures(root: HTMLElement): () => void {
  const reveal = (image: HTMLImageElement) => {
    if (!image.matches('.atlas-diagram-viewport img') || getComputedStyle(image).display === 'none') return;
    const figure = image.closest('.atlas-diagram');
    const details = figure?.querySelector<HTMLDetailsElement>(':scope > details.figure-transcript');
    if (!details) return;
    details.open = true;
    for (let parent = figure?.parentElement; parent && parent !== root; parent = parent.parentElement) {
      if (parent instanceof HTMLDetailsElement) parent.open = true;
    }
  };
  const onError = (event: Event) => { if (event.target instanceof HTMLImageElement) reveal(event.target); };
  root.addEventListener('error', onError, true);
  const checkImages = () => {
    for (const image of root.querySelectorAll<HTMLImageElement>('.atlas-diagram-viewport img')) {
      if (image.complete && image.naturalWidth === 0) reveal(image);
    }
  };
  checkImages();
  const observer = new MutationObserver(checkImages);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-mantine-color-scheme'] });
  return () => { observer.disconnect(); root.removeEventListener('error', onError, true); };
}
