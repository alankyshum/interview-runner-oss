import { Alert, Code, Stack, Text, useComputedColorScheme } from '@mantine/core';
import { IconButton } from '../ui';
import { Component, useEffect, useId, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import type { OutlineNode } from '../../server/outlines';
import classes from './reader.module.css';

const svgCache = new Map<string, string>();
let cacheTheme: 'light' | 'dark' | undefined;

function ensureTheme(theme: 'light' | 'dark') {
  if (cacheTheme !== theme) {
    svgCache.clear();
    cacheTheme = theme;
  }
}

type RenderState = { svg: string | null; error: Error | null; theme?: 'light' | 'dark' };

class DiagramBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

// Mermaid's SVG is authored locally alongside the outline. The app is restricted
// to loopback + tailnet, so this intentional HTML injection is the diagram output
// boundary rather than an untrusted-content renderer.
function DiagramOutput({ svg }: { svg: string }) {
  return <div className={classes.diagramViewport} dangerouslySetInnerHTML={{ __html: svg }} />;
}

function ExpandableDiagram({ svg, caption }: { svg: string; caption?: string }) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const titleId = `expanded-diagram-${useId().replace(/:/g, '')}`;
  const label = caption ? `Expand diagram: ${caption}` : 'Expand diagram';
  const title = caption || 'Expanded diagram';

  const close = () => {
    const dialog = dialogRef.current;
    if (dialog?.open && typeof dialog.close === 'function') dialog.close();
    else if (dialog) dialog.removeAttribute('open');
    setIsOpen(false);
    triggerRef.current?.focus();
  };

  const open = () => {
    const dialog = dialogRef.current;
    if (!dialog || dialog.open) return;
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    setIsOpen(true);
  };

  const handleBackdropClick = (event: MouseEvent<HTMLDialogElement>) => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close();
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={classes.diagramTrigger}
        aria-label={label}
        title="Expand diagram"
        onClick={open}
      >
        <DiagramOutput svg={svg} />
      </button>
      <dialog
        ref={dialogRef}
        className={classes.diagramDialog}
        aria-labelledby={titleId}
        aria-modal="true"
        onCancel={(event) => { event.preventDefault(); close(); }}
        onClose={() => { setIsOpen(false); triggerRef.current?.focus(); }}
        onClick={handleBackdropClick}
      >
        <div className={classes.diagramDialogHeader}>
          <h2 id={titleId} className={classes.diagramDialogTitle}>{title}</h2>
          <IconButton className={classes.diagramClose} label="Close expanded diagram" tooltipWithinPortal={false} icon={<span aria-hidden="true">×</span>} onClick={close} />
        </div>
        {isOpen ? <div className={classes.diagramDialogViewport}><DiagramOutput svg={svg} /></div> : null}
      </dialog>
    </>
  );
}

function RenderedDiagram({ node, courseId, drillId, theme }: { node: OutlineNode; courseId: string; drillId: string; theme: 'light' | 'dark' }) {
  const [renderState, setRenderState] = useState<RenderState>({ svg: null, error: null });
  const [intersecting, setIntersecting] = useState(false);
  const targetRef = useRef<HTMLDivElement>(null);
  const hash = node.hash ?? node.id;
  const cacheKey = `${courseId}/${drillId}/${hash}`;
  useEffect(() => { ensureTheme(theme); }, [theme]);

  useEffect(() => {
    const target = targetRef.current;
    if (!target) return;
    const observer = new IntersectionObserver(([entry]) => setIntersecting(Boolean(entry?.isIntersecting)), { rootMargin: '200px' });
    observer.observe(target);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!intersecting) return;
    const cached = svgCache.get(cacheKey);
    if (cached) {
      setRenderState({ svg: cached, error: null, theme });
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        // Keep Mermaid out of the initial bundle: a chapter without a visible
        // diagram must never download this dependency.
        const { default: mermaid } = await import('mermaid');
        mermaid.initialize({ startOnLoad: false, theme: theme === 'light' ? 'default' : 'dark' });
        const { svg } = await mermaid.render(`outline-diagram-${cacheKey.replace(/[^a-zA-Z0-9_-]/g, '-')}`, node.diagram!.src);
        if (cancelled) return;
        svgCache.set(cacheKey, svg);
        setRenderState({ svg, error: null, theme });
      } catch (error) {
        if (!cancelled) setRenderState({ svg: null, error: error instanceof Error ? error : new Error(String(error)), theme });
      }
    })();
    return () => { cancelled = true; };
  }, [cacheKey, intersecting, node.diagram, theme]);

  const fallback = (
    <Alert color="red" title="Diagram could not be rendered" role="alert">
      <Stack gap="xs">
        <Text size="sm">The source is shown so the chapter remains readable.</Text>
        {renderState.error && <Text size="sm">{renderState.error.message}</Text>}
        <Code block>{node.diagram!.src}</Code>
      </Stack>
    </Alert>
  );

  return (
    <div ref={targetRef} className={classes.diagramWrapper} data-testid={`diagram-${node.id}`}>
      {renderState.theme === theme && renderState.error ? fallback : null}
      {renderState.theme === theme && renderState.svg ? <DiagramBoundary fallback={fallback}><ExpandableDiagram svg={renderState.svg} caption={node.diagram?.caption} /></DiagramBoundary> : null}
      {node.diagram?.caption && <Text size="xs" c="dimmed" mt="xs">{node.diagram.caption}</Text>}
    </div>
  );
}

export function OutlineDiagram({ node, courseId = '', drillId = '' }: { node: OutlineNode; courseId?: string; drillId?: string }) {
  const theme = useComputedColorScheme('light', { getInitialValueInEffect: false });
  if (!node.diagram) return null;
  return <RenderedDiagram node={node} courseId={courseId} drillId={drillId} theme={theme} />;
}

export function clearDiagramCache() { svgCache.clear(); cacheTheme = undefined; }
