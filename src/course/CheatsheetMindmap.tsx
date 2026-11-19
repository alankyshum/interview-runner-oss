import { Alert, Modal } from '@mantine/core';
import { IconFocusCentered, IconX, IconZoomIn, IconZoomOut } from '@tabler/icons-react';
import { Button, IconButton } from '../ui';
import { Transformer } from 'markmap-lib';
import { MAP_MAX_WIDTH } from '../reader/mapWidth';
import { Markmap } from 'markmap-view';
import type { INode, IPureNode } from 'markmap-common';
import { useEffect, useMemo, useRef, useState } from 'react';
import { sanitizeMapNode } from '../reader/MapRecall';
import { expandMap, focusExpandedBranch, setImmediateMapLayout } from '../reader/mapNavigation';
import './cheatsheetMindmap.css';

function MapCanvas({ root, preview, mapRef, onError }: { root: IPureNode; preview: boolean; mapRef: React.RefObject<Markmap | null>; onError: (message: string) => void }) {
  const svgRef = useRef<SVGSVGElement>(null);
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    let active = true;
    let resizeTimer: ReturnType<typeof setTimeout>;
    let instance: Markmap;
    try { instance = new Markmap(svg, { autoFit: false, initialExpandLevel: 2, maxWidth: MAP_MAX_WIDTH, spacingHorizontal: 35, duration: 0 }); setImmediateMapLayout(instance); }
    catch (error) { onError(error instanceof Error ? error.message : 'Map initialization failed'); return; }
    mapRef.current = instance;
    const toggle = instance.toggleNode.bind(instance);
    instance.toggleNode = async (...args) => { const expanding = Boolean(args[0].payload?.fold); await toggle(...args); if (!preview && expanding) await focusExpandedBranch(instance, args[0]); };
    if (preview) instance.svg.on('.zoom', null);
    const decorate = () => {
      if (preview) return;
      for (const group of svg.querySelectorAll<SVGGElement>('g.markmap-node')) {
        const circle = group.querySelector<SVGCircleElement>(':scope > circle');
        const node = (group as SVGGElement & { __data__: INode }).__data__;
        if (!circle || !node?.children.length) continue;
        circle.setAttribute('tabindex', '0'); circle.setAttribute('role', 'button');
        circle.setAttribute('aria-expanded', String(!node.payload?.fold));
        circle.setAttribute('aria-label', `${node.payload?.fold ? 'Expand' : 'Collapse'} ${group.querySelector('foreignObject')?.textContent?.trim() || 'branch'}`);
        if (!circle.hasAttribute('data-map-keyboard')) {
          circle.setAttribute('data-map-keyboard', '');
          circle.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void instance.toggleNode((group as SVGGElement & { __data__: INode }).__data__).then(decorate).catch((error: unknown) => onError(String(error))); } });
        }
      }
    };
    const observer = new MutationObserver(decorate); observer.observe(svg, { childList: true, subtree: true });
    const fit = async () => { if (active && svg.clientWidth > 0 && svg.clientHeight > 0) await instance.fit(); };
    const resize = new ResizeObserver(() => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { void fit().catch((error: unknown) => onError(String(error))); }, 120); });
    resize.observe(svg);
    void (async () => {
      await document.fonts?.ready;
      if (!active) return;
      await instance.setData(structuredClone(root));
      if (!active) return;
      await fit(); if (!active) return; decorate(); svg.dataset.mapReady = '';
    })().catch((error: unknown) => { if (active) onError(error instanceof Error ? error.message : 'Map rendering failed'); });
    return () => { active = false; clearTimeout(resizeTimer); resize.disconnect(); observer.disconnect(); instance.destroy(); if (mapRef.current === instance) mapRef.current = null; };
  }, [root, preview, mapRef, onError]);
  return <svg ref={svgRef} className="cheatsheet-hero-svg" aria-hidden={preview || undefined} aria-label={preview ? undefined : 'Interactive mind map'} />;
}

export function CheatsheetMindmap({ courseId, title, path }: { courseId: string; title: string; path: string }) {
  const [source, setSource] = useState('');
  const [error, setError] = useState('');
  const [opened, setOpened] = useState(false);
  const previewMap = useRef<Markmap | null>(null);
  const interactiveMap = useRef<Markmap | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const controller = new AbortController(); setSource(''); setError('');
    const relative = path.slice(`cheatsheets/${courseId}/`.length);
    void fetch(`/cheatsheets/${encodeURIComponent(courseId)}/${relative}`, { signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error(`Mind map request failed (${response.status})`);
      const text = await response.text(); if (!text.trim()) throw new Error('Mind map source is empty'); setSource(text);
    }).catch((failure: unknown) => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Mind map unavailable'); });
    return () => controller.abort();
  }, [courseId, path]);
  const root = useMemo(() => source ? sanitizeMapNode(new Transformer().transform(source).root) : null, [source]);
  const run = (action: (map: Markmap) => Promise<void>) => { if (interactiveMap.current) void action(interactiveMap.current).catch((failure: unknown) => setError(String(failure))); };
  return <div className="cheatsheet-hero">
    {error && <Alert color="red" role="alert" title="Mind map unavailable">{error}. The text version remains available below.</Alert>}
    <button ref={trigger} type="button" className="cheatsheet-hero-card" aria-label={`Open ${title} mind map`} onClick={() => setOpened(true)}>
      <span className="cheatsheet-hero-label">{title} · Open mind map</span>
      {root ? <MapCanvas root={root} preview mapRef={previewMap} onError={setError} /> : <span>Loading mind map…</span>}
    </button>
    <Modal.Root opened={opened} onClose={() => setOpened(false)} returnFocus lockScroll closeOnEscape closeOnClickOutside size="100%" centered>
      <Modal.Overlay />
      <Modal.Content className="cheatsheet-map-modal">
        <Modal.Header role="presentation" className="cheatsheet-map-header"><Modal.Title>{title}</Modal.Title><IconButton variant="subtle" label="Close mind map" icon={<IconX size={20} aria-hidden="true" />} tooltipWithinPortal={false} onClick={() => setOpened(false)} /></Modal.Header>
        <Modal.Body className="cheatsheet-map-body">
          <div className="cheatsheet-map-container">
            {root && opened && <MapCanvas root={root} preview={false} mapRef={interactiveMap} onError={setError} />}
            <div className="cheatsheet-map-actions">
              <IconButton variant="secondary" label="Zoom out" title="Zoom out" icon={<IconZoomOut size={20} aria-hidden="true" />} onClick={() => run((map) => map.rescale(0.8))} />
              <IconButton variant="secondary" label="Zoom in" title="Zoom in" icon={<IconZoomIn size={20} aria-hidden="true" />} onClick={() => run((map) => map.rescale(1.25))} />
              <IconButton variant="secondary" label="Fit map" title="Fit map" icon={<IconFocusCentered size={20} aria-hidden="true" />} onClick={() => run((map) => map.fit())} />
              <Button variant="secondary" onClick={() => run(async (map) => { await expandMap(map); await map.fit(); })}>Fit all</Button>
            </div>
          </div>
        </Modal.Body>
      </Modal.Content>
    </Modal.Root>
  </div>;
}
