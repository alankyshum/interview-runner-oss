import { useMergedRef } from '@mantine/hooks';
import { forwardRef, useEffect, useRef, useState, type ComponentPropsWithoutRef, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import './components.css';

export type SplitPaneProps = Omit<ComponentPropsWithoutRef<'div'>, 'children' | 'onChange'> & { value: number; onChange: (value: number) => void; min: number; max: number; label: string; controlsId?: string; children: [ReactNode, ReactNode]; orientation?: 'horizontal' | 'vertical'; resetValue: number; valueSide?: 'first' | 'second'; visiblePane?: 'first' | 'second'; onResizeChange?: (active: boolean) => void };

/** Value is the chosen pane's percentage; horizontal panes are side by side. */
export const SplitPane = forwardRef<HTMLDivElement, SplitPaneProps>(function SplitPane({ value, onChange, min, max, label, controlsId, children, orientation = 'horizontal', resetValue, valueSide = 'first', visiblePane, onResizeChange, className, style, ...props }, ref) {
  const root = useRef<HTMLDivElement>(null);
  const cleanup = useRef<(() => void) | null>(null);
  const [active, setActive] = useState(false);
  const mergedRef = useMergedRef(root, ref);
  useEffect(() => () => cleanup.current?.(), []);
  if (![value, min, max, resetValue].every(Number.isFinite) || min < 0 || max > 100 || min > max) throw new RangeError('SplitPane expects finite percentages with 0 <= min <= max <= 100');
  const clamp = (next: number) => Math.min(max, Math.max(min, next));
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const backwards = orientation === 'horizontal' ? 'ArrowLeft' : 'ArrowUp';
    const forwards = orientation === 'horizontal' ? 'ArrowRight' : 'ArrowDown';
    if (![backwards, forwards, 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    onChange(event.key === 'Home' ? min : event.key === 'End' ? max : clamp(value + (event.key === forwards ? 1 : -1) * (valueSide === 'second' ? -1 : 1) * (event.shiftKey ? 8 : 2)));
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if ((event.button != null && event.button !== 0) || !root.current) return;
    event.preventDefault();
    const target = event.currentTarget; const pointerId = event.pointerId;
    const rect = root.current.getBoundingClientRect(); const span = orientation === 'horizontal' ? rect.width : rect.height;
    if (span <= 10) return;
    cleanup.current?.(); target.setPointerCapture?.(pointerId); setActive(true); onResizeChange?.(true);
    const move = (next: globalThis.PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      const position = orientation === 'horizontal' ? next.clientX - rect.left : next.clientY - rect.top;
      const first = (position - 5) / (span - 10) * 100;
      onChange(clamp(valueSide === 'second' ? (span - position - 5) / (span - 10) * 100 : first));
    };
    const finish = (next?: globalThis.PointerEvent) => {
      if (next && next.pointerId !== pointerId) return;
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', finish); window.removeEventListener('pointercancel', finish);
      cleanup.current = null;
      if (target.hasPointerCapture?.(pointerId)) target.releasePointerCapture(pointerId);
      setActive(false); onResizeChange?.(false);
    };
    cleanup.current = finish;
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', finish); window.addEventListener('pointercancel', finish);
  };
  const first = valueSide === 'second' ? 100 - clamp(value) : clamp(value);
  return <div {...props} ref={mergedRef} className={['ir-split', className].filter(Boolean).join(' ')} data-ir-orientation={orientation} data-ir-dragging={active || undefined} data-ir-overlap={visiblePane ? true : undefined} style={{ ...style, '--ir-split-first': `${first}fr`, '--ir-split-second': `${100 - first}fr` } as CSSProperties}>
    <div key="first" className="ir-split-pane" hidden={visiblePane === 'second'} inert={visiblePane === 'second'}>{children[0]}</div>
    {!visiblePane && <div className="ir-split-separator" role="separator" tabIndex={0} aria-label={label} aria-controls={controlsId} aria-orientation={orientation === 'horizontal' ? 'vertical' : 'horizontal'} aria-valuemin={min} aria-valuemax={max} aria-valuenow={Math.round(clamp(value))} aria-valuetext={`${Math.round(clamp(value))}%`} onKeyDown={onKeyDown} onDoubleClick={() => onChange(clamp(resetValue))} onPointerDown={onPointerDown} onLostPointerCapture={() => cleanup.current?.()} />}
    <div key="second" className="ir-split-pane" hidden={visiblePane === 'first'} inert={visiblePane === 'first'}>{children[1]}</div>
  </div>;
});
