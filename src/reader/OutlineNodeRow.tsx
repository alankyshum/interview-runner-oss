import { Checkbox, Group, Stack, Text } from '@mantine/core';
import { StatusBadge, type StatusTone } from '../ui';
import { IconChevronRight } from '@tabler/icons-react';
import type { OutlineNode, OutlineNodeType } from '../../server/outlines';
import type { ReaderNodeState } from './outlineProgress';
import classes from './reader.module.css';
import { OutlineDiagram } from './OutlineDiagram';

const TYPE_COLORS: Record<OutlineNodeType, StatusTone> = {
  claim: 'info',
  mechanism: 'info',
  framework: 'neutral',
  step: 'success',
  term: 'warning',
  boundary: 'warning',
  contrast: 'danger',
  question: 'neutral',
};

export function OutlineNodeRow({
  node,
  courseId,
  drillId,
  depth,
  folded,
  checked,
  onFold,
  onCheck,
  state,
  toggleFold,
  toggleCheck,
}: {
  node: OutlineNode;
  courseId?: string;
  drillId?: string;
  depth: number;
  folded: boolean;
  checked: boolean;
  onFold: () => void;
  onCheck: () => void;
  state: Record<string, ReaderNodeState>;
  toggleFold?: (id: string) => void;
  toggleCheck?: (id: string) => void;
}) {
  const hasChildren = Boolean(node.children?.length);
  const isLeaf = !hasChildren;
  const imageUrl = node.image && URL.canParse(node.image.src, window.location.origin) ? new URL(node.image.src, window.location.origin) : undefined;
  const imageHref = imageUrl && (imageUrl.protocol === 'http:' || imageUrl.protocol === 'https:') ? imageUrl.href : undefined;

  const handleRowClick = () => {
    if (hasChildren) {
      onFold();
    } else {
      onCheck();
    }
  };

  return (
    <Stack gap={0}>
      <div
        className={classes.nodeRow}
        onClick={handleRowClick}
        style={{
          paddingInlineStart: `calc(var(--reader-indent) * ${depth} + var(--mantine-spacing-sm))`,
        }}
        aria-expanded={hasChildren ? !folded : undefined}
        role={hasChildren ? "button" : undefined}
        tabIndex={hasChildren ? 0 : undefined}
        onKeyDown={(event) => {
          if (!hasChildren) return;
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            handleRowClick();
          }
        }}
      >
        <div className={classes.chevronWrapper}>
          {hasChildren ? (
            <IconChevronRight
              size={16}
              className={`${classes.chevron} ${!folded ? classes.chevronOpen : ''}`}
            />
          ) : (
            <span className={classes.chevronSpacer} />
          )}
        </div>

        {isLeaf ? (
          <div
            className={classes.checkboxWrapper}
            onClick={(event) => event.stopPropagation()}
          >
            <Checkbox
              aria-label={`Mark ${node.text}`}
              checked={checked}
              onChange={onCheck}
              size="sm"
            />
          </div>
        ) : (
          <span className={classes.checkboxSpacer} />
        )}

        <div className={classes.nodeContent}>
          {node.preformatted ? (
            <pre className={classes.preformatted}>{node.text}</pre>
          ) : (
            <Text
              className={`${classes.nodeText} ${checked && isLeaf ? classes.nodeTextChecked : ''}`}
            >
              {node.text}
            </Text>
          )}
          {node.term?.zh && (
            <StatusBadge size="sm" tone="warning" style={{ fontWeight: 400 }}>{node.term.zh}</StatusBadge>
          )}
        </div>
        <StatusBadge
          size="sm"
          tone={TYPE_COLORS[node.type] ?? 'neutral'}
          className={classes.badge}
        >
          {node.type}
        </StatusBadge>
      </div>
      {node.link && (
        <a
          className={classes.externalLink}
          href={node.link.href}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(event) => event.stopPropagation()}
        >
          {node.link.label}
        </a>
      )}
      {node.image && (imageHref ? <a className={classes.nodeImageLink} href={imageHref} target="_blank" rel="noopener noreferrer" aria-label={`Open image: ${node.image.alt} (opens in a new tab)`} onClick={(event) => event.stopPropagation()}><img className={classes.nodeImage} src={node.image.src} alt={node.image.alt} /></a> : <img className={classes.nodeImage} src={node.image.src} alt={node.image.alt} />)}

      {node.term && (!hasChildren || !folded) && (
        <div
          className={classes.termCallout}
          style={{
            marginInlineStart: `calc(var(--reader-indent) * ${depth} + var(--mantine-spacing-xl) + var(--mantine-spacing-md))`,
            marginInlineEnd: 'var(--mantine-spacing-sm)',
          }}
        >
          {node.term.zh && (
            <Group gap="xs" mb={4}>
              <Text size="xs" fw={600} style={{ color: 'var(--ir-color-accent)' }}>
                {node.term.en}
              </Text>
              <Text size="xs" c="dimmed">
                ({node.term.zh})
              </Text>
            </Group>
          )}
          <Text className={classes.termDefinition}>{node.term.definition}</Text>
          {(node.term.useWhen || node.term.contrast) && (
            <div className={classes.termMeta}>
              {node.term.useWhen && (
                <Text size="xs">
                  <strong>Use when:</strong> {node.term.useWhen}
                </Text>
              )}
              {node.term.contrast && (
                <Text size="xs">
                  <strong>Contrast:</strong> {node.term.contrast}
                </Text>
              )}
            </div>
          )}
        </div>
      )}

       {(isLeaf || !folded) && node.diagram && <OutlineDiagram node={node} courseId={courseId} drillId={drillId} />}

      {!folded && hasChildren && (
        <div className={classes.subtree}>
          {node.children?.map((child) => (
            <OutlineNodeRow
              key={child.id}
              node={child}
              courseId={courseId}
              drillId={drillId}
              depth={depth + 1}
              folded={state[child.id]?.folded ?? true}
              checked={state[child.id]?.checked ?? false}
              onFold={() => toggleFold?.(child.id)}
              onCheck={() => toggleCheck?.(child.id)}
              state={state}
              toggleFold={toggleFold}
              toggleCheck={toggleCheck}
            />
          ))}
        </div>
      )}
    </Stack>
  );
}
