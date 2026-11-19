import { ActionIcon, Badge, Button as MantineButton, Group, Paper, Text, Title, Tooltip, type ActionIconProps, type BadgeProps, type ButtonProps as MantineButtonProps, type TooltipProps } from '@mantine/core';
import { IconChevronDown, IconChevronRight, IconClock } from '@tabler/icons-react';
import { forwardRef, useEffect, useRef, useState, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import './components.css';

export type ButtonVariant = 'primary' | 'secondary' | 'subtle' | 'accent' | 'danger';
export type ButtonProps = Omit<MantineButtonProps, 'variant' | 'size'> & Omit<ComponentPropsWithoutRef<'button'>, 'color'> & { variant?: ButtonVariant; size?: 'sm' | 'md' };
// Mantine injects aria-controls even when its closed menu is unmounted.
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant = 'primary', size = 'md', className, ...props }, ref) {
  return <MantineButton {...props} aria-controls={props['aria-haspopup'] === 'menu' && (props['aria-expanded'] === false || props['aria-expanded'] === 'false') ? undefined : props['aria-controls']} ref={ref} size={size} mih={44} variant="default" data-ir-variant={variant} className={['ir-button', className].filter(Boolean).join(' ')} />;
});

export type IconButtonProps = Omit<ActionIconProps, 'variant' | 'size' | 'children' | 'aria-label'> & Omit<ComponentPropsWithoutRef<'button'>, 'color' | 'children' | 'aria-label'> & { label: string; icon: ReactNode; variant?: Exclude<ButtonVariant, 'danger'>; tooltipPosition?: TooltipProps['position']; tooltipWithinPortal?: boolean; tooltipDisabled?: boolean };
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton({ label, icon, variant = 'secondary', tooltipPosition, tooltipWithinPortal, tooltipDisabled, className, ...props }, ref) {
  return <Tooltip label={label} disabled={tooltipDisabled} position={tooltipPosition} withinPortal={tooltipWithinPortal} events={{ hover: true, focus: true, touch: false }} transitionProps={{ duration: 0 }} zIndex="var(--ir-z-tooltip)"><ActionIcon {...props} aria-controls={props['aria-haspopup'] === 'menu' && (props['aria-expanded'] === false || props['aria-expanded'] === 'false') ? undefined : props['aria-controls']} ref={ref} size={44} aria-label={label} variant="default" data-ir-variant={variant} className={['ir-button', 'ir-icon-button', className].filter(Boolean).join(' ')}>{icon}</ActionIcon></Tooltip>;
});

export type StatusTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';
export type StatusBadgeProps = Omit<BadgeProps, 'size' | 'children'> & Omit<ComponentPropsWithoutRef<'div'>, 'color' | 'children'> & { tone?: StatusTone; size?: 'sm' | 'md' } & ({ children: string } | { children: ReactNode; 'aria-label': string });
export const StatusBadge = forwardRef<HTMLDivElement, StatusBadgeProps>(function StatusBadge({ tone = 'neutral', size = 'md', className, children, ...props }, ref) {
  return <Badge {...props} ref={ref} size={size} data-ir-tone={tone} className={['ir-status-badge', className].filter(Boolean).join(' ')}>{children}</Badge>;
});

type PanelName = { label: string; labelledBy?: never } | { label?: never; labelledBy: string };
export type PanelProps = PanelName & Omit<ComponentPropsWithoutRef<'div'>, 'role'> & { component?: 'div' | 'section' | 'aside' | 'article'; role?: 'region' | 'complementary' | 'group' | 'article'; padding?: 'none' | 'sm' | 'md'; scrollable?: boolean };
export const Panel = forwardRef<HTMLDivElement, PanelProps>(function Panel({ component = 'section', role = 'region', label, labelledBy, padding = 'md', scrollable = false, className, tabIndex, ...props }, ref) {
  return <Paper {...props} ref={ref} component={component} role={role} withBorder tabIndex={tabIndex ?? (scrollable ? 0 : undefined)} aria-label={label} aria-labelledby={labelledBy} data-ir-padding={padding} data-ir-scrollable={scrollable || undefined} className={['ir-panel', className].filter(Boolean).join(' ')} />;
});

export type PanelHeaderProps = Omit<ComponentPropsWithoutRef<'div'>, 'title'> & { title: string; headingLevel?: 2 | 3 | 4 | 5 | 6; actions?: ReactNode; toggle?: { expanded: boolean; onToggle: () => void; controlsId: string; label?: string } };
export const PanelHeader = forwardRef<HTMLDivElement, PanelHeaderProps>(function PanelHeader({ title, headingLevel = 2, actions, toggle, className, ...props }, ref) {
  return <Group {...props} ref={ref} justify="space-between" gap="xs" wrap="wrap" className={['ir-panel-header', className].filter(Boolean).join(' ')}><Title order={headingLevel}>{title}</Title><Group gap="xs" wrap="wrap">{actions}{toggle && <IconButton label={toggle.label ?? `Toggle ${title}`} aria-expanded={toggle.expanded} aria-controls={toggle.controlsId} onClick={toggle.onToggle} variant="subtle" icon={toggle.expanded ? <IconChevronDown size={16} aria-hidden="true" /> : <IconChevronRight size={16} aria-hidden="true" />} />}</Group></Group>;
});

export type EmptyStateProps = Omit<ComponentPropsWithoutRef<'div'>, 'title'> & { title: string; description?: string; action?: ReactNode; placement?: 'compact' | 'panel' };
export const EmptyState = forwardRef<HTMLDivElement, EmptyStateProps>(function EmptyState({ title, description, action, placement = 'panel', className, ...props }, ref) {
  return <div {...props} ref={ref} className={['ir-empty', className].filter(Boolean).join(' ')} data-ir-placement={placement}><Text fw={600}>{title}</Text>{description && <Text c="dimmed" size="sm">{description}</Text>}{action}</div>;
});

export type SaveStatusProps = ComponentPropsWithoutRef<'div'> & { state: 'saving' | 'saved' | 'local-only' | 'error' | 'conflict'; text: string; actions?: ReactNode };
export const SaveStatus = forwardRef<HTMLDivElement, SaveStatusProps>(function SaveStatus({ state, text, actions, className, ...props }, ref) {
  const tone: StatusTone = state === 'error' ? 'danger' : state === 'conflict' || state === 'local-only' ? 'warning' : state === 'saved' ? 'success' : 'info';
  return <div {...props} ref={ref} className={['ir-save-status', className].filter(Boolean).join(' ')}><div role="status" aria-live="polite" aria-atomic="true"><StatusBadge tone={tone}>{text}</StatusBadge></div>{actions && <Group gap="xs" wrap="wrap">{actions}</Group>}</div>;
});

export type WorkspaceHeaderProps = Omit<ComponentPropsWithoutRef<'header'>, 'title'> & { title: string; headingLevel?: 1 | 2 | 3; leading?: ReactNode; titleActions?: ReactNode; context?: ReactNode; timer?: ReactNode; actions?: ReactNode; classNames?: { identity?: string; actions?: string } };
export const WorkspaceHeader = forwardRef<HTMLElement, WorkspaceHeaderProps>(function WorkspaceHeader({ title, headingLevel = 1, leading, titleActions, context, timer, actions, className, classNames, ...props }, ref) {
  return <header {...props} ref={ref} className={['ir-workspace-header', className].filter(Boolean).join(' ')}><div className={['ir-workspace-identity', classNames?.identity].filter(Boolean).join(' ')}><div className="ir-workspace-title">{leading}<Title order={headingLevel} title={title} style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{title}</Title>{titleActions}</div>{context && <div className="ir-context">{context}</div>}</div><div className={['ir-workspace-actions', classNames?.actions].filter(Boolean).join(' ')}>{timer}{actions}</div></header>;
});

export type TimerDisplayProps = ComponentPropsWithoutRef<'div'> & { remaining: number; state: 'running' | 'paused' | 'expired'; label: string; actions?: ReactNode; announcement?: string };
export const TimerDisplay = forwardRef<HTMLDivElement, TimerDisplayProps>(function TimerDisplay({ remaining, state, label, actions, announcement: externalAnnouncement, className, ...props }, ref) {
  const valid = Number.isFinite(remaining);
  const seconds = !valid || state === 'expired' ? 0 : Math.max(0, Math.floor(remaining / 1000));
  const formatted = `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
  const milestone = seconds === 0 || state === 'expired' ? 'expired' : seconds <= 300 ? 'soon' : 'normal';
  const previous = useRef({ milestone, state });
  const [announcement, setAnnouncement] = useState('');
  useEffect(() => {
    const old = previous.current;
    if (milestone !== old.milestone && milestone === 'expired') setAnnouncement("Time's up");
    else if (milestone !== old.milestone && milestone === 'soon') setAnnouncement('Finishing soon');
    else if (state !== old.state) setAnnouncement(state === 'running' ? 'Timer started' : state === 'paused' ? 'Timer paused' : "Time's up");
    previous.current = { milestone, state };
  }, [milestone, state]);
  if (!valid) throw new RangeError('TimerDisplay expects a finite number of milliseconds');
  return <div {...props} ref={ref} className={['ir-timer', className].filter(Boolean).join(' ')}><IconClock size={18} aria-hidden="true" /><span role="img" className="ir-timer-value" data-ir-tone={milestone} aria-label={`${label}: ${milestone === 'expired' ? "Time's up, " : milestone === 'soon' ? 'Finishing soon, ' : ''}${formatted}`}><span aria-hidden="true">{milestone === 'expired' ? "Time's up · " : milestone === 'soon' ? 'Finishing soon · ' : ''}{formatted}</span></span><span className="ir-visually-hidden" role="status" aria-live="polite" aria-atomic="true">{externalAnnouncement ?? announcement}</span>{actions}</div>;
});
