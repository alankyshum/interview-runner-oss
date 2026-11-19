import { Group, Progress, Stack, Title, VisuallyHidden } from '@mantine/core';
import { Panel, StatusBadge } from '../ui';
import { useEffect, useRef } from 'react';
import type { Outline } from '../../server/outlines';
import { OutlineNodeRow } from './OutlineNodeRow';
import { ReaderSkeleton } from './ReaderSkeleton';
import { useOutlineState } from './useOutlineState';
import classes from './reader.module.css';

export function OutlineReader({
  outline,
  loading,
  chapterProgress,
  completionEnabled = true,
  onComplete,
  onProgress,
}: {
  outline?: Outline | null;
  loading?: boolean;
  chapterProgress?: { done: number; total: number };
  completionEnabled?: boolean;
  onComplete?: (complete: boolean) => void;
  onProgress?: (progress: { checked: number; total: number }) => void;
}) {
  if (loading || !outline) return <div aria-busy="true"><VisuallyHidden role="status" aria-live="polite">Loading course outline</VisuallyHidden><ReaderSkeleton /></div>;
  return <LoadedOutlineReader outline={outline} chapterProgress={chapterProgress} completionEnabled={completionEnabled} onComplete={onComplete} onProgress={onProgress} />;
}

function LoadedOutlineReader({ outline, chapterProgress, completionEnabled, onComplete, onProgress }: {
  outline: Outline;
  chapterProgress?: { done: number; total: number };
  completionEnabled: boolean;
  onComplete?: (complete: boolean) => void;
  onProgress?: (progress: { checked: number; total: number }) => void;
}) {
  const reader = useOutlineState(outline.courseId, outline.drillId, outline.nodes);
  const complete = reader.progress.total > 0 && reader.progress.checked === reader.progress.total;

  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;
  useEffect(() => { if (completionEnabled && reader.hydrated) onCompleteRef.current?.(complete); }, [complete, completionEnabled, reader.hydrated]);

  useEffect(() => {
    onProgress?.(reader.progress);
  }, [reader.progress.checked, reader.progress.total, onProgress]);

  const progressPercent = reader.progress.total
    ? Math.round((reader.progress.checked / reader.progress.total) * 100)
    : 0;

  return (
    <Stack gap="sm" className={classes.readerContainer} data-testid="outline-reader">
      <Panel label="Reading progress" padding="md" className={classes.stickyHeader}>
        <Group justify="space-between" align="center" wrap="wrap" gap="sm">
          <Title order={1} style={{ textWrap: 'balance', minWidth: 0 }}>
            {outline.title}
          </Title>
          <Group gap="xs" wrap="wrap" style={{ minWidth: 0, maxWidth: '100%' }}>
            <StatusBadge size="md" tone="info">{`${reader.progress.checked}/${reader.progress.total}`}</StatusBadge>
            {chapterProgress && chapterProgress.total > 0 && (
              <StatusBadge size="md" tone="neutral">{`Chapter ${chapterProgress.done}/${chapterProgress.total} (${Math.round((chapterProgress.done / chapterProgress.total) * 100)}%)`}</StatusBadge>
            )}
            <StatusBadge size="md" tone="info">Reading</StatusBadge>
          </Group>
        </Group>
        <Progress
          value={progressPercent}
          mt="xs"
          size="sm"
          radius="xl"
          aria-label={`Reading progress: ${progressPercent}%`}
        />
      </Panel>
      <Stack gap={0}>
        {outline.nodes.map((node) => (
          <OutlineNodeRow
            key={node.id}
            node={node}
            courseId={outline.courseId}
            drillId={outline.drillId}
            depth={0}
            folded={reader.isFolded(node.id)}
            checked={reader.isChecked(node.id)}
            onFold={() => reader.toggleFold(node.id)}
            onCheck={() => reader.toggleCheck(node.id)}
            state={reader.state}
            toggleFold={reader.toggleFold}
            toggleCheck={reader.toggleCheck}
          />
        ))}
      </Stack>
    </Stack>
  );
}
